import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { now } from "../server/db.mjs";

const dir = mkdtempSync(join(tmpdir(), "threadwork-search-"));
let app, server, url, adminCookie, personCookie, personId, agentId;
async function search(q, auth = adminCookie, extra = {}) {
  const response = await fetch(
    url + "/api/search?" + new URLSearchParams({ q, ...extra }),
    {
      headers: auth
        ? auth.startsWith("Bearer ")
          ? { Authorization: auth }
          : { Cookie: auth }
        : {},
    },
  );
  return { status: response.status, ...(await response.json()) };
}
before(async () => {
  app = createApp({
    dataDir: dir,
    env: {
      ADMIN_PASSWORD: "search-test-password",
      AGENT_SPARK_TOKEN: "search-agent-token",
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
  const db = app.locals.db;
  const admin = db.prepare("SELECT * FROM users WHERE username='admin'").get();
  personId = Number(
    db
      .prepare(
        "INSERT INTO users(username,name,kind,password,created_at) VALUES('alex','Needle Alex','human',?,?) RETURNING id",
      )
      .get(admin.password, now()).id,
  );
  agentId = db.prepare("SELECT id FROM users WHERE username='spark'").get().id;
  db.prepare(
    "UPDATE agents SET role='Needle engineering reviewer',login_code='credential-only-text' WHERE user_id=?",
  ).run(agentId);
  db.prepare(
    "INSERT INTO channels(name,description,created_by,archived,created_at) VALUES('needle-archive','archived description',1,1,?)",
  ).run(now());
  for (let i = 0; i < 5; i++)
    db.prepare(
      "INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at) VALUES(1,?,?,1,1,?,?)",
    ).run(
      `Needle thread ${i}`,
      i === 0 ? "A literal 100%_match and 'quotes'" : "A thread description",
      now(),
      now(),
    );
  db.prepare(
    "INSERT INTO replies(thread_id,author_id,body,created_at) VALUES(1,1,?,?)",
  ).run("prefix ".repeat(100) + "needle-reply-tail", now());
  db.prepare(
    "INSERT INTO attachments(id,reply_id,owner_id,name,mime,size,created_at) VALUES('published-reply',1,1,'needle-reply.png','image/png',1,?)",
  ).run(now());
  db.prepare(
    "INSERT INTO attachments(id,thread_id,owner_id,name,mime,size,created_at) VALUES('published-opening',1,1,'needle-opening.png','image/png',1,?)",
  ).run(now());
  db.prepare(
    "INSERT INTO attachments(id,owner_id,name,mime,size,created_at) VALUES('private-draft',?,'draft-only-secret.png','image/png',1,?)",
  ).run(personId, now());
  for (const user of [1, personId, agentId]) {
    db.prepare(
      "INSERT INTO notification_schedules(user_id,message,due_at,created_at) VALUES(?,?,?,?)",
    ).run(
      user,
      `private-reminder-owner-${user} needle`,
      "2099-01-01T00:00:00.000Z",
      now(),
    );
    const event = db
      .prepare(
        "INSERT INTO events(type,actor_id,payload,created_at) VALUES('notification.scheduled',?,?,?) RETURNING id",
      )
      .get(
        user,
        JSON.stringify({ body: `delivered-reminder-owner-${user} needle` }),
        now(),
      );
    db.prepare("INSERT INTO notifications(user_id,event_id) VALUES(?,?)").run(
      user,
      event.id,
    );
  }
  db.prepare(
    "INSERT INTO agent_logs(agent_id,level,message,created_at) VALUES(?,'info','admin-log-only-needle',?)",
  ).run(agentId, now());
  async function login(username) {
    const response = await fetch(url + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: "search-test-password" }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  }
  adminCookie = await login("admin");
  personCookie = await login("alex");
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

test("global search covers public object types across archived channels, with snippets and thread references", async () => {
  const result = await search("NEEDLE");
  assert.equal(result.status, 200);
  assert.deepEqual(
    new Set(result.results.map((r) => r.kind)),
    new Set([
      "channel",
      "thread",
      "reply",
      "attachment",
      "person",
      "reminder",
      "notification",
      "agent-log",
    ]),
  );
  assert.ok(
    result.results.find((r) => r.kind === "channel").label.includes("Archived"),
  );
  assert.equal(result.results.filter((r) => r.kind === "attachment").length, 2);
  assert.equal(
    result.results.find((r) => r.kind === "agent-log").agent_id,
    agentId,
  );
  const reply = (await search("needle-reply-tail")).results.find(
    (r) => r.kind === "reply",
  );
  assert.equal(reply.thread_id, 1);
  assert.equal(reply.reply_id, 1);
  assert.ok(reply.snippet.startsWith("…"));
  assert.ok(reply.snippet.includes("needle-reply-tail"));
  assert.ok(reply.snippet.length < 240);
  assert.ok((await search("TW-1")).results.every((r) => r.thread_id === 1));
  assert.equal((await search("general")).results[0].kind, "channel");
});

test("global search protects private reminders, drafts, credentials and admin logs for humans and agents", async () => {
  for (const [auth, id] of [
    [adminCookie, 1],
    [personCookie, personId],
    ["Bearer search-agent-token", agentId],
  ]) {
    const result = await search("needle", auth);
    const reminders = result.results.filter((r) =>
      ["reminder", "notification"].includes(r.kind),
    );
    assert.equal(reminders.length, 2);
    assert.ok(reminders.every((r) => r.snippet.includes(`owner-${id} `)));
    assert.equal(
      result.results.some((r) => r.kind === "agent-log"),
      id === 1,
    );
    assert.deepEqual((await search("credential-only-text", auth)).results, []);
    assert.deepEqual((await search("draft-only-secret", auth)).results, []);
    assert.deepEqual((await search("search-agent-token", auth)).results, []);
    assert.ok(result.results.some((r) => r.kind === "thread"));
  }
});

test("global search uses literal matching, bounded validation and deterministic pagination without notifications", async () => {
  const before = app.locals.db
    .prepare("SELECT COUNT(*) AS n FROM events")
    .get().n;
  assert.equal((await search("100%_match")).results.length, 1);
  assert.equal((await search("'quotes'")).results.length, 1);
  assert.deepEqual((await search("%not-a-wildcard%")).results, []);
  assert.deepEqual((await search("   ")).results, []);
  const all = await search("needle", adminCookie, { limit: 100 });
  let combined = [];
  for (let offset = 0; offset < all.results.length; offset += 3) {
    const page = await search("needle", adminCookie, { limit: 3, offset });
    assert.equal(page.has_more, offset + 3 < all.results.length);
    combined.push(...page.results);
  }
  assert.deepEqual(combined, all.results);
  assert.deepEqual(
    (await search("needle", adminCookie, { offset: 1000 })).results,
    [],
  );
  for (const options of [
    { limit: 101 },
    { limit: 0 },
    { offset: -1 },
    { offset: "bad" },
  ])
    assert.equal((await search("needle", adminCookie, options)).status, 400);
  assert.equal((await search("x".repeat(201))).status, 400);
  assert.equal((await search("needle", null)).status, 401);
  assert.equal(
    app.locals.db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
    before,
  );
});

test("global search finds managed repositories and branches without exposing upstream configuration", async () => {
  const db = app.locals.db;
  const repo = db
    .prepare(
      "INSERT INTO repositories(name,url,main_branch,credential_env,created_by,created_at) VALUES('Orchestration search fixture','https://private.example/hidden.git','main','SECRET_REPO_TOKEN',1,?) RETURNING *",
    )
    .get(now());
  const branch = db
    .prepare(
      "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(?,'work/search-fixture',?,'0000000000000000000000000000000000000000',?) RETURNING *",
    )
    .get(repo.id, agentId, now());
  db.prepare("INSERT INTO branch_threads VALUES(?,1)").run(branch.id);
  const result = await search(
    "Orchestration search fixture",
    "Bearer search-agent-token",
  );
  assert.ok(
    result.results.some((r) => r.kind === "repository" && r.id === repo.id),
  );
  assert.ok(
    result.results.some(
      (r) => r.kind === "branch" && r.id === branch.id && r.thread_id === 1,
    ),
  );
  assert.equal((await search("SECRET_REPO_TOKEN")).results.length, 0);
  assert.equal((await search("private.example")).results.length, 0);
});
