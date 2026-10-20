import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { openDatabase, bootstrap } from "../server/db.mjs";
import { parseSchedule, deliverSchedules } from "../server/schedules.mjs";

test("schedule grammar is explicit, validates dates and uses fixed intervals", () => {
  const clock = Date.parse("2026-01-01T00:00:00Z");
  assert.deepEqual(parseSchedule("in one hour", "every 2 days", clock), {
    due_at: "2026-01-01T01:00:00.000Z",
    interval_ms: 172800000,
  });
  assert.equal(
    parseSchedule("2027-01-01T09:00:00+02:00", undefined, clock).due_at,
    "2027-01-01T07:00:00.000Z",
  );
  for (const when of [
    "yesterday",
    "2026-01-01T00:00:00Z",
    "2027-02-30T10:00:00Z",
    "2027-01-01T10:00:00",
    "in 0 seconds",
    "in 1.5 hours",
    "in 999999999999999999 weeks",
  ])
    assert.throws(() => parseSchedule(when, undefined, clock));
  assert.throws(() => parseSchedule("in one hour", "every 0 seconds", clock));
});

test("schedule migration upgrades schema 2 and preserves opening attachments and reminders", () => {
  const dir = mkdtempSync(join(tmpdir(), "threadwork-schedule-migration-"));
  const path = join(dir, "db.sqlite");
  let db;
  try {
    db = openDatabase(path);
    bootstrap(db, { ADMIN_PASSWORD: "schedule-migration-password" });
    db.exec(`DROP TABLE notification_schedules; PRAGMA user_version=2;
      INSERT INTO threads VALUES(1,1,'Opening attachment','',1,NULL,1,'stamp','stamp');
      INSERT INTO attachments(id,owner_id,name,mime,size,created_at,thread_id)
        VALUES('opening',1,'hello.png','image/png',42,'stamp',1);`);
    db.close();
    db = openDatabase(path);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(
      db.prepare("SELECT thread_id FROM attachments WHERE id='opening'").get()
        .thread_id,
      1,
    );
    db.prepare(
      "INSERT INTO notification_schedules(user_id,message,due_at,created_at) VALUES(1,'Retain me','2027-01-01T00:00:00.000Z','stamp')",
    ).run();
    db.close();
    db = openDatabase(path);
    assert.equal(
      db.prepare("SELECT message FROM notification_schedules").get().message,
      "Retain me",
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("calendar validation handles Gregorian leap years and sortable timestamp boundaries", () => {
  const clock = Date.parse("0000-01-01T00:00:00Z");
  assert.equal(
    parseSchedule("0000-02-29T00:00:00Z", undefined, clock).due_at,
    "0000-02-29T00:00:00.000Z",
  );
  assert.throws(() => parseSchedule("2100-02-29T00:00:00Z", undefined, clock));
  assert.throws(() =>
    parseSchedule("9999-12-31T23:59:59-01:00", undefined, clock),
  );
  const db = openDatabase(":memory:");
  try {
    bootstrap(db, { ADMIN_PASSWORD: "schedule-boundary-password" });
    db.prepare(
      "INSERT INTO notification_schedules(user_id,message,due_at,interval_ms,created_at) VALUES(1,'Last reminder','9999-12-31T23:59:59.000Z',1000,'stamp')",
    ).run();
    assert.equal(
      deliverSchedules(db, Date.parse("9999-12-31T23:59:59.000Z")),
      1,
    );
    assert.equal(
      db.prepare("SELECT state FROM notification_schedules").get().state,
      "completed",
    );
    assert.equal(
      deliverSchedules(db, Date.parse("9999-12-31T23:59:59.500Z")),
      0,
    );
  } finally {
    db.close();
  }
});

test("private schedules persist, deliver atomically, coalesce downtime, and enforce ownership", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadwork-schedule-"));
  const env = {
    ADMIN_PASSWORD: "schedule-test-password",
    AGENT_SPARK_TOKEN: "schedule-spark",
    AGENT_SAGE_TOKEN: "schedule-sage",
  };
  let app, server, url;
  async function start() {
    app = createApp({ dataDir: dir, env });
    server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    url = `http://127.0.0.1:${server.address().port}/api`;
  }
  async function stop() {
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
  }
  async function req(
    path,
    method = "GET",
    body,
    auth = "Bearer schedule-spark",
    extra = {},
  ) {
    const response = await fetch(url + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth.startsWith("Bearer")
          ? { Authorization: auth }
          : { Cookie: auth }),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  }
  await start();
  try {
    const body = { message: "Private reminder @sage", when: "in one hour" };
    const first = await req(
      "/notification-schedules",
      "POST",
      body,
      undefined,
      { "Idempotency-Key": "create-reminder" },
    );
    assert.equal(first.status, 200);
    const retry = await req(
      "/notification-schedules",
      "POST",
      body,
      undefined,
      { "Idempotency-Key": "create-reminder" },
    );
    assert.equal(retry.data.id, first.data.id);
    assert.equal(
      (await req("/notification-schedules", "POST", { ...body, user_id: 3 }))
        .status,
      400,
    );
    assert.equal(
      (
        await req("/notification-schedules", "POST", {
          ...body,
          when: "in 0 seconds",
        })
      ).status,
      400,
    );
    assert.deepEqual(
      (
        await req(
          "/notification-schedules",
          "GET",
          undefined,
          "Bearer schedule-sage",
        )
      ).data,
      [],
    );
    assert.equal(
      (
        await req(
          `/notification-schedules/${first.data.id}`,
          "DELETE",
          undefined,
          "Bearer schedule-sage",
        )
      ).status,
      404,
    );
    const recurring = (
      await req("/notification-schedules", "POST", {
        message: "Repeat",
        when: "in 1 second",
        repeat: "every 1 hour",
      })
    ).data;
    const cancelled = (await req("/notification-schedules", "POST", body)).data;
    assert.equal(
      (await req(`/notification-schedules/${cancelled.id}`, "DELETE")).status,
      200,
    );
    // Move pending reminders into the past, then restart to exercise automatic recovery.
    const past = new Date(Date.now() - 5 * 3600000).toISOString();
    app.locals.db
      .prepare(
        "UPDATE notification_schedules SET due_at=? WHERE state='active'",
      )
      .run(past);
    await stop();
    await start();
    const inbox = (await req("/inbox")).data;
    assert.equal(inbox.length, 2);
    assert.ok(
      inbox.every(
        (n) =>
          n.type === "notification.scheduled" &&
          n.thread_id === null &&
          n.channel_id === null,
      ),
    );
    assert.equal(
      inbox.find((n) => n.payload.schedule_id === first.data.id).payload.body,
      body.message,
    );
    assert.deepEqual(
      (await req("/inbox", "GET", undefined, "Bearer schedule-sage")).data,
      [],
    );
    const active = (await req("/notification-schedules")).data;
    assert.equal(active.length, 1);
    assert.equal(active[0].id, recurring.id);
    assert.ok(Date.parse(active[0].due_at) > Date.now());
    assert.equal(deliverSchedules(app.locals.db), 0);
    // A failed schedule advancement must also roll back event and notification creation.
    app.locals.db.exec(
      "CREATE TRIGGER fail_schedule BEFORE UPDATE ON notification_schedules BEGIN SELECT RAISE(ABORT, 'test rollback'); END",
    );
    assert.throws(() =>
      deliverSchedules(app.locals.db, Date.parse(active[0].due_at)),
    );
    assert.equal((await req("/inbox")).data.length, 2);
    app.locals.db.exec("DROP TRIGGER fail_schedule");
    await req("/inbox/read", "POST", {});
    // Read state is separate from worker acceptance.
    assert.ok(
      app.locals.db
        .prepare("SELECT * FROM notifications")
        .all()
        .every((n) => n.read_at && !n.accepted_at),
    );
    const instance = "d6e1305a-de66-44ed-8a75-08d13e5ec47b";
    await req("/worker/heartbeat", "POST", {
      instance_id: instance,
      state: "idle",
    });
    const pending = await req("/worker/inbox", "GET", undefined, undefined, {
      "X-Worker-Instance": instance,
    });
    assert.equal(pending.status, 200);
    assert.equal(pending.data.length, 2);
    await req(
      "/worker/ack",
      "POST",
      { ids: pending.data.map((n) => n.id) },
      undefined,
      { "X-Worker-Instance": instance },
    );
    assert.deepEqual(
      (
        await req("/worker/inbox", "GET", undefined, undefined, {
          "X-Worker-Instance": instance,
        })
      ).data,
      [],
    );
    const timed = await req("/notification-schedules", "POST", {
      message: "Timer delivery",
      when: "in 1 second",
    });
    assert.equal(timed.status, 200);
    assert.equal((await req("/inbox")).data.length, 2);
    let delivered = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (
        (await req("/inbox")).data.some(
          (n) => n.payload.schedule_id === timed.data.id,
        )
      ) {
        delivered = true;
        break;
      }
    }
    assert.ok(
      delivered,
      "server timer delivers reminders without incoming board mutations",
    );
    const login = await fetch(url + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: env.ADMIN_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await req(
          "/notification-schedules",
          "POST",
          { message: "Human reminder", when: "in 1 hour" },
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await req("/notification-schedules", "GET", undefined, cookie)).data
        .length,
      1,
    );
    assert.equal((await req("/notification-schedules")).data.length, 1);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
