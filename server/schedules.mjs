// Four-digit ISO years keep stored timestamps chronologically sortable in SQLite.
const latestDue = Date.parse("9999-12-31T23:59:59.999Z");

// Deliberately small, deterministic grammar: no locale-dependent date guessing.
const units = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
};
export function duration(value, prefix) {
  const match = new RegExp(
    `^${prefix}\\s+(a|an|one|\\d+)\\s+(second|minute|hour|day|week)s?$`,
    "i",
  ).exec(value.trim());
  const amount =
    match &&
    (["a", "an", "one"].includes(match[1].toLowerCase())
      ? 1
      : Number(match[1]));
  const ms = match && amount * units[match[2].toLowerCase()];
  if (!Number.isSafeInteger(ms) || ms < 1000 || ms > 31536000000)
    throw new Error(
      `Use "${prefix} 1 hour" (seconds, minutes, hours, days or weeks; maximum 365 days)`,
    );
  return ms;
}
export function parseSchedule(when, repeat, clock = Date.now()) {
  const interval = repeat ? duration(repeat, "every") : null;
  let due;
  if (/^in\s/i.test(when.trim())) due = clock + duration(when, "in");
  else {
    // Offset is mandatory so a server's timezone cannot silently change intent.
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        when,
      )
    )
      throw new Error(
        'Use an ISO 8601 date/time with Z or a timezone offset, or "in one hour"',
      );
    due = Date.parse(when);
    // Date.parse normalizes impossible days; reject those before storing.
    const [year, month, day] = when.slice(0, 10).split("-").map(Number);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) due = NaN;
  }
  if (!Number.isFinite(due) || due <= clock || due > latestDue)
    throw new Error("Notification time must be a valid future date");
  return { due_at: new Date(due).toISOString(), interval_ms: interval };
}

// Each occurrence, its private notification, and schedule advancement commit together.
export function deliverSchedules(db, clock = Date.now()) {
  const timestamp = new Date(clock).toISOString();
  let count = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const schedules = db
      .prepare(
        "SELECT * FROM notification_schedules WHERE state='active' AND due_at<=? ORDER BY due_at,id",
      )
      .all(timestamp);
    for (const schedule of schedules) {
      const event = db
        .prepare(
          "INSERT INTO events(type,actor_id,payload,created_at) VALUES(?,?,?,?) RETURNING id",
        )
        .get(
          "notification.scheduled",
          schedule.user_id,
          JSON.stringify({
            schedule_id: schedule.id,
            title: "Scheduled reminder",
            body: schedule.message,
            scheduled_for: schedule.due_at,
          }),
          timestamp,
        );
      db.prepare("INSERT INTO notifications(event_id,user_id) VALUES(?,?)").run(
        event.id,
        schedule.user_id,
      );
      if (schedule.interval_ms) {
        const due = Date.parse(schedule.due_at);
        const next =
          due +
          (Math.floor((clock - due) / schedule.interval_ms) + 1) *
            schedule.interval_ms;
        if (next <= latestDue)
          db.prepare(
            "UPDATE notification_schedules SET due_at=?,last_fired_at=? WHERE id=?",
          ).run(new Date(next).toISOString(), timestamp, schedule.id);
        else
          db.prepare(
            "UPDATE notification_schedules SET state='completed',last_fired_at=? WHERE id=?",
          ).run(timestamp, schedule.id);
      } else
        db.prepare(
          "UPDATE notification_schedules SET state='completed',last_fired_at=? WHERE id=?",
        ).run(timestamp, schedule.id);
      count++;
    }
    db.exec("COMMIT");
    return count;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
