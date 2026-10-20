import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../server/app.mjs";
const wait = async (fn, timeout = 12000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("Condition not reached before timeout");
};
test(
  "worker steers, interrupts, survives restart with one session, and never auto-posts runtime output",
  { timeout: 35000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-worker-"));
    const app = createApp({
      dataDir: join(dir, "server"),
      env: {
        ADMIN_PASSWORD: "worker-test-password",
        AGENT_SPARK_TOKEN: "worker-token",
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const logFile = join(dir, "rpc.jsonl");
    let processHandle,
      output = "";
    const start = () => {
      processHandle = spawn(process.execPath, ["agent/worker.mjs"], {
        cwd: resolve("."),
        detached: true,
        env: {
          ...process.env,
          OPENAI_API_KEY: "",
          AGENT_TOKEN: "worker-token",
          THREADWORK_URL: url,
          AGENT_DATA_DIR: join(dir, "agent"),
          CODEX_HOME: join(dir, "agent", "codex"),
          AGENT_WORKSPACE: join(dir, "agent", "workspace"),
          CODEX_BIN: resolve("tests/fixtures/fake-codex.mjs"),
          FAKE_CODEX_LOG: logFile,
          POLL_INTERVAL_MS: "80",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      processHandle.stdout.on("data", (d) => (output += d));
      processHandle.stderr.on("data", (d) => (output += d));
    };
    const kill = async () => {
      if (!processHandle) return;
      const p = processHandle;
      processHandle = null;
      process.kill(-p.pid, "SIGKILL");
      await new Promise((r) => p.once("exit", r));
    };
    const records = () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
        : [];
    try {
      const response = await fetch(url + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "worker-test-password",
        }),
      });
      const cookie = response.headers.get("set-cookie").split(";")[0];
      const call = async (path, method = "GET", body) => {
        const r = await fetch(url + "/api" + path, {
          method,
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        });
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
      };
      start();
      await wait(() => records().some((r) => r.method === "thread/start"));
      const t = await call("/threads", "POST", {
        channel_id: 1,
        title: "Worker lifecycle",
      });
      await wait(() => records().some((r) => r.method === "turn/start"));
      await call(`/threads/${t.id}/replies`, "POST", {
        body: "A mid-turn update for @spark",
      });
      await wait(() => records().some((r) => r.method === "turn/steer"));
      await call("/admin/agents/2/command", "POST", { command: "stop" });
      await wait(() => records().some((r) => r.method === "turn/interrupt"));
      assert.equal(
        (await call(`/threads/${t.id}`)).replies.length,
        1,
        "runtime output is not a reply",
      );
      await call("/admin/agents/2", "PATCH", { desired: "running" });
      await call(`/threads/${t.id}/replies`, "POST", {
        body: "Continue @spark",
      });
      await wait(
        () => records().filter((r) => r.method === "turn/start").length >= 2,
      );
      await wait(
        () =>
          JSON.parse(readFileSync(join(dir, "agent", "state.json"), "utf8"))
            .active,
      );
      await kill();
      app.locals.db
        .prepare(
          "UPDATE agents SET heartbeat_at='2000-01-01T00:00:00.000Z' WHERE user_id=2",
        )
        .run();
      start();
      await wait(() => records().some((r) => r.method === "thread/resume"));
      await wait(
        () => records().filter((r) => r.method === "turn/start").length >= 3,
      );
      assert.equal(
        records().filter((r) => r.method === "thread/start").length,
        1,
        "restart resumes instead of creating another session",
      );
      assert.equal(
        JSON.parse(readFileSync(join(dir, "agent", "state.json"), "utf8"))
          .sessionId,
        "one-persistent-session",
      );
      assert.equal(
        (await call(`/threads/${t.id}`)).replies.length,
        2,
        "even after recovery only humans posted",
      );
      const activity = await wait(async () => {
        const data = await call("/admin/agents/2/activity?limit=200");
        return data.events.some((event) => event.type === "worker/wake") &&
          data.events.some((event) => event.payload.item?.type === "reasoning")
          ? data
          : null;
      });
      assert.ok(
        activity.events.some(
          (event) => event.payload.item?.command === "echo fixture",
        ),
      );
      assert.ok(
        activity.events.some(
          (event) => event.session_id === "one-persistent-session",
        ),
      );
      assert.ok(
        !JSON.stringify(activity).includes(
          "PRIVATE_RAW_REASONING_MUST_NOT_BE_LOGGED",
        ),
      );
      assert.ok(!output.includes("PRIVATE_RAW_REASONING_MUST_NOT_BE_LOGGED"));
      assert.match(output, /threadwork.activity/);
      assert.ok(
        records()
          .filter((r) => r.method === "turn/start")
          .at(-1)
          .params.input[0].text.includes("worker restarted"),
      );
      await wait(async () => (await call("/admin/agents/2")).state === "idle");
      assert.equal(
        app.locals.db
          .prepare(
            "SELECT COUNT(*) AS n FROM notifications WHERE accepted_at IS NULL",
          )
          .get().n,
        0,
      );
    } catch (e) {
      e.message += "\nWorker output:\n" + output;
      throw e;
    } finally {
      await kill();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// These fixtures exercise transport timing without credentials or model inference.
async function workerHarness(t, options = {}) {
  const { createServer } = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "threadwork-worker-race-"));
  const app = createApp({
    dataDir: join(dir, "server"),
    env: {
      ADMIN_PASSWORD: "worker-test-password",
      AGENT_SPARK_TOKEN: "worker-token",
    },
  });
  const server = createServer((req, res) => {
    if (options.delayLog && req.url === "/api/worker/log")
      setTimeout(() => app(req, res), 200);
    else app(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const logFile = join(dir, "rpc.jsonl");
  const p = spawn(process.execPath, ["agent/worker.mjs"], {
    cwd: resolve("."),
    detached: true,
    env: {
      ...process.env,
      OPENAI_API_KEY: "",
      AGENT_TOKEN: "worker-token",
      THREADWORK_URL: url,
      AGENT_DATA_DIR: join(dir, "agent"),
      CODEX_HOME: join(dir, "agent", "codex"),
      AGENT_WORKSPACE: join(dir, "agent", "workspace"),
      CODEX_BIN: resolve("tests/fixtures/fake-codex.mjs"),
      FAKE_CODEX_LOG: logFile,
      POLL_INTERVAL_MS: "50",
      IDLE_QUEUE_CHECK_MS: String(options.queueInterval || 60000),
      ...(options.early ? { FAKE_CODEX_COMPLETE_EARLY: "1" } : {}),
      ...(options.noAuth ? { FAKE_CODEX_NO_AUTH: "1" } : {}),
      ...(options.injectFail
        ? { FAKE_CODEX_INJECT_FAIL_ONCE: join(dir, "inject-marker") }
        : {}),
      ...(options.crash
        ? { FAKE_CODEX_CRASH_ONCE: join(dir, "crash-marker") }
        : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  p.stdout.on("data", (d) => (output += d));
  p.stderr.on("data", (d) => (output += d));
  t.after(async () => {
    if (p.exitCode === null && p.signalCode === null) {
      const exited = new Promise((r) => p.once("exit", r));
      process.kill(-p.pid, "SIGKILL");
      await exited;
    }
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });
  const records = () =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").map(JSON.parse)
      : [];
  const response = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "worker-test-password",
    }),
  });
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const call = async (path, method = "GET", body) => {
    const r = await fetch(url + "/api" + path, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const disk = () =>
    JSON.parse(readFileSync(join(dir, "agent", "state.json"), "utf8"));
  await wait(() =>
    records().some(
      (r) =>
        r.method === (options.noAuth ? "account/read" : "thread/inject_items"),
    ),
  );
  return { app, p, call, records, disk, url, output: () => output };
}

test(
  "completion before turn/start response leaves the worker idle",
  { timeout: 15000 },
  async (t) => {
    const h = await workerHarness(t, { early: true });
    await h.call("/threads", "POST", {
      channel_id: 1,
      title: "Immediate completion",
    });
    await wait(() => h.records().some((r) => r.method === "turn/start"));
    await wait(
      async () =>
        (await h.call("/admin/agents/2")).state === "idle" &&
        h.disk().accepted.length > 0,
    );
    assert.equal(h.disk().active, false);
    assert.equal(
      h.records().filter((r) => r.method === "turn/start").length,
      1,
    );
  },
);

test(
  "disconnect during delivery logging retains notifications for same-session replay",
  { timeout: 20000 },
  async (t) => {
    const h = await workerHarness(t, { crash: true, delayLog: true });
    await h.call("/threads", "POST", {
      channel_id: 1,
      title: "Transport recovery",
    });
    await wait(
      () => h.records().filter((r) => r.method === "turn/start").length === 2,
    );
    await wait(
      () => h.disk().accepted.length > 0 && h.disk().pending.length === 0,
    );
    assert.equal(
      h.records().filter((r) => r.method === "thread/start").length,
      1,
    );
    assert.ok(h.records().some((r) => r.method === "thread/resume"));
    const starts = h.records().filter((r) => r.method === "turn/start");
    const batch = (r) =>
      JSON.parse(
        r.params.input[0].text
          .split(
            "Notification batch (IDs allow you to recognize replay after a crash):\n",
          )[1]
          .split("\n")[0],
      );
    assert.equal(batch(starts[0])[0].id, batch(starts[1])[0].id);
  },
);

test(
  "losing the server lease stops the runtime instead of continuing to act",
  { timeout: 15000 },
  async (t) => {
    const h = await workerHarness(t);
    await h.call("/threads", "POST", {
      channel_id: 1,
      title: "Lease ownership",
    });
    await wait(() => h.records().some((r) => r.method === "turn/start"));
    h.app.locals.db
      .prepare(
        "UPDATE agents SET instance_id='replacement-worker' WHERE user_id=2",
      )
      .run();
    await wait(() => h.p.exitCode !== null || h.p.signalCode !== null);
    assert.equal(
      h.records().filter((r) => r.method === "turn/start").length,
      1,
    );
    assert.match(h.output(), /lease|worker|instance/i);
  },
);

test(
  "device login completion racing its response clears the login UI and resumes the agent",
  { timeout: 15000 },
  async (t) => {
    const h = await workerHarness(t, { noAuth: true });
    await wait(
      async () => (await h.call("/admin/agents/2")).state === "auth_required",
    );
    assert.equal(
      h.records().filter((r) => r.method === "thread/start").length,
      0,
    );
    await h.call("/admin/agents/2/command", "POST", { command: "login" });
    await wait(() =>
      h.records().some((r) => r.method === "thread/inject_items"),
    );
    await wait(
      async () => (await h.call("/admin/agents/2")).auth_status === "chatgpt",
    );
    const agent = h.app.locals.db
      .prepare("SELECT * FROM agents WHERE user_id=2")
      .get();
    assert.equal(agent.login_url, null);
    assert.equal(agent.login_code, null);
    assert.equal(agent.login_requested, 0);
    assert.equal(
      h.records().filter((r) => r.method === "account/login/start").length,
      1,
    );
  },
);

test(
  "transient initialization failure retries the original session instead of replacing it",
  { timeout: 15000 },
  async (t) => {
    const h = await workerHarness(t, { injectFail: true });
    await wait(() => h.disk().initialized === true);
    assert.equal(
      h.records().filter((r) => r.method === "thread/start").length,
      1,
    );
    assert.equal(
      h.records().filter((r) => r.method === "thread/inject_items").length,
      2,
    );
    assert.equal(
      h.records().filter((r) => r.method === "thread/resume").length,
      1,
    );
    assert.equal(h.disk().sessionId, "one-persistent-session");
  },
);

test(
  "idle reconciliation continues a consumed batch, respects claims/preferences and cools down",
  { timeout: 20000 },
  async (t) => {
    const h = await workerHarness(t, { early: true, queueInterval: 1000 });
    await h.call("/admin/agents/2", "PATCH", { desired: "paused" });
    await wait(
      async () => (await h.call("/admin/agents/2")).state === "paused",
    );
    const jobs = [];
    for (let i = 0; i < 3; i++)
      jobs.push(
        await h.call("/threads", "POST", {
          channel_id: 1,
          title: `Batch job ${i}`,
          status_id: 2,
        }),
      );
    await h.call("/admin/agents/2/work-preferences", "PUT", {
      notify_ready_work: true,
      notify_ready_reviews: false,
    });
    // Simulate all original/submission wakes having been accepted during earlier turns.
    const consume = () =>
      h.app.locals.db
        .prepare(
          "UPDATE notifications SET accepted_at=datetime('now') WHERE user_id=2",
        )
        .run();
    consume();
    const starts = () =>
      h
        .records()
        .filter(
          (r) =>
            r.method === "turn/start" &&
            r.params.input[0].text.includes("Idle queue reconciliation"),
        );
    const asAgent = async (path, body) => {
      const r = await fetch(h.url + "/api" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer worker-token",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 200, await r.clone().text());
      return r.json();
    };
    await h.call("/admin/agents/2", "PATCH", { desired: "running" });
    for (const job of jobs) {
      const before = starts().length;
      await wait(() => starts().length > before);
      assert.ok(h.disk().nextQueueCheckAt > Date.now() - 1000);
      await asAgent(`/threads/${job.id}/claim`, {});
      const busy = starts().length;
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal(
        starts().length,
        busy,
        "an active claim prevents idle wakes",
      );
      await asAgent(`/threads/${job.id}/submit-work`, {
        summary: "Fixture completed without a human wake",
      });
      consume();
    }
    // No eligible jobs: ending a queue turn must not create an endless turn loop.
    await new Promise((r) => setTimeout(r, 1300));
    const drained = starts().length;
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(starts().length, drained);
    const extra = await h.call("/threads", "POST", {
      channel_id: 1,
      title: "Deferred job",
      status_id: 2,
    });
    consume();
    await wait(() => starts().length > drained);
    const deferred = starts().length;
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(
      starts().length,
      deferred,
      "a declined job cannot hot-loop turns",
    );
    await h.call("/admin/agents/2/work-preferences", "PUT", {
      notify_ready_work: false,
      notify_ready_reviews: false,
    });
    consume();
    const disabled = starts().length;
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(starts().length, disabled, "opt-out prevents idle work turns");
    assert.equal(
      h.app.locals.db
        .prepare("SELECT status_id FROM threads WHERE id=?")
        .get(extra.id).status_id,
      2,
    );
    assert.equal(
      h.records().filter((r) => r.method === "thread/start").length,
      1,
    );
  },
);
