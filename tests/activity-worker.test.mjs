import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRecorder,
  activitySanitizer,
  normalizeActivity,
} from "../agent/activity.mjs";

test("activity allowlist keeps summaries, excludes raw reasoning/auth/user prompts and binary secrets", () => {
  for (const method of [
    "account/login/completed",
    "item/reasoning/textDelta",
    "thread/started",
    "rawResponseItem/completed",
  ])
    assert.equal(
      normalizeActivity({ method, params: { delta: "secret" } }),
      null,
    );
  const normalized = normalizeActivity({
    method: "item/completed",
    params: {
      threadId: "session",
      turnId: "turn",
      item: {
        id: "reason",
        type: "reasoning",
        summary: ["Readable summary"],
        content: ["hidden"],
        encryptedContent: "hidden",
      },
    },
  });
  assert.deepEqual(normalized.payload.item, {
    id: "reason",
    type: "reasoning",
    summary: ["Readable summary"],
  });
  assert.equal(
    normalizeActivity({
      method: "item/started",
      params: { item: { type: "userMessage", content: ["private input"] } },
    }),
    null,
  );
  const sanitize = activitySanitizer({
    AGENT_TOKEN: "fixture-known-credential",
  });
  const output = JSON.stringify(
    sanitize({
      token: "fixture-known-credential",
      password: "foo",
      command:
        "Bearer abcdefg / fixture-known-credential / https://user:pass@host/repo",
      image: { data: "aaaa", mimeType: "image/png" },
      value: "data:image/png;base64,aaaa=",
    }),
  );
  for (const secret of [
    "fixture-known-credential",
    "abcdefg",
    "user:pass",
    "aaaa",
    '"foo"',
  ])
    assert.ok(!output.includes(secret), secret);
  assert.ok(output.includes("image/png"));
  assert.ok(
    Buffer.byteLength(
      JSON.stringify(sanitize({ output: "😀".repeat(100000) })),
    ) <= 32000,
  );
});

test("activity spool survives failed upload/restart, deduplicates acknowledged IDs, and is private", async () => {
  const root = mkdtempSync(join(tmpdir(), "activity-spool-"));
  const stdout = [];
  let calls = 0;
  const first = new ActivityRecorder({
    root,
    stdout: (event) => stdout.push(event),
    context: () => ({ session_id: "persistent" }),
    api: async () => {
      calls++;
      throw new Error("offline");
    },
    env: {},
  });
  try {
    first.record({ type: "worker/log", payload: { message: "first" } });
    const id = first.events[0].event_id;
    await first.flush();
    assert.equal(calls, 1);
    assert.equal(first.events.length, 1);
    first.stop();
    let uploaded;
    const second = new ActivityRecorder({
      root,
      stdout: () => {},
      env: {},
      api: async (path, { body }) => {
        assert.equal(path, "/worker/activity");
        uploaded = body.events;
        return { accepted: body.events.map((e) => e.event_id) };
      },
    });
    try {
      await second.flush();
      assert.equal(uploaded[0].event_id, id);
      assert.equal(uploaded[0].session_id, "persistent");
      assert.equal(second.events.length, 0);
      assert.equal(
        readFileSync(join(root, "activity-spool.json"), "utf8"),
        "[]",
      );
      assert.equal(
        statSync(join(root, "activity-spool.json")).mode & 0o777,
        0o600,
      );
      assert.equal(stdout.length, 1);
    } finally {
      second.stop();
    }
  } finally {
    first.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("activity queue bounds outages with an explicit gap and collection can be disabled", () => {
  const root = mkdtempSync(join(tmpdir(), "activity-cap-"));
  const recorder = new ActivityRecorder({
    root,
    maxBytes: 4000,
    stdout: () => {},
    env: {},
    api: async () => {
      throw new Error("offline");
    },
  });
  try {
    for (let i = 0; i < 20; i++)
      recorder.record({
        type: "worker/log",
        payload: { message: String(i).repeat(1000) },
      });
    assert.ok(recorder.events.length < 20);
    assert.ok(
      recorder.events.some((event) => event.type === "worker/activity_gap"),
    );
    recorder.stop();
    const disabled = new ActivityRecorder({
      root,
      env: { AGENT_ACTIVITY: "false" },
      api: async () => assert.fail("Disabled telemetry uploaded"),
      stdout: () => assert.fail("Disabled telemetry logged"),
    });
    disabled.record({ type: "worker/log", payload: { message: "disabled" } });
    disabled.stop();
  } finally {
    recorder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt telemetry is quarantined without affecting worker startup, disabled collection ignores it", () => {
  const root = mkdtempSync(join(tmpdir(), "activity-corrupt-"));
  writeFileSync(join(root, "activity-spool.json"), "broken JSON");
  const recorder = new ActivityRecorder({
    root,
    env: {},
    stdout: () => {},
    api: async () => ({ accepted: [] }),
  });
  try {
    assert.equal(recorder.events[0].type, "worker/activity_gap");
    assert.ok(
      readdirSync(root).some((name) =>
        name.startsWith("activity-spool.json.corrupt-"),
      ),
    );
    writeFileSync(join(root, "activity-spool.json"), "broken again");
    const disabled = new ActivityRecorder({
      root,
      env: { AGENT_ACTIVITY: "false" },
      stdout: () => assert.fail(),
      api: async () => assert.fail(),
    });
    disabled.stop();
    assert.equal(
      readFileSync(join(root, "activity-spool.json"), "utf8"),
      "broken again",
    );
  } finally {
    recorder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("split streamed credentials and nested newly-issued tokens never reach stdout or spool", () => {
  const root = mkdtempSync(join(tmpdir(), "activity-stream-"));
  const output = [];
  const credential = "known-split-credential-abcdef";
  const recorder = new ActivityRecorder({
    root,
    env: { AGENT_TOKEN: credential },
    stdout: (event) => output.push(event),
    api: async () => ({ accepted: [] }),
  });
  const context = { threadId: "session", turnId: "turn", itemId: "item" };
  try {
    recorder.notification({
      method: "item/commandExecution/outputDelta",
      params: { ...context, delta: "x".repeat(300) + credential.slice(0, 15) },
    });
    recorder.flushStreams();
    recorder.notification({
      method: "item/commandExecution/outputDelta",
      params: { ...context, delta: credential.slice(15) + "y".repeat(120) },
    });
    recorder.flushStreams();
    recorder.notification({
      method: "item/completed",
      params: {
        ...context,
        item: {
          id: "item",
          type: "mcpToolCall",
          server: "threadwork",
          tool: "fixture",
          result: {
            token: "newly-issued-value",
            login_code: "secret-device-code",
            rawContent: "hidden-raw-value",
            encryptedContent: "hidden-ciphertext",
          },
        },
      },
    });
    const captured =
      JSON.stringify(output) +
      readFileSync(join(root, "activity-spool.json"), "utf8");
    for (const secret of [
      credential,
      "known-split-",
      "newly-issued-value",
      "secret-device-code",
      "hidden-raw-value",
      "hidden-ciphertext",
    ])
      assert.ok(!captured.includes(secret), secret);
    assert.ok(captured.includes("REDACTED"));
  } finally {
    recorder.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
