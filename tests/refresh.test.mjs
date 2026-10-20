import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { createRefreshJournal } from "../server/refresh.mjs";
import { openDatabase, bootstrap } from "../server/db.mjs";

test("refresh journal is bounded, payload-free and resets across gaps and restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-refresh-")),
    db = openDatabase(join(dir, "db.sqlite"));
  try {
    bootstrap(db, { ADMIN_PASSWORD: "refresh-test-password" });
    db.exec(
      "INSERT INTO threads(id,channel_id,title,status_id,created_by,created_at,updated_at) VALUES(1,1,'one',1,1,'stamp','stamp')",
    );
    const journal = createRefreshJournal(db, 2),
      initial = journal.version();
    assert.equal(journal.changes(initial).changed, false);
    db.exec(
      `INSERT INTO events(type,actor_id,thread_id,payload,created_at) VALUES('reply.created',1,1,'{"body":"do not include content"}','stamp')`,
    );
    journal.publish();
    assert.deepEqual(journal.changes(initial).threadIds, [1]);
    assert.equal(journal.changes(initial).reset, false);
    assert.ok(
      !JSON.stringify(journal.changes(initial)).includes("do not include"),
    );
    const privateVersion = journal.version();
    db.exec(
      `INSERT INTO events(type,actor_id,payload,created_at) VALUES('notification.due',1,'{"message":"private reminder"}','stamp')`,
    );
    journal.publish({ full: false });
    assert.deepEqual(journal.changes(privateVersion).threadIds, []);
    assert.equal(journal.changes(privateVersion).reset, false);
    assert.ok(
      !JSON.stringify(journal.changes(privateVersion)).includes(
        "private reminder",
      ),
    );
    journal.publish({ full: false });
    assert.equal(journal.changes(initial).reset, true);
    assert.equal(
      createRefreshJournal(db).changes(journal.version()).reset,
      true,
    );
    const version = journal.version();
    journal.publish({
      full: false,
      threadIds: Array.from({ length: 201 }, (_, i) => i + 1),
    });
    assert.equal(journal.changes(version).reset, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync and targeted thread summaries preserve auth, filtering, failure and retry semantics", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-sync-api-")),
    app = createApp({
      dataDir: dir,
      env: { ADMIN_PASSWORD: "refresh-test-password" },
    }),
    server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    assert.equal((await fetch(base + "/sync")).status, 401);
    const login = await fetch(base + "/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "refresh-test-password",
        }),
      }),
      cookie = login.headers.get("set-cookie").split(";")[0];
    async function req(path, body, headers = {}) {
      const response = await fetch(base + path, {
        method: body ? "POST" : "GET",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, data: await response.json() };
    }
    const thread = (
      await req("/threads", {
        channel_id: 1,
        title: "Scoped thread",
        body: "Opening",
      })
    ).data;
    const version = (await req("/bootstrap")).data.sync_revision;
    assert.equal(
      (await req("/sync?since=" + encodeURIComponent(version))).data.changed,
      false,
    );
    assert.equal(
      (await req(`/threads/${thread.id}/replies`, { body: "" })).status,
      400,
    );
    assert.equal(
      (await req("/sync?since=" + encodeURIComponent(version))).data.changed,
      false,
    );
    const headers = { "Idempotency-Key": "refresh-retry" },
      body = { body: "matching-marker" };
    await req(`/threads/${thread.id}/replies`, body, headers);
    const changes = (await req("/sync?since=" + encodeURIComponent(version)))
      .data;
    assert.deepEqual(changes.threadIds, [thread.id]);
    assert.equal(changes.reset, false);
    await req(`/threads/${thread.id}/replies`, body, headers);
    assert.equal(
      (await req("/sync?since=" + encodeURIComponent(changes.version))).data
        .changed,
      false,
    );
    const match = await req(
      `/threads?ids=${thread.id}&q=matching-marker&channel=1&assignee=`,
    );
    assert.equal(match.data.length, 1);
    assert.equal(match.data[0].reply_count, 1);
    assert.deepEqual(
      (await req(`/threads?ids=${thread.id}&q=absent`)).data,
      [],
    );
    for (const ids of [
      "0",
      "1,bad",
      Array.from({ length: 201 }, (_, i) => i + 1).join(","),
    ])
      assert.equal((await req("/threads?ids=" + ids)).status, 400);
    const prior = (await req("/bootstrap")).data.sync_revision;
    await req("/notification-schedules", {
      message: "PRIVATE-CONTENT",
      when: "in one hour",
    });
    const privateHint = (await req("/sync?since=" + encodeURIComponent(prior)))
      .data;
    assert.equal(privateHint.reset, false);
    assert.deepEqual(privateHint.threadIds, []);
    assert.ok(!JSON.stringify(privateHint).includes("PRIVATE-CONTENT"));
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
