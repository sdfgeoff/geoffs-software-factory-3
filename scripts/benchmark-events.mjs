// Copies a stopped synthetic stress-test #12 fixture; input stays untouched.
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
import { randomBytes, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const [source, output] = process.argv.slice(2);
if (!source || !output)
  throw Error(
    "Usage: node scripts/benchmark-events.mjs <checkpointed synthetic fixture> <new results directory>",
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
    "Warm local sequential HTTP runs on shared hardware; not a capacity/SLA result.",
    "Same code and copied fixture in both phases; before drops only event_thread. Inbox indexes remain present.",
    "One unrecorded warm-up and five samples for each target. Timing includes body transfer and client JSON parsing.",
    "Three committed batches of 1000 short-payload event inserts, hot thread and spread threads. Cleanup excluded; not full posting API/fan-out.",
  ],
  phases: {},
};
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    median_ms: sorted[Math.floor(sorted.length / 2)],
    max_ms: sorted.at(-1),
    samples_ms: values,
  };
};
const save = () =>
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
const activitySQL =
  "SELECT e.*,u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE e.thread_id=? ORDER BY e.id DESC LIMIT 100";
let app, server, targets;
async function start() {
  app = createApp({
    dataDir: join(root, "data"),
    env: { ADMIN_PASSWORD: "synthetic-unused-password" },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
}
async function stop() {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
}
function size() {
  const db = app.locals.db;
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
  const db = app.locals.db,
    result = { api: {}, plans: {}, storage: size(), writes: {} };
  const cookie = randomBytes(32).toString("hex");
  db.prepare(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,?)",
  ).run(hash(cookie), "2030-01-01T00:00:00Z");
  const base = `http://127.0.0.1:${server.address().port}/api`;
  for (const [label, id] of Object.entries(targets)) {
    result.plans[label] = db
      .prepare("EXPLAIN QUERY PLAN " + activitySQL)
      .all(id);
    const activity = db
      .prepare(
        "SELECT id,payload FROM events WHERE thread_id=? ORDER BY id DESC LIMIT 100",
      )
      .all(id);
    const replies = db
      .prepare("SELECT id FROM replies WHERE thread_id=? ORDER BY id")
      .all(id)
      .map((row) => row.id);
    const times = [];
    let digest, bytes;
    for (let n = -1; n < 5; n++) {
      const at = performance.now(),
        response = await fetch(base + `/threads/${id}`, {
          headers: { Cookie: `tw_session=${cookie}` },
        });
      assert.equal(response.status, 200);
      const text = await response.text(),
        data = JSON.parse(text);
      if (n >= 0) times.push(performance.now() - at);
      assert.equal(data.activity.length, 100);
      assert.deepEqual(
        data.activity.map((e) => e.id),
        activity.map((e) => e.id),
      );
      assert.ok(data.activity.every((e) => e.thread_id === id));
      assert.deepEqual(
        data.activity.map((e) => e.payload),
        activity.map((e) => JSON.parse(e.payload)),
      );
      assert.deepEqual(
        data.replies.map((r) => r.id),
        replies,
      );
      bytes = Buffer.byteLength(text);
      digest = createHash("sha256").update(text).digest("hex");
    }
    result.api[label] = {
      thread_id: id,
      ...summarize(times),
      bytes,
      replies: replies.length,
      activity: activity.length,
      response_sha256: digest,
    };
  }
  const insert = db.prepare(
      "INSERT INTO events(type,actor_id,thread_id,channel_id,payload,created_at) VALUES('benchmark.write',2,?,1,'{}','stamp')",
    ),
    remove = db.prepare("DELETE FROM events WHERE id=?");
  for (const distribution of ["hot", "spread"]) {
    const times = [];
    for (let round = 0; round < 3; round++) {
      const ids = [],
        at = performance.now();
      db.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < 1000; i++)
        ids.push(
          Number(
            insert.run(
              distribution === "hot" ? 1 : 1 + (i % report.counts.threads),
            ).lastInsertRowid,
          ),
        );
      db.exec("COMMIT");
      times.push(performance.now() - at);
      db.exec("BEGIN IMMEDIATE");
      for (const id of ids) remove.run(id);
      db.exec("COMMIT");
    }
    result.writes[distribution] = summarize(times);
  }
  report.phases[name] = result;
  save();
  console.log(
    JSON.stringify({ phase: name, api: result.api, writes: result.writes }),
  );
}
try {
  await start();
  const db = app.locals.db;
  report.counts = Object.fromEntries(
    ["threads", "replies", "events", "notifications"].map((t) => [
      t,
      db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n,
    ]),
  );
  targets = {
    old: 1,
    middle: Math.ceil(report.counts.threads / 2),
    newest: report.counts.threads,
  };
  report.targets = targets;
  db.exec("DROP INDEX event_thread; PRAGMA user_version=7");
  await phase("before");
  report.pre_migration_storage = size();
  await stop();
  const at = performance.now();
  await start();
  report.migration_ms = performance.now() - at;
  report.post_migration_storage = size();
  await phase("after");
  for (const label of Object.keys(targets))
    assert.equal(
      report.phases.before.api[label].response_sha256,
      report.phases.after.api[label].response_sha256,
      "response unchanged across upgrade",
    );
  report.index_allocated_bytes =
    report.post_migration_storage.allocated_bytes -
    report.pre_migration_storage.allocated_bytes;
  save();
  await stop();
  app = null;
  console.log(
    JSON.stringify({
      complete: true,
      migration_ms: report.migration_ms,
      index_allocated_bytes: report.index_allocated_bytes,
      report: join(root, "report.json"),
    }),
  );
} finally {
  if (app && server?.listening) await stop();
}
