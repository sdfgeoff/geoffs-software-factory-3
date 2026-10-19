import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
const directory = mkdtempSync(join(tmpdir(), "threadwork-api-"));
const env = {
  ADMIN_PASSWORD: "test-password-12345",
  AGENT_SPARK_TOKEN: "spark-test-token-12345",
  AGENT_SAGE_TOKEN: "sage-test-token-12345",
};
let app,
  server,
  url,
  cookie,
  personCookie,
  person,
  spark,
  sage,
  channel,
  thread,
  reply,
  attachment;
before(async () => {
  app = createApp({ dataDir: directory, env });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: env.ADMIN_PASSWORD }),
  });
  cookie = r.headers.get("set-cookie").split(";")[0];
  assert.equal(r.status, 200);
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(directory, { recursive: true, force: true });
});
async function request(
  path,
  { method = "GET", body, auth = cookie, headers = {} } = {},
) {
  const response = await fetch(url + "/api" + path, {
    method,
    headers: {
      ...(auth?.startsWith("Bearer ")
        ? { Authorization: auth }
        : auth
          ? { Cookie: auth }
          : {}),
      ...(body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...headers,
    },
    body:
      body instanceof FormData
        ? body
        : body === undefined
          ? undefined
          : JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
}
test("authentication and CSRF protection", async () => {
  assert.equal((await request("/bootstrap", { auth: null })).status, 401);
  assert.equal(
    (
      await request("/channels", {
        method: "POST",
        body: { name: "blocked" },
        headers: { Origin: "http://malicious.example" },
      })
    ).status,
    403,
  );
  const b = (await request("/bootstrap")).data;
  spark = b.users.find((u) => u.username === "spark");
  sage = b.users.find((u) => u.username === "sage");
  assert.equal(b.statuses.length, 5);
  assert.equal(b.user.admin, true);
  assert.ok(!JSON.stringify(b).includes("spark-test-token"));
});
test("admin creates human accounts; humans and agents use the same board", async () => {
  const created = await request("/admin/users", {
    method: "POST",
    body: { username: "alex", name: "Alex", password: "alex-test-password" },
  });
  assert.equal(created.status, 200);
  person = created.data;
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alex", password: "alex-test-password" }),
  });
  personCookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await request("/admin/users", {
        auth: personCookie,
        method: "POST",
        body: {},
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/admin/agents/2", {
        auth: "Bearer " + env.AGENT_SPARK_TOKEN,
      })
    ).status,
    403,
  );
  channel = (
    await request("/channels", {
      method: "POST",
      body: { name: "engineering", description: "Build together" },
    })
  ).data;
  await request(`/channels/${channel.id}/subscription`, {
    auth: "Bearer " + env.AGENT_SPARK_TOKEN,
    method: "PUT",
    body: { subscribed: true },
  });
  thread = (
    await request("/threads", {
      auth: personCookie,
      method: "POST",
      body: {
        channel_id: channel.id,
        title: "A shared conversation",
        body: "Please investigate @sage",
        assignee_id: spark.id,
      },
    })
  ).data;
  assert.ok(thread.id);
  assert.equal((await request("/threads")).data[0].id, thread.id);
  assert.equal(
    (
      await request(`/threads?channel=${channel.id}`, {
        auth: "Bearer " + env.AGENT_SPARK_TOKEN,
      })
    ).data[0].id,
    thread.id,
  );
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + env.AGENT_SPARK_TOKEN })).data
      .length,
    1,
    "channel subscription + assignment deduplicate",
  );
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + env.AGENT_SAGE_TOKEN })).data
      .length,
    1,
    "mention notifies and subscribes",
  );
  assert.equal(
    (await request("/inbox", { auth: personCookie })).data.length,
    0,
    "actor does not notify self",
  );
});
test("uploads are private until posted and cannot be attached by another account", async () => {
  const form = new FormData();
  form.set(
    "file",
    new Blob(
      [
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHo0AAAAASUVORK5CYII=",
          "base64",
        ),
      ],
      { type: "image/png" },
    ),
    "diagram.png",
  );
  attachment = (
    await request("/attachments", {
      method: "POST",
      body: form,
      auth: personCookie,
    })
  ).data;
  assert.equal(attachment.mime, "image/png");
  assert.equal((await request("/attachments/" + attachment.id)).status, 403);
  assert.equal(
    (
      await request(`/threads/${thread.id}/replies`, {
        method: "POST",
        body: { body: "stolen", attachment_ids: [attachment.id] },
      })
    ).status,
    400,
  );
  reply = (
    await request(`/threads/${thread.id}/replies`, {
      auth: personCookie,
      method: "POST",
      body: { body: "A diagram for @spark", attachment_ids: [attachment.id] },
    })
  ).data;
  assert.ok(reply.id);
  const image = await fetch(url + "/api/attachments/" + attachment.id, {
    headers: { Cookie: cookie },
  });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal((await image.arrayBuffer()).byteLength, attachment.size);
  const detail = (await request(`/threads/${thread.id}`)).data;
  assert.equal(detail.replies[0].attachments[0].name, "diagram.png");
  assert.equal(
    (
      await request(`/threads/${thread.id}/replies`, {
        auth: personCookie,
        method: "POST",
        body: { attachment_ids: [attachment.id] },
      })
    ).status,
    400,
    "a posted attachment cannot be attached twice",
  );
});
test("interactions subscribe; status, assignee, edits, replies notify participants", async () => {
  const before = (await request("/inbox", { auth: personCookie })).data.length;
  const changed = await request(`/threads/${thread.id}`, {
    auth: "Bearer " + env.AGENT_SPARK_TOKEN,
    method: "PATCH",
    body: { status_id: 3 },
  });
  assert.equal(changed.data.status_id, 3);
  assert.equal(
    (await request("/inbox", { auth: personCookie })).data.length,
    before + 1,
  );
  assert.equal(
    (
      await request(`/replies/${reply.id}`, {
        auth: "Bearer " + env.AGENT_SPARK_TOKEN,
        method: "PATCH",
        body: { body: "edited" },
      })
    ).status,
    403,
  );
  const posted = await request(`/threads/${thread.id}/replies`, {
    auth: "Bearer " + env.AGENT_SPARK_TOKEN,
    method: "POST",
    body: { body: "Working on this" },
  });
  assert.ok(posted.data.id);
  await request(`/threads/${thread.id}/subscription`, {
    auth: "Bearer " + env.AGENT_SAGE_TOKEN,
    method: "PUT",
    body: { subscribed: false },
  });
  const muted = (
    await request("/inbox", { auth: "Bearer " + env.AGENT_SAGE_TOKEN })
  ).data.length;
  await request(`/threads/${thread.id}`, {
    method: "PATCH",
    body: { status_id: 4 },
  });
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + env.AGENT_SAGE_TOKEN })).data
      .length,
    muted,
  );
  await request(`/threads/${thread.id}/replies`, {
    method: "POST",
    body: { body: "An explicit @sage mention" },
  });
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + env.AGENT_SAGE_TOKEN })).data
      .length,
    muted + 1,
    "explicit mention still notifies a muted participant",
  );
});
test("mutation retries do not duplicate posts or notifications", async () => {
  const headers = { "Idempotency-Key": "reply-retry-1" };
  const input = { method: "POST", body: { body: "Exactly once" }, headers };
  const first = await request(`/threads/${thread.id}/replies`, input);
  const second = await request(`/threads/${thread.id}/replies`, input);
  assert.equal(first.data.id, second.data.id);
  const replies = (await request(`/threads/${thread.id}`)).data.replies;
  assert.equal(replies.filter((r) => r.body === "Exactly once").length, 1);
});
test("worker lease, delivery ACK and read state are separate", async () => {
  const auth = "Bearer " + env.AGENT_SPARK_TOKEN,
    instance = randomUUID();
  assert.equal((await request("/worker/inbox", { auth })).status, 409);
  assert.equal(
    (
      await request("/worker/heartbeat", {
        auth,
        method: "POST",
        body: {
          instance_id: instance,
          state: "idle",
          session_id: "persistent-session-123",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/worker/heartbeat", {
        auth,
        method: "POST",
        body: { instance_id: randomUUID(), state: "idle" },
      })
    ).status,
    409,
  );
  const headers = { "X-Worker-Instance": instance };
  let inbox = (await request("/worker/inbox", { auth, headers })).data;
  assert.ok(inbox.length);
  await request("/inbox/read", { auth, method: "POST", body: {} });
  assert.equal(
    (await request("/worker/inbox", { auth, headers })).data.length,
    inbox.length,
    "human-style read does not lose worker wake-ups",
  );
  await request("/worker/ack", {
    auth,
    headers,
    method: "POST",
    body: { ids: inbox.map((n) => n.id) },
  });
  assert.equal(
    (await request("/worker/inbox", { auth, headers })).data.length,
    0,
  );
  assert.equal(
    (await request("/admin/agents/" + spark.id)).data.session_id,
    "persistent-session-123",
  );
});
test("admin manages agent subscriptions, roles and tokens without granting agent admin access", async () => {
  const create = await request("/admin/agents", {
    method: "POST",
    body: { username: "nova", name: "Nova", role: "Review changes" },
  });
  assert.equal(create.data.token.length, 64);
  const id = create.data.user.id;
  await request(`/admin/agents/${id}/subscriptions`, {
    method: "PUT",
    body: { channel_id: channel.id, subscribed: true },
  });
  const detail = (await request(`/admin/agents/${id}`)).data;
  assert.deepEqual(detail.subscriptions, [channel.id]);
  await request(`/admin/agents/${id}`, {
    method: "PATCH",
    body: { role: "Test changes", desired: "paused" },
  });
  const token = (
    await request(`/admin/agents/${id}/command`, {
      method: "POST",
      body: { command: "rotate-token" },
    })
  ).data.token;
  assert.equal(
    (await request("/me", { auth: "Bearer " + create.data.token })).status,
    401,
  );
  assert.equal(
    (await request("/me", { auth: "Bearer " + token })).data.username,
    "nova",
  );
});
test("search includes replies and archived channels reject new threads", async () => {
  const found = (await request("/threads?q=Exactly%20once")).data;
  assert.equal(found[0].id, thread.id);
  assert.equal(
    (await request("/threads?q=%25")).data.length,
    0,
    "SQL wildcard is treated literally",
  );
  await request("/channels/" + channel.id, {
    method: "PATCH",
    body: { archived: true },
  });
  assert.equal(
    (
      await request("/threads", {
        method: "POST",
        body: { channel_id: channel.id, title: "Nope" },
      })
    ).status,
    400,
  );
  assert.equal((await request("/threads/" + thread.id)).status, 200);
});
test("SQLite retains session, attachments and thread state when reopened", async () => {
  const { openDatabase } = await import("../server/db.mjs");
  const db = openDatabase(join(directory, "threadwork.sqlite"));
  assert.equal(
    db.prepare("SELECT session_id FROM agents WHERE user_id=?").get(spark.id)
      .session_id,
    "persistent-session-123",
  );
  assert.equal(
    db.prepare("SELECT reply_id FROM attachments WHERE id=?").get(attachment.id)
      .reply_id,
    reply.id,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n > 0,
    true,
  );
  db.close();
});

test("assignments bypass muted thread updates without unmuting the thread", async () => {
  const work = (
    await request("/threads", {
      method: "POST",
      body: { channel_id: 1, title: "Assignment notifications" },
    })
  ).data;
  const auth = "Bearer " + env.AGENT_SAGE_TOKEN;
  await request(`/threads/${work.id}/subscription`, {
    auth,
    method: "PUT",
    body: { subscribed: false },
  });
  const before = (await request("/inbox", { auth })).data.length;
  assert.equal(
    (
      await request(`/threads/${work.id}`, {
        method: "PATCH",
        body: { assignee_id: sage.id },
      })
    ).status,
    200,
  );
  assert.equal((await request("/inbox", { auth })).data.length, before + 1);
  await request(`/threads/${work.id}`, {
    method: "PATCH",
    body: { status_id: 3 },
  });
  assert.equal((await request("/inbox", { auth })).data.length, before + 1);
});

test("mentions match complete usernames including a trailing hyphen", async () => {
  const agent = (
    await request("/admin/agents", {
      method: "POST",
      body: { username: "spark-", name: "Other Spark", role: "Review" },
    })
  ).data;
  const before = (
    await request("/inbox", { auth: "Bearer " + env.AGENT_SPARK_TOKEN })
  ).data.length;
  const work = await request("/threads", {
    method: "POST",
    body: { channel_id: 1, title: "A mention for @spark-" },
  });
  assert.equal(work.status, 200);
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + agent.token })).data.length,
    1,
  );
  assert.equal(
    (await request("/inbox", { auth: "Bearer " + env.AGENT_SPARK_TOKEN })).data
      .length,
    before + 1,
    "Spark receives only its channel subscription notification, without being subscribed as a mention",
  );
  const subscription = app.locals.db
    .prepare(
      "SELECT 1 FROM thread_subscriptions WHERE thread_id=? AND user_id=?",
    )
    .get(work.data.id, spark.id);
  assert.equal(subscription, undefined);
});

