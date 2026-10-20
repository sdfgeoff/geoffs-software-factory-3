// Isolated synthetic workload; contains no production data or credentials.
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
const count = Number(process.env.SEARCH_FIXTURE_THREADS || 10000),
  per = Number(process.env.SEARCH_FIXTURE_REPLIES || 300);
const output = resolve(process.argv[2] || "test-results/search-scale.json");
const dir = mkdtempSync(join(tmpdir(), "tw-search-scale-"));
let app, server;
const report = {
  threads: count,
  repliesPerThread: per,
  samples: 3,
  budgets: { medianMs: 500, maxMs: 1500, simultaneousBootstrapMs: 500 },
  measurements: [],
};
try {
  app = createApp({
    dataDir: dir,
    env: { ADMIN_PASSWORD: "synthetic-search-password" },
  });
  let db = app.locals.db;
  // Build a real v8 fixture first, then measure the one-time v9 upgrade.
  db.exec(`DROP TRIGGER search_reply_insert; DROP TRIGGER search_reply_update; DROP TRIGGER search_reply_delete;
    DROP TABLE search_replies; DROP VIEW search_reply_content; DROP INDEX search_reply_recent; DROP INDEX search_event_type; PRAGMA user_version=8;`);
  const start = performance.now();
  db.exec(`BEGIN;
 WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${count})
 INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at)
 SELECT 1,printf('Synthetic conversation %05d',i),'Opening build update',1,1,'2026-01-01','2026-01-01' FROM n;
 WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${per})
 INSERT INTO replies(thread_id,author_id,body,created_at)
 SELECT t.id,1,printf('Shared build update %d for conversation %d: checks completed with literal punctuation 100%%_match. %s',n.i,t.id,CASE WHEN n.i%3=0 THEN 'Additional notes about measurements and reproducible results in a shared development environment.' ELSE 'Short notes.' END),'2026-02-01' FROM threads t CROSS JOIN n;
 INSERT INTO events(id,type,actor_id,thread_id,channel_id,payload,created_at) SELECT id,'reply.created',1,thread_id,1,'{}',created_at FROM replies;
 INSERT INTO notifications(event_id,user_id) SELECT id,1 FROM events;
 UPDATE replies SET body=body || ' unique-needle-e184' WHERE id=1;
 COMMIT;`);
  report.seedMs = performance.now() - start;
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  report.beforeMigrationBytes = statSync(join(dir, "threadwork.sqlite")).size;
  app.locals.shutdown();
  const migrationStart = performance.now();
  app = createApp({
    dataDir: dir,
    env: { ADMIN_PASSWORD: "synthetic-search-password" },
  });
  report.migrationMs = performance.now() - migrationStart;
  db = app.locals.db;
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 9);
  // Validate maintained content after reopening the migrated database.
  db.prepare(
    "UPDATE replies SET body=body || ' maintained-needle-e185' WHERE id=2",
  ).run();
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  report.databaseBytes = statSync(join(dir, "threadwork.sqlite")).size;
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "synthetic-search-password",
    }),
  });
  const headers = { Cookie: login.headers.get("set-cookie").split(";")[0] };
  async function request(path) {
    const start = performance.now();
    const r = await fetch(url + path, { headers });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    return { ms: performance.now() - start, body };
  }
  for (const [name, q] of [
    ["unique", "unique-needle-e184"],
    ["common", "Shared"],
    ["absent", "absent-needle-no-match"],
    ["ID", "TW-1"],
  ]) {
    for (const kind of ["global", "threads"]) {
      const path =
        (kind === "global" ? "/api/search?" : "/api/threads?paged=1&") +
        new URLSearchParams({ q });
      const cold = await request(path);
      const times = [],
        concurrentSearch = [],
        cheap = [];
      for (let sample = 0; sample < 3; sample++) {
        times.push((await request(path)).ms);
        const search = request(path);
        await new Promise((r) => setTimeout(r, 5));
        const bootstrap = request("/api/bootstrap");
        const [result, other] = await Promise.all([search, bootstrap]);
        concurrentSearch.push(result.ms);
        cheap.push(other.ms);
      }
      const sorted = [...times].sort((a, b) => a - b);
      const row = {
        name,
        kind,
        coldMs: cold.ms,
        timesMs: times,
        medianMs: sorted[1],
        maxMs: sorted.at(-1),
        concurrentSearchMs: concurrentSearch,
        simultaneousBootstrapMs: cheap,
        results: kind === "global" ? cold.body.results.length : cold.body.total,
      };
      report.measurements.push(row);
      console.log(JSON.stringify(row));
    }
  }
  // Four simultaneous callers exercise the bounded pool, alongside a cheap request.
  const startMixed = performance.now();
  const mixed = await Promise.all([
    request("/api/search?q=Shared"),
    request("/api/search?q=unique-needle-e184"),
    request("/api/threads?paged=1&q=Shared"),
    request("/api/search?q=absent-needle-no-match"),
    request("/api/bootstrap"),
  ]);
  const maintained = await request("/api/search?q=maintained-needle-e185");
  assert.equal(maintained.body.results[0]?.reply_id, 2);
  report.maintenanceVerified = true;
  report.concurrent = {
    totalMs: performance.now() - startMixed,
    timesMs: mixed.map((x) => x.ms),
  };
  report.passed = report.measurements.every(
    (x) =>
      x.medianMs < 500 &&
      x.maxMs < 1500 &&
      Math.max(...x.simultaneousBootstrapMs) < 500,
  );
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  assert.ok(
    report.passed,
    "Search regression budget exceeded; inspect " + output,
  );
} finally {
  if (server) await new Promise((r) => server.close(r));
  app?.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
}
