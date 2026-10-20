import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, bootstrap } from "../server/db.mjs";

for (const version of [6, 7])
  test(`v${version} event index upgrade preserves data and latest-100 activity with interleaved threads`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-event-index-")),
      path = join(dir, "threadwork.sqlite");
    let db, app, server;
    try {
      db = openDatabase(path);
      bootstrap(db, {
        ADMIN_PASSWORD: "event-index-password",
        AGENT_SPARK_TOKEN: "event-index-agent",
      });
      db.exec(`DROP INDEX event_thread; PRAGMA user_version=${version}`);
      for (let t = 1; t <= 3; t++)
        db.prepare(
          "INSERT INTO threads(id,channel_id,title,status_id,created_by,created_at,updated_at) VALUES(?,1,?,1,1,'stamp','stamp')",
        ).run(t, `Conversation ${t}`);
      for (let i = 1; i <= 600; i++) {
        db.prepare(
          "INSERT INTO events(id,type,actor_id,thread_id,payload,created_at) VALUES(?,'sample',1,?,?,'stamp')",
        ).run(i, i % 4 ? (i % 3) + 1 : null, JSON.stringify({ sequence: i }));
      }
      for (let i = 1; i <= 36; i++)
        db.prepare(
          "INSERT INTO replies(id,thread_id,author_id,body,created_at) VALUES(?,?,1,?,'stamp')",
        ).run(i, (i % 3) + 1, `Reply ${i}`);
      db.exec(
        "INSERT INTO notifications(event_id,user_id,read_at,accepted_at) VALUES(1,1,NULL,'accepted')",
      );
      if (version === 6)
        db.exec("DROP TABLE agent_activity_links; DROP TABLE agent_activity");
      else
        db.exec(`INSERT INTO agent_activity(agent_id,event_id,type,occurred_at,payload,created_at) VALUES(2,'existing-event','sample','stamp','{}','stamp');
      INSERT INTO agent_activity_links(activity_id,thread_id,kind) VALUES(1,1,'tool')`);
      const activity =
        version === 7 ? db.prepare("SELECT * FROM agent_activity").all() : [];
      const links =
        version === 7
          ? db.prepare("SELECT * FROM agent_activity_links").all()
          : [];
      const events = db.prepare("SELECT * FROM events ORDER BY id").all(),
        notifications = db.prepare("SELECT * FROM notifications").all();
      db.close();
      db = null;
      for (let n = 0; n < 2; n++) {
        db = openDatabase(path);
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
        assert.deepEqual(
          db.prepare("SELECT * FROM events ORDER BY id").all(),
          events,
        );
        assert.deepEqual(
          db.prepare("SELECT * FROM notifications").all(),
          notifications,
        );
        assert.deepEqual(
          db.prepare("SELECT * FROM agent_activity").all(),
          activity,
        );
        assert.deepEqual(
          db.prepare("SELECT * FROM agent_activity_links").all(),
          links,
        );
        for (const t of [1, 2, 3]) {
          const plan = db
            .prepare(
              "EXPLAIN QUERY PLAN SELECT e.*,u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE e.thread_id=? ORDER BY e.id DESC LIMIT 100",
            )
            .all(t)
            .map((row) => row.detail)
            .join("\n");
          assert.match(plan, /event_thread/);
          assert.doesNotMatch(plan, /SCAN e|TEMP B-TREE/);
        }
        db.close();
        db = null;
      }
      app = createApp({
        dataDir: dir,
        env: { ADMIN_PASSWORD: "event-index-password" },
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const login = await fetch(base + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "event-index-password",
        }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get("set-cookie").split(";")[0];
      for (const t of [1, 2, 3]) {
        const response = await fetch(base + `/threads/${t}`, {
          headers: { Cookie: cookie },
        });
        assert.equal(response.status, 200);
        const data = await response.json();
        const expected = events
          .filter((e) => e.thread_id === t)
          .reverse()
          .slice(0, 100);
        assert.equal(data.activity.length, 100);
        assert.deepEqual(
          data.activity.map((e) => e.id),
          expected.map((e) => e.id),
        );
        assert.deepEqual(
          data.activity.map((e) => e.payload.sequence),
          expected.map((e) => JSON.parse(e.payload).sequence),
        );
        assert.deepEqual(
          data.replies.map((r) => r.id),
          Array.from({ length: 36 }, (_, i) => i + 1).filter(
            (i) => (i % 3) + 1 === t,
          ),
        );
      }
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
      app?.locals.shutdown();
      db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
