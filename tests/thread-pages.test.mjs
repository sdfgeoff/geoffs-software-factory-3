import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test("thread pages preserve totals, filters and tied ordering across concurrent inserts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-pages-"));
  const app = createApp({
    dataDir: dir,
    env: { ADMIN_PASSWORD: "pages-test-password" },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(url + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "pages-test-password",
      }),
    });
    const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
    const db = app.locals.db;
    const insert = db.prepare(
      "INSERT INTO threads(channel_id,title,body,status_id,assignee_id,created_by,created_at,updated_at) VALUES(1,?,'sample',?,1,1,'2026-01-01','2026-01-01')",
    );
    for (let i = 1; i <= 125; i++) insert.run(`sample ${i}`, (i % 2) + 1);
    const get = async (params = {}) => {
      const response = await fetch(
        url +
          "/api/threads?" +
          new URLSearchParams({ paged: "1", limit: "50", ...params }),
        { headers },
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    const first = await get();
    assert.equal(first.items.length, 50);
    assert.equal(first.total, 125);
    assert.equal(first.newer, null);
    assert.equal(first.statusCounts[1] + first.statusCounts[2], 125);
    insert.run("concurrent insert", 1);
    const second = await get({ before: first.older });
    assert.equal(second.total, 126);
    assert.equal(second.items[0].id, 75);
    assert.equal(
      new Set([...first.items, ...second.items].map((t) => t.id)).size,
      100,
    );
    const last = await get({ before: second.older });
    assert.equal(last.items.length, 25);
    assert.equal(last.older, null);
    const back = await get({ after: last.newer });
    assert.deepEqual(
      back.items.map((t) => t.id),
      second.items.map((t) => t.id),
    );
    const filtered = await get({ status: "2", assignee: "1", channel: "1" });
    assert.equal(filtered.total, 63);
    assert.ok(filtered.items.every((t) => t.status_id === 2));
    assert.equal((await get({ q: "no-such-title" })).total, 0);
    assert.equal(
      (await fetch(url + "/api/threads?paged=1&before=bad", { headers }))
        .status,
      400,
    );
    assert.equal(
      (await fetch(url + "/api/threads?paged=1&limit=101", { headers })).status,
      400,
    );
    const legacy = await fetch(url + "/api/threads", { headers });
    assert.ok(Array.isArray(await legacy.json()));
  } finally {
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
