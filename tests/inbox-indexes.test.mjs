import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, bootstrap } from "../server/db.mjs";
import { createApp } from "../server/app.mjs";

test("v5 notification upgrade is idempotent, preserves states and supplies bounded inbox access paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-inbox-upgrade-"));
  const path = join(dir, "db.sqlite");
  let db;
  try {
    db = openDatabase(path);
    bootstrap(db, { ADMIN_PASSWORD: "migration-password" });
    db.exec(`DROP INDEX notification_latest; DROP INDEX notification_unread; PRAGMA user_version=5;
 INSERT INTO events VALUES(1,'sample',1,NULL,NULL,'{}','stamp');
 INSERT INTO notifications VALUES(1,1,1,NULL,'accepted');`);
    const before = db.prepare("SELECT * FROM notifications").all();
    db.close();
    for (let i = 0; i < 2; i++) {
      db = openDatabase(path);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 7);
      assert.deepEqual(db.prepare("SELECT * FROM notifications").all(), before);
      const latest = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT n.*,e.payload FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 200",
        )
        .all(1)
        .map((r) => r.detail)
        .join("\n");
      assert.match(latest, /notification_latest/);
      assert.doesNotMatch(latest, /TEMP B-TREE/);
      assert.match(
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL",
          )
          .all(1)
          .map((r) => r.detail)
          .join("\n"),
        /notification_unread/,
      );
      assert.match(
        db
          .prepare(
            "EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id=? AND accepted_at IS NULL ORDER BY id LIMIT 30",
          )
          .all(1)
          .map((r) => r.detail)
          .join("\n"),
        /notification_inbox/,
      );
      db.close();
      db = null;
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("indexed inbox counts track reads/unreads without accepting worker delivery or crossing recipients", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-inbox-api-"));
  const app = createApp({
    dataDir: dir,
    env: {
      ADMIN_PASSWORD: "inbox-test-password",
      AGENT_SPARK_TOKEN: "inbox-test-agent",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api`,
    db = app.locals.db;
  try {
    for (let i = 1; i <= 8; i++) {
      db.prepare(
        "INSERT INTO events(id,type,actor_id,payload,created_at) VALUES(?,'sample',1,'{}','stamp')",
      ).run(i);
      for (const user of [1, 2])
        db.prepare(
          "INSERT INTO notifications(event_id,user_id,read_at,accepted_at) VALUES(?,?,?,?)",
        ).run(i, user, i % 2 ? "read" : null, i === 1 ? "accepted" : null);
    }
    const login = await fetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "inbox-test-password",
      }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const req = async (path, body, agent = false, instance = false) => {
      const r = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
          ...(agent
            ? { Authorization: "Bearer inbox-test-agent" }
            : { Cookie: cookie }),
          ...(instance
            ? { "X-Worker-Instance": "123e4567-e89b-42d3-a456-426614174000" }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(r.status, 200);
      return r.json();
    };
    const admin = await req("/inbox"),
      agent = await req("/inbox", null, true);
    assert.deepEqual(
      admin.map((n) => n.event_id),
      [8, 7, 6, 5, 4, 3, 2, 1],
    );
    assert.ok(admin.every((n) => n.user_id === 1));
    assert.ok(agent.every((n) => n.user_id === 2));
    assert.equal((await req("/bootstrap")).unread, 4);
    await req("/inbox/read", { ids: [agent[0].id] });
    assert.equal((await req("/bootstrap")).unread, 4);
    await req("/inbox/read", { ids: [admin[0].id] });
    assert.equal((await req("/bootstrap")).unread, 3);
    db.prepare("UPDATE notifications SET read_at=NULL WHERE id=?").run(
      admin[0].id,
    );
    assert.equal((await req("/bootstrap")).unread, 4);
    await req(
      "/worker/heartbeat",
      { instance_id: "123e4567-e89b-42d3-a456-426614174000", state: "idle" },
      true,
    );
    const pending = await req("/worker/inbox", null, true, true);
    assert.equal(pending.length, 7);
    await req("/inbox/read", {}, true);
    assert.equal((await req("/bootstrap", null, true)).unread, 0);
    assert.equal((await req("/worker/inbox", null, true, true)).length, 7);
    await req("/worker/ack", { ids: [pending[0].id, admin[0].id] }, true, true);
    assert.equal((await req("/worker/inbox", null, true, true)).length, 6);
    assert.equal(
      db
        .prepare("SELECT accepted_at FROM notifications WHERE id=?")
        .get(admin[0].id).accepted_at,
      null,
    );
    assert.equal((await req("/bootstrap")).unread, 4);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