test("reply edits subscribe the editing administrator and advance thread activity", async () => {
  const work = (
    await request("/threads", {
      auth: personCookie,
      method: "POST",
      body: { channel_id: 1, title: "Editable conversation" },
    })
  ).data;
  const comment = (
    await request(`/threads/${work.id}/replies`, {
      auth: personCookie,
      method: "POST",
      body: { body: "Original" },
    })
  ).data;
  assert.equal(
    (
      await request(`/replies/${comment.id}`, {
        method: "PATCH",
        body: { body: "Corrected by admin" },
      })
    ).status,
    200,
  );
  const sub = app.locals.db
    .prepare(
      "SELECT subscribed FROM thread_subscriptions WHERE thread_id=? AND user_id=?",
    )
    .get(work.id, 1);
  assert.equal(sub.subscribed, 1);
  const before = (await request("/inbox")).data.length;
  await request(`/threads/${work.id}/replies`, {
    auth: personCookie,
    method: "POST",
    body: { body: "Follow-up" },
  });
  assert.equal((await request("/inbox")).data.length, before + 1);
});

test("credential operations never persist plaintext tokens in idempotency caches", async () => {
  const headers = { "Idempotency-Key": "secret-create" };
  const created = await request("/admin/agents", {
    method: "POST",
    headers,
    body: { username: "secret-agent", name: "Secret", role: "Review" },
  });
  assert.equal(created.status, 400);
  assert.equal(
    app.locals.db
      .prepare("SELECT 1 FROM users WHERE username='secret-agent'")
      .get(),
    undefined,
  );
  const rotated = await request(`/admin/agents/${spark.id}/command`, {
    method: "POST",
    headers,
    body: { command: "rotate-token" },
  });
  assert.equal(rotated.status, 400);
  assert.equal(
    (await request("/me", { auth: "Bearer " + env.AGENT_SPARK_TOKEN })).status,
    200,
    "rejected credential mutation rolls back token rotation",
  );
  assert.equal(
    app.locals.db
      .prepare("SELECT 1 FROM mutations WHERE key LIKE '%secret-create%'")
      .get(),
    undefined,
  );
});

