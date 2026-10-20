// Synthetic stress-test #12 profile: 300 mixed-length replies/events per thread,
// 51 authors, one hot channel and one recipient with 10% unread notifications.
import { createApp } from "../server/app.mjs";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
const [output, amount = "10000"] = process.argv.slice(2),
  count = Number(amount);
if (
  !output ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  existsSync(resolve(output))
)
  throw Error(
    "Usage: node scripts/seed-inbox-benchmark.mjs <new fixture directory> [threads=10000]",
  );
const root = resolve(output),
  at = performance.now();
const app = createApp({ dataDir: root, env: { ADMIN_PASSWORD: randomUUID() } }),
  db = app.locals.db;
try {
  db.exec(
    "DROP INDEX notification_latest; DROP INDEX notification_unread; PRAGMA user_version=5",
  );
  const admin = db.prepare("SELECT password FROM users WHERE id=1").get();
  for (let id = 2; id <= 51; id++)
    db.prepare(
      "INSERT INTO users(id,username,name,kind,password,created_at) VALUES(?,?,?,'human',?,'2026-01-01T00:00:00.000Z')",
    ).run(id, `tester${id}`, `Synthetic reviewer ${id}`, admin.password);
  const thread = db.prepare(
    "INSERT INTO threads(id,channel_id,title,body,status_id,assignee_id,created_by,created_at,updated_at) VALUES(?,1,?,?,?,?,?,?,?)",
  );
  const reply = db.prepare(
    "INSERT INTO replies(id,thread_id,author_id,body,created_at) VALUES(?,?,?,?,?)",
  );
  const event = db.prepare(
    "INSERT INTO events(id,type,actor_id,thread_id,channel_id,payload,created_at) VALUES(?,?,?,?,1,?,?)",
  );
  const notification = db.prepare(
    "INSERT INTO notifications(event_id,user_id,read_at) VALUES(?,1,?)",
  );
  const subscription = db.prepare(
    "INSERT INTO thread_subscriptions(thread_id,user_id,subscribed) VALUES(?,?,1)",
  );
  let id = 0;
  for (let t = 1; t <= count; t++) {
    if ((t - 1) % 100 === 0) db.exec("BEGIN");
    const created = new Date(Date.UTC(2026, 0, 1) + t * 60000).toISOString(),
      title = `Scale thread ${String(t).padStart(5, "0")} release review`;
    thread.run(
      t,
      title,
      `Opening discussion ${t}. Review the build, release notes and delivery checklist.`,
      1 + (t % 5),
      2 + (t % 50),
      2 + (t % 50),
      created,
      new Date(Date.parse(created) + 300000).toISOString(),
    );
    subscription.run(t, 1);
    subscription.run(t, 2 + (t % 50));
    for (let r = 1; r <= 300; r++) {
      id++;
      const stamp = new Date(Date.parse(created) + r * 1000).toISOString();
      const body =
        `Update ${r} on thread ${t}. needle-t${String(t).padStart(5, "0")}-r${String(r).padStart(3, "0")}. ${t % 100 === 0 ? "regressiontarget " : ""}` +
        "Release build review: verify tests, inspect logs, resolve feedback and document the delivery decision. ".repeat(
          r % 20 === 0 ? 40 : r % 5 === 0 ? 10 : 2,
        );
      reply.run(id, t, 2 + ((t + r) % 50), body, stamp);
      event.run(
        id,
        "reply.created",
        2 + ((t + r) % 50),
        t,
        JSON.stringify({ title, reply_id: id, body, attachment_ids: [] }),
        stamp,
      );
      notification.run(id, id % 10 === 0 ? null : stamp);
    }
    if (t % 100 === 0 || t === count) db.exec("COMMIT");
    if (t % 1000 === 0)
      console.log(
        JSON.stringify({
          threads: t,
          replies: id,
          elapsed_ms: performance.now() - at,
        }),
      );
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const report = {
    threads: count,
    replies: id,
    events: id,
    notifications: id,
    unread: id / 10,
    authors: 51,
    seed_ms: performance.now() - at,
    db_bytes: statSync(join(root, "threadwork.sqlite")).size,
  };
  writeFileSync(join(root, "dataset.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  app.locals.shutdown();
}
