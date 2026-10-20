// Run against a stopped/checkpointed synthetic fixture from stress-test #12.
// The input database is copied; all experimental writes/index drops use the copy.
import { createApp } from "../server/app.mjs";
import { hash } from "../server/db.mjs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw Error(
    "Usage: node scripts/benchmark-inbox.mjs <checkpointed synthetic data directory> <new output directory>",
  );
const root = resolve(output),
  input = join(resolve(source), "threadwork.sqlite");
if (existsSync(root)) throw Error("Output directory must be new");
if (existsSync(input + "-wal") && statSync(input + "-wal").size)
  throw Error("Stop/checkpoint the source fixture first");
mkdirSync(join(root, "data"), { recursive: true });
copyFileSync(input, join(root, "data", "threadwork.sqlite"));
const report = {
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  notes: [
    "Warm local synthetic measurements, not a production SLA.",
    "Before/after share the same current application code and copied dataset; before drops only the two new indexes.",
    "One unrecorded warm-up per API. Five measured sequential requests per endpoint.",
    "Write timings include committed event+notification batches; cleanup is excluded. Three batches of 1000.",
  ],
  phases: {},
};
const save = () =>
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    max_ms: sorted.at(-1),
    samples_ms: values,
  };
};
const inboxSQL = `SELECT n.*,e.type,e.actor_id,e.thread_id,e.channel_id,e.payload,e.created_at,u.name AS actor_name,u.username AS actor_username,c.name AS channel_name FROM notifications n JOIN events e ON e.id=n.event_id JOIN users u ON u.id=e.actor_id LEFT JOIN channels c ON c.id=e.channel_id WHERE n.user_id=? ORDER BY n.id DESC LIMIT 200`;
let app, server;
async function start() {
  app = createApp({
    dataDir: join(root, "data"),
    env: { ADMIN_PASSWORD: randomUUID() },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
}
async function stop() {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
}
function size(db) {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pages = db.prepare("PRAGMA page_count").get().page_count,
    free = db.prepare("PRAGMA freelist_count").get().freelist_count,
    bytes = db.prepare("PRAGMA page_size").get().page_size;
  return {
    file_bytes: statSync(join(root, "data", "threadwork.sqlite")).size,
    allocated_bytes: (pages - free) * bytes,
    free_pages: free,
    page_size: bytes,
  };
}
async function phase(name) {
  const db = app.locals.db;
  const result = {
    storage: size(db),
    plans: {
      inbox: db.prepare("EXPLAIN QUERY PLAN " + inboxSQL).all(1),
      unread: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM notifications WHERE user_id=? AND read_at IS NULL",
        )
        .all(1),
      worker: db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT * FROM notifications WHERE user_id=? AND accepted_at IS NULL ORDER BY id LIMIT 30",
        )
        .all(1),
    },
    api: {},
  };
  const cookies = new Map();
  for (const id of [1, 2]) {
    const value = randomUUID().replaceAll("-", "");
    db.prepare(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
    ).run(hash(value), id, "2030-01-01T00:00:00Z");
    cookies.set(id, value);
  }
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const path of ["/inbox", "/bootstrap"]) {
    const times = [];
    let body;
    for (let i = -1; i < 5; i++) {
      const at = performance.now(),
        r = await fetch(base + path, {
          headers: { Cookie: `tw_session=${cookies.get(1)}` },
        });
      assert.equal(r.status, 200);
      const text = await r.text();
      body = JSON.parse(text);
      if (i >= 0) times.push(performance.now() - at);
      result.api[path] = {
        ...summarize(times),
        bytes: Buffer.byteLength(text),
      };
    }
    if (path === "/inbox") {
      assert.equal(body.length, 200);
      assert.ok(body.every((n) => n.user_id === 1));
      for (let i = 1; i < body.length; i++)
        assert.ok(body[i - 1].id > body[i].id);
    } else
      assert.equal(
        body.unread,
        db
          .prepare(
            "SELECT COUNT(*) n FROM notifications WHERE user_id=1 AND read_at IS NULL",
          )
          .get().n,
      );
  }
  const other = await fetch(base + "/inbox", {
    headers: { Cookie: `tw_session=${cookies.get(2)}` },
  });
  assert.equal(other.status, 200);
  const rows = await other.json();
  assert.ok(rows.every((n) => n.user_id === 2));
  result.other_recipient = {
    status: other.status,
    rows: rows.length,
    isolated: true,
  };
  const writes = [],
    event = db.prepare(
      "INSERT INTO events(type,actor_id,thread_id,channel_id,payload,created_at) VALUES('benchmark.write',2,1,1,'{}','stamp')",
    ),
    notification = db.prepare(
      "INSERT INTO notifications(event_id,user_id,read_at) VALUES(?,1,?)",
    );
  for (let round = 0; round < 3; round++) {
    const ids = [];
    const at = performance.now();
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < 1000; i++) {
      const id = Number(event.run().lastInsertRowid);
      ids.push(id);
      notification.run(id, i % 10 ? "stamp" : null);
    }
    db.exec("COMMIT");
    writes.push(performance.now() - at);
    db.exec("BEGIN IMMEDIATE");
    for (const id of ids) {
      db.prepare("DELETE FROM notifications WHERE event_id=?").run(id);
      db.prepare("DELETE FROM events WHERE id=?").run(id);
    }
    db.exec("COMMIT");
  }
  result.committed_1000_event_notification_pairs = summarize(writes);
  const unreadIds = db
    .prepare(
      "SELECT id FROM notifications WHERE user_id=1 AND read_at IS NULL LIMIT 1000",
    )
    .all()
    .map((row) => row.id);
  result.read_state_rows = unreadIds.length;
  const mark = [],
    restore = [];
  for (let round = 0; round < 3; round++) {
    for (const [value, times] of [
      ["benchmark-read", mark],
      [null, restore],
    ]) {
      const at = performance.now();
      db.exec("BEGIN IMMEDIATE");
      for (const id of unreadIds)
        db.prepare(
          "UPDATE notifications SET read_at=? WHERE id=? AND user_id=1",
        ).run(value, id);
      db.exec("COMMIT");
      times.push(performance.now() - at);
    }
  }
  result.mark_1000_read = summarize(mark);
  result.restore_1000_unread = summarize(restore);
  result.indexes = db
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='notifications'",
    )
    .all();
  report.phases[name] = result;
  save();
  console.log(
    JSON.stringify({
      phase: name,
      api: result.api,
      storage: result.storage,
      writes: result.committed_1000_event_notification_pairs,
      mark_read: result.mark_1000_read,
      restore_unread: result.restore_1000_unread,
    }),
  );
}
try {
  await start();
  let db = app.locals.db;
  // A second recipient has its own small inbox to exercise full-API isolation.
  for (let id = 1; id <= 30; id++)
    db.prepare(
      "INSERT OR IGNORE INTO notifications(event_id,user_id) VALUES(?,2)",
    ).run(id);
  report.heavy_recipient = db
    .prepare(
      "SELECT COUNT(*) notifications,SUM(read_at IS NULL) unread FROM notifications WHERE user_id=1",
    )
    .get();
  report.counts = Object.fromEntries(
    ["threads", "replies", "events", "notifications"].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,
    ]),
  );
  db.exec(
    "DROP INDEX notification_latest; DROP INDEX notification_unread; PRAGMA user_version=5;",
  );
  await phase("before");
  report.pre_migration_storage = size(db);
  await stop();
  const at = performance.now();
  await start();
  report.migration_ms = performance.now() - at;
  report.post_migration_storage = size(app.locals.db);
  await phase("after");
  report.index_allocated_bytes =
    report.post_migration_storage.allocated_bytes -
    report.pre_migration_storage.allocated_bytes;
  save();
  await stop();
  app = null;
  console.log(
    JSON.stringify({
      complete: true,
      report: join(root, "report.json"),
      migration_ms: report.migration_ms,
      index_allocated_bytes: report.index_allocated_bytes,
    }),
  );
} finally {
  if (app && server?.listening) await stop();
}