test("attachment uploads reject extra form fields and MIME spoofing", async () => {
  const extra = new FormData();
  extra.set("file", new Blob(["notes"]), "notes.txt");
  extra.set("unexpected", "field");
  assert.equal(
    (await request("/attachments", { method: "POST", body: extra })).status,
    400,
  );
  const spoof = new FormData();
  spoof.set(
    "file",
    new Blob(["<script>alert(1)</script>"], { type: "image/png" }),
    "spoof.png",
  );
  const uploaded = await request("/attachments", {
    method: "POST",
    body: spoof,
  });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.data.mime, "application/octet-stream");
  const response = await fetch(url + "/api/attachments/" + uploaded.data.id, {
    headers: { Cookie: cookie },
  });
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  await response.arrayBuffer();
});

test("agent login codes and worker control fields are restricted to administrators", async () => {
  const current = app.locals.db
    .prepare("SELECT instance_id FROM agents WHERE user_id=?")
    .get(spark.id);
  const heartbeat = await request("/worker/heartbeat", {
    auth: "Bearer " + env.AGENT_SPARK_TOKEN,
    method: "POST",
    body: {
      instance_id: current.instance_id,
      state: "auth_required",
      login_url: "https://auth.openai.com/codex/device",
      login_code: "private-device-code",
    },
  });
  assert.equal(heartbeat.status, 200);
  const overview = (await request("/bootstrap", { auth: personCookie })).data;
  const agent = overview.agents.find((a) => a.user_id === spark.id);
  for (const key of [
    "login_code",
    "login_url",
    "login_requested",
    "instance_id",
    "stop_version",
  ])
    assert.equal(key in agent, false, key + " must remain private");
  assert.equal(
    (await request(`/admin/agents/${spark.id}`)).data.login_code,
    "private-device-code",
  );
});
