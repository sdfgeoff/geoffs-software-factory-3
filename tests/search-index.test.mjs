import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, bootstrap } from "../server/db.mjs";
import { searchPlatform } from "../server/search.mjs";
import { listThreads } from "../server/thread-list.mjs";
import { replyBodyCandidates, trigramQuery } from "../server/search-index.mjs";

test("search index upgrades existing content atomically, tracks writes/deletes and preserves literal candidate results", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-search-index-")),
    path = join(dir, "db.sqlite");
  let db;
  try {
    db = openDatabase(path);
    bootstrap(db, { ADMIN_PASSWORD: "index-test-password" });
    db.exec(`DROP TRIGGER search_reply_insert; DROP TRIGGER search_reply_update; DROP TRIGGER search_reply_delete; DROP TABLE search_replies; DROP VIEW search_reply_content; DROP INDEX search_reply_recent; DROP INDEX search_event_type; PRAGMA user_version=8;
    INSERT INTO threads VALUES(1,1,'Inherited search title','opening',1,NULL,1,'2026-01-01','2026-01-01');
    INSERT INTO threads VALUES(2,1,'Other','opening',1,NULL,1,'2026-01-01','2026-01-01');`);
    const insert = db.prepare(
      "INSERT INTO replies(thread_id,author_id,body,created_at) VALUES(?,1,?,'2026-01-01')",
    );
    const bodies = [
      "prefix abc tail",
      '100%_match and "quoted"',
      "Élan élève AéB",
      "a\\bc",
      "🦊🦉🦁",
      "aa",
      "   ",
      "embedded abcxyz",
    ];
    for (let i = 0; i < 530; i++)
      insert.run((i % 2) + 1, bodies[i % bodies.length]);
    const before = db.prepare("SELECT * FROM replies").all();
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
    assert.deepEqual(db.prepare("SELECT * FROM replies").all(), before);
    for (const q of [
      "abc",
      "100%_",
      '"quoted"',
      "Éla",
      "éla",
      "AéB",
      "a\\b",
      "🦊🦉🦁",
      "aa",
      " ",
      "   ",
      "absent",
      "abcxyz",
    ]) {
      const expected = db
        .prepare(
          "SELECT id FROM replies WHERE instr(lower(body),lower(?))>0 ORDER BY created_at DESC,id LIMIT 100",
        )
        .all(q)
        .map((r) => r.id);
      assert.deepEqual(replyBodyCandidates(db, q, 100), expected, q);
      const legacy = db
        .prepare(
          "SELECT id FROM threads t WHERE title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM replies r WHERE r.thread_id=t.id AND r.body LIKE ? ESCAPE '\\') ORDER BY created_at DESC,id DESC",
        )
        .all(...Array(3).fill("%" + q.replace(/[\\%_]/g, "\\$&") + "%"))
        .map((r) => r.id);
      assert.deepEqual(
        listThreads(db, { q }).map((r) => r.id),
        legacy,
        q,
      );
    }
    db.prepare("UPDATE threads SET title='abc' WHERE id=1").run();
    for (const offset of [0, 10, 260]) {
      const expected = db
        .prepare(
          `WITH content AS (
        SELECT 'thread' AS kind,id,title,body,updated_at AS created_at FROM threads
        UNION ALL SELECT 'reply',r.id,t.title,r.body,r.created_at FROM replies r JOIN threads t ON t.id=r.thread_id
      ) SELECT kind,id FROM content WHERE instr(lower(title),'abc')>0 OR instr(lower(body),'abc')>0
      ORDER BY CASE WHEN lower(title)='abc' THEN 0 WHEN instr(lower(title),'abc')>0 THEN 1 ELSE 2 END,created_at DESC,kind,id LIMIT 31 OFFSET ?`,
        )
        .all(offset);
      const actual = searchPlatform(
        db,
        { id: 1, admin: 1 },
        { q: "abc", offset },
      ).results;
      assert.deepEqual(
        actual.map(({ kind, id }) => ({ kind, id })),
        expected.slice(0, 30).map(({ kind, id }) => ({ kind, id })),
      );
    }
    db.prepare(
      "UPDATE threads SET title='Inherited search title' WHERE id=1",
    ).run();
    db.exec(
      "BEGIN; UPDATE replies SET body='rolled back sentinel' WHERE id=2; ROLLBACK;",
    );
    assert.deepEqual(replyBodyCandidates(db, "rolled back sentinel", 10), []);
    // Inherited titles and exact IDs remain candidates, regardless of reply text.
    assert.equal(
      searchPlatform(
        db,
        { id: 1, admin: 1 },
        { q: "Inherited search title", limit: 100 },
      ).results.length,
      100,
    );
    assert.ok(
      searchPlatform(db, { id: 1, admin: 1 }, { q: "TW-2" }).results.every(
        (r) => r.thread_id === 2,
      ),
    );
    db.prepare(
      "UPDATE replies SET body='Literal TW-1 mention' WHERE id=2",
    ).run();
    assert.ok(
      searchPlatform(db, { id: 1, admin: 1 }, { q: "TW-1" }).results.some(
        (r) => r.kind === "reply" && r.id === 2 && r.thread_id === 2,
      ),
    );
    db.prepare("UPDATE replies SET body='new unique text' WHERE id=1").run();
    assert.deepEqual(replyBodyCandidates(db, "new unique", 10), [1]);
    db.prepare("DELETE FROM replies WHERE id=1").run();
    assert.deepEqual(replyBodyCandidates(db, "new unique", 10), []);
    const match = trigramQuery(db, "abc");
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT rowid FROM search_replies WHERE search_replies MATCH ?",
      )
      .all(match)
      .map((r) => r.detail)
      .join("\n");
    assert.match(plan, /VIRTUAL TABLE INDEX.*M/);
    db.exec(
      "INSERT INTO search_replies(search_replies,rank) VALUES('integrity-check',1)",
    );
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
    db.exec(
      "INSERT INTO search_replies(search_replies,rank) VALUES('integrity-check',1)",
    );
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stored NUL preserves distinct LIKE filter and instr global-search semantics, including totals", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-search-nul-"));
  const db = openDatabase(join(dir, "db.sqlite"));
  try {
    bootstrap(db, { ADMIN_PASSWORD: "nul-test-password" });
    const thread = db.prepare(
      "INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at) VALUES(1,'plain','opening',1,1,'2026-01-01','2026-01-01') RETURNING id",
    );
    const hidden = thread.get().id,
      visible = thread.get().id;
    const insert = db.prepare(
      "INSERT INTO replies(thread_id,author_id,body,created_at) VALUES(?,1,?,'2026-01-01') RETURNING id",
    );
    const hiddenReply = insert.get(hidden, "before\0needle 100%_needle").id;
    const visibleReply = insert.get(visible, "normal needle 100%_needle").id;
    for (const q of ["needle", "100%_needle", "before", "be"]) {
      const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
      const legacy = db
        .prepare(
          "SELECT DISTINCT thread_id FROM replies WHERE body LIKE ? ESCAPE '\\' ORDER BY thread_id DESC",
        )
        .all(pattern)
        .map((r) => r.thread_id);
      assert.deepEqual(
        listThreads(db, { q }).map((t) => t.id),
        legacy,
        q,
      );
      const page = listThreads(db, { q, paged: "1", limit: "1" });
      assert.equal(page.total, legacy.length, q);
      assert.deepEqual(
        page.items.map((t) => t.id),
        legacy.slice(0, 1),
        q,
      );
      assert.equal(
        Object.values(page.statusCounts).reduce((n, x) => n + x, 0),
        legacy.length,
        q,
      );
    }
    assert.deepEqual(
      listThreads(db, { q: "needle", paged: "1" }).items.map((t) => t.id),
      [visible],
    );
    assert.deepEqual(
      new Set(
        searchPlatform(db, { id: 1, admin: 1 }, { q: "needle" })
          .results.filter((r) => r.kind === "reply")
          .map((r) => r.id),
      ),
      new Set([hiddenReply, visibleReply]),
    );
    db.prepare("UPDATE replies SET body=? WHERE id=?").run(
      "needle before\0after",
      hiddenReply,
    );
    assert.equal(listThreads(db, { q: "needle", paged: "1" }).total, 2);
    assert.equal(listThreads(db, { q: "after", paged: "1" }).total, 0);
    assert.ok(
      searchPlatform(db, { id: 1, admin: 1 }, { q: "after" }).results.some(
        (r) => r.id === hiddenReply && r.kind === "reply",
      ),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
