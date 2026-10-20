import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { now, transaction } from "../server/db.mjs";
import { pruneActivity } from "../server/activity.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-activity-")),
  sparkToken = "activity-spark-opaque-secret",
  sageToken = "activity-sage-opaque-secret",
  instance = randomUUID(),
  sageInstance = randomUUID();
let app, server, url, cookie, personCookie, spark, sage;
async function request(
  path,
  { body, who = "admin", method = body ? "POST" : "GET", lease = true } = {},
) {
  const headers = { "content-type": "application/json" };
  if (who === "admin") headers.cookie = cookie;
  if (who === "person") headers.cookie = personCookie;
  if (who === "spark" || who === "sage") {
    headers.authorization = `Bearer ${who === "spark" ? sparkToken : sageToken}`;
    if (lease)
      headers["x-worker-instance"] = who === "spark" ? instance : sageInstance;
  }
  const r = await fetch(url + "/api" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
function event(
  type = "item/completed",
  payload = { item: { type: "agentMessage", id: "message", text: "Hello" } },
  extra = {},
) {
  return {
    event_id: randomUUID(),
    session_id: "codex-persistent-session",
    turn_id: "turn-shared",
    item_id: "item-one",
    type,
    occurred_at: now(),
    payload,
    ...extra,
  };
}
const post = (events, who = "spark", lease = true) =>
  request("/worker/activity", { who, lease, body: { events } });
before(async () => {
  app = createApp({
    dataDir: dir,
    env: {
      ADMIN_PASSWORD: "activity-test-password",
      AGENT_SPARK_TOKEN: sparkToken,
      AGENT_SAGE_TOKEN: sageToken,
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "activity-test-password",
    }),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  spark = app.locals.db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  sage = app.locals.db
    .prepare("SELECT id FROM users WHERE username='sage'")
    .get().id;
  const admin = app.locals.db.prepare("SELECT * FROM users WHERE id=1").get();
  app.locals.db
    .prepare(
      "INSERT INTO users(username,name,kind,password,created_at) VALUES('viewer','Viewer','human',?,?)",
    )
    .run(admin.password, now());
  const personLogin = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "viewer",
      password: "activity-test-password",
    }),
  });
  personCookie = personLogin.headers.get("set-cookie").split(";")[0];
  for (let i = 1; i <= 3; i++)
    app.locals.db
      .prepare(
        "INSERT INTO threads(channel_id,title,status_id,created_by,created_at,updated_at) VALUES(1,?,1,1,?,?)",
      )
      .run(`Thread ${i}`, now(), now());
  for (const [who, id] of [
    ["spark", instance],
    ["sage", sageInstance],
  ])
    await request("/worker/heartbeat", {
      who,
      lease: false,
      body: { instance_id: id, state: "idle" },
    });
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
test("activity ingestion requires worker identity and current lease; administrator-only reads", async () => {
  assert.equal((await post([event()], "none")).status, 401);
  assert.equal((await post([event()], "admin")).status, 403);
  assert.equal((await post([event()], "spark", false)).status, 409);
  const old = app.locals.db
    .prepare("SELECT heartbeat_at FROM agents WHERE user_id=?")
    .get(spark).heartbeat_at;
  app.locals.db
    .prepare("UPDATE agents SET heartbeat_at=? WHERE user_id=?")
    .run("2000-01-01T00:00:00Z", spark);
  assert.equal((await post([event()])).status, 409);
  app.locals.db
    .prepare("UPDATE agents SET heartbeat_at=? WHERE user_id=?")
    .run(old, spark);
  assert.equal(
    (await request(`/admin/agents/${spark}/activity`, { who: "spark" })).status,
    403,
  );
  assert.equal(
    (await request(`/admin/threads/1/activity`, { who: "person" })).status,
    403,
  );
  const e = event(
    "worker/log",
    { level: "info", message: "Starting worker" },
    { session_id: null, turn_id: null, item_id: null },
  );
  const result = await post([e]);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.accepted, [e.event_id]);
  assert.equal(result.data.inserted, 1);
});
test("durable deduplication is scoped to authenticated agent; valid JSON limits and unsupported reasoning events reject atomically", async () => {
  const e = event();
  assert.equal((await post([e, e])).data.inserted, 1);
  assert.equal((await post([e])).data.inserted, 0);
  assert.equal((await post([e], "sage")).data.inserted, 1);
  assert.equal(
    app.locals.db
      .prepare("SELECT count(*) AS n FROM agent_activity WHERE event_id=?")
      .get(e.event_id).n,
    2,
  );
  const before = app.locals.db
    .prepare("SELECT count(*) AS n FROM agent_activity")
    .get().n;
  assert.equal(
    (
      await post([
        event(),
        event("item/reasoning/textDelta", { delta: "RAW-REASONING" }),
      ])
    ).status,
    400,
  );
  assert.equal(
    app.locals.db.prepare("SELECT count(*) AS n FROM agent_activity").get().n,
    before,
  );
  assert.equal(
    (await post(Array.from({ length: 65 }, () => event()))).status,
    400,
  );
  assert.equal(
    (await post([event("worker/log", { message: "x".repeat(33000) })])).status,
    413,
  );
});
test("server defense removes credentials, binary payloads and raw reasoning while retaining public summaries and tool output", async () => {
  const e = event("item/completed", {
    item: {
      id: "command",
      type: "commandExecution",
      command: `print ${sparkToken}`,
      aggregatedOutput:
        "api_key=visible-secret Bearer opaque-http-token sk-abcdefghijklmnopqrstuvwxyz data:image/png;base64,AAAA",
      password: "omitted",
      reasoning: "raw hidden",
    },
    account: { token: "leak" },
  });
  assert.equal((await post([e])).status, 200);
  const stored = JSON.parse(
    app.locals.db
      .prepare("SELECT payload FROM agent_activity WHERE event_id=?")
      .get(e.event_id).payload,
  );
  const encoded = JSON.stringify(stored);
  for (const secret of [
    sparkToken,
    "visible-secret",
    "opaque-http-token",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "base64,AAAA",
    "raw hidden",
    "leak",
  ])
    assert.equal(encoded.includes(secret), false, secret);
  assert.match(encoded, /redacted/);
  assert.ok(stored.item.aggregatedOutput);
  const reasoning = event("item/completed", {
    item: {
      type: "reasoning",
      id: "r",
      content: ["RAW-CONTENT"],
      summary: [
        { type: "summary_text", text: "Public summary", content: "RAW-NESTED" },
      ],
    },
  });
  await post([reasoning]);
  const text = app.locals.db
    .prepare("SELECT payload FROM agent_activity WHERE event_id=?")
    .get(reasoning.event_id).payload;
  assert.match(text, /Public summary/);
  assert.equal(text.includes("RAW-"), false);
  const tool = event("item/completed", {
    item: {
      type: "mcpToolCall",
      server: "threadwork",
      tool: "inspect",
      arguments: JSON.stringify({ password: "NESTED-PASSWORD", thread_id: 1 }),
      result: {
        raw_reasoning: "RAW-HIDDEN",
        rawContent: "RAW-HIDDEN",
        encryptedContent: "RAW-HIDDEN",
        content: [
          { type: "image", data: "BINARY-HIDDEN" },
          { type: "text", text: "Useful output" },
        ],
      },
    },
  });
  await post([tool]);
  const toolText = app.locals.db
    .prepare("SELECT payload FROM agent_activity WHERE event_id=?")
    .get(tool.event_id).payload;
  for (const value of ["RAW-HIDDEN", "BINARY-HIDDEN", "NESTED-PASSWORD"])
    assert.equal(toolText.includes(value), false);
  assert.match(toolText, /Useful output/);
});
test("ticket attribution uses direct Threadwork tool arguments and branch links, while owned wake sources remain separately labelled", async () => {
  const db = app.locals.db;
  db.prepare(
    "INSERT INTO repositories(name,url,main_branch,created_by,created_at) VALUES('Activity repo','/unused.git','main',1,?)",
  ).run(now());
  db.prepare(
    "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(1,'activity',?,?,?)",
  ).run(spark, "a".repeat(40), now());
  db.prepare("INSERT INTO branch_threads VALUES(1,1),(1,2)").run();
  const notice = db
    .prepare(
      "INSERT INTO events(type,actor_id,thread_id,channel_id,payload,created_at) VALUES('thread.updated',1,3,1,'{}',?) RETURNING id",
    )
    .get(now());
  const own = db
    .prepare(
      "INSERT INTO notifications(event_id,user_id) VALUES(?,?) RETURNING id",
    )
    .get(notice.id, spark);
  const other = db
    .prepare(
      "INSERT INTO notifications(event_id,user_id) VALUES(?,?) RETURNING id",
    )
    .get(notice.id, sage);
  const direct = event("item/completed", {
    item: {
      type: "mcpToolCall",
      server: "threadwork",
      tool: "read_thread",
      arguments: { thread_id: 1 },
    },
  });
  const elsewhere = event("item/completed", {
    item: {
      type: "mcpToolCall",
      server: "threadwork",
      tool: "read_thread",
      arguments: { thread_id: 2 },
    },
  });
  const branch = event("item/started", {
    item: {
      type: "mcpToolCall",
      server: "threadwork",
      tool: "read_branch",
      arguments: { branch_id: 1 },
    },
  });
  const foreign = event("item/completed", {
    item: {
      type: "mcpToolCall",
      server: "other-server",
      tool: "fake",
      arguments: { thread_id: 1 },
    },
  });
  const wake = event("worker/wake", {
    notification_ids: [own.id, other.id],
    delivery: "steer",
  });
  const command = event("item/completed", {
    item: { type: "commandExecution", command: "unrelated work" },
  });
  await post([direct, elsewhere, branch, foreign, wake, command]);
  const first = (await request("/admin/threads/1/activity")).data.events;
  assert.ok(first.some((e) => e.event_id === direct.event_id));
  assert.ok(first.some((e) => e.event_id === branch.event_id));
  assert.equal(
    first.some((e) =>
      [
        elsewhere.event_id,
        foreign.event_id,
        wake.event_id,
        command.event_id,
      ].includes(e.event_id),
    ),
    false,
    "same turn must not imply ticket association",
  );
  assert.equal(
    (await request("/admin/threads/3/activity")).data.events.length,
    0,
  );
  const wakes = (await request("/admin/threads/3/activity?include_wakes=true"))
    .data.events;
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].event_id, wake.event_id);
  assert.deepEqual(wakes[0].links, [{ thread_id: 3, kind: "wake" }]);
  const forged = event("worker/wake", {
    notification_ids: [other.id],
    delivery: "start",
  });
  await post([forged]);
  assert.equal(
    app.locals.db
      .prepare(
        "SELECT count(*) AS n FROM agent_activity_links l JOIN agent_activity a ON a.id=l.activity_id WHERE a.event_id=?",
      )
      .get(forged.event_id).n,
    0,
    "foreign notifications never create links",
  );
});
test("numeric cursor pagination preserves order without duplicate rows, turn filtering is exact, and deletion cannot reuse cursors", async () => {
  const items = Array.from({ length: 5 }, (_, i) =>
    event(
      "item/agentMessage/delta",
      { delta: `chunk ${i}` },
      { turn_id: "pagination-turn" },
    ),
  );
  await post(items);
  const newest = await request(
    `/admin/agents/${spark}/activity?turn_id=pagination-turn&limit=2`,
  );
  assert.equal(newest.status, 200);
  assert.equal(newest.data.has_more, true);
  assert.ok(newest.data.events[0].id > newest.data.events[1].id);
  const older = await request(
    `/admin/agents/${spark}/activity?turn_id=pagination-turn&limit=2&before=${newest.data.cursor}`,
  );
  assert.equal(older.data.events.length, 2);
  assert.ok(older.data.events.every((e) => e.id < newest.data.cursor));
  const after = await request(
    `/admin/agents/${spark}/activity?turn_id=pagination-turn&after=${older.data.events[0].id}`,
  );
  assert.equal(after.data.events.length, 2);
  assert.ok(after.data.events[0].id < after.data.events[1].id);
  assert.equal(
    (await request(`/admin/agents/${spark}/activity?after=1&before=2`)).status,
    400,
  );
  const max = app.locals.db
    .prepare("SELECT max(id) AS id FROM agent_activity")
    .get().id;
  app.locals.db.prepare("DELETE FROM agent_activity WHERE id=?").run(max);
  const next = event();
  await post([next]);
  assert.ok(
    app.locals.db
      .prepare("SELECT id FROM agent_activity WHERE event_id=?")
      .get(next.event_id).id > max,
  );
});
test("retention enforces seven days and 50000 rows per agent with cascading associations", async () => {
  const db = app.locals.db;
  const old = event("item/completed", {
    item: {
      type: "mcpToolCall",
      server: "threadwork",
      tool: "read_thread",
      arguments: { thread_id: 1 },
    },
  });
  await post([old]);
  db.prepare("UPDATE agent_activity SET created_at=? WHERE event_id=?").run(
    "2000-01-01T00:00:00.000Z",
    old.event_id,
  );
  pruneActivity(db);
  assert.equal(
    db
      .prepare("SELECT 1 FROM agent_activity WHERE event_id=?")
      .get(old.event_id),
    undefined,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS n FROM agent_activity_links l LEFT JOIN agent_activity a ON a.id=l.activity_id WHERE a.id IS NULL",
      )
      .get().n,
    0,
  );
  transaction(db, () => {
    const insert = db.prepare(
      "INSERT INTO agent_activity(agent_id,event_id,session_id,type,occurred_at,payload,created_at) VALUES(?,?,'retention','worker/log',?,'{}',?)",
    );
    for (let i = 0; i < 50002; i++)
      insert.run(spark, `retention-${i}`, now(), now());
  });
  await post([event()]);
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM agent_activity WHERE agent_id=?")
      .get(spark).n,
    50000,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM agent_activity WHERE agent_id=?")
      .get(sage).n,
    1,
    "retention does not delete another agent history",
  );
});
test("schema6 migration preserves conversations and runtime logs while creating empty activity storage", async () => {
  const { openDatabase, bootstrap } = await import("../server/db.mjs");
  const path = join(dir, "migration", "board.sqlite");
  let db = openDatabase(path);
  bootstrap(db, {
    ADMIN_PASSWORD: "migration-password",
    AGENT_SPARK_TOKEN: "migration-token",
  });
  const agent = db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  db.prepare(
    "INSERT INTO agent_logs(agent_id,level,message,created_at) VALUES(?,'info','Existing runtime log',?)",
  ).run(agent, now());
  db.prepare(
    "INSERT INTO threads(channel_id,title,status_id,created_by,created_at,updated_at) VALUES(1,'Existing discussion',1,1,?,?)",
  ).run(now(), now());
  db.exec(
    "DROP TABLE agent_activity_links;DROP TABLE agent_activity;PRAGMA user_version=6;",
  );
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.equal(
      db.prepare("SELECT message FROM agent_logs").get().message,
      "Existing runtime log",
    );
    assert.equal(
      db.prepare("SELECT title FROM threads").get().title,
      "Existing discussion",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM agent_activity").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM agent_activity_links").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
