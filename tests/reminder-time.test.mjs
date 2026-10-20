import { test } from "node:test";
import assert from "node:assert/strict";
import {
  customReminderTime,
  reminderRequest,
} from "../web/src/reminder-time.mjs";
test("local reminder controls serialize absolute times and fixed repeats without exposing syntax", () => {
  const due = customReminderTime("2030-10-23", "09:30");
  assert.equal(due.getHours(), 9);
  assert.equal(due.getMinutes(), 30);
  assert.deepEqual(
    reminderRequest("  Review\nthe build  ", due, true, "24", "hour", 0),
    {
      message: "Review\nthe build",
      when: due.toISOString(),
      repeat: "every 24 hours",
    },
  );
  assert.equal(
    reminderRequest("Once", due, false, "", "", 0).repeat,
    undefined,
  );
  assert.equal(customReminderTime("2030-02-30", "09:00"), null);
  assert.throws(() => reminderRequest(" ", due, false, "", "", 0));
  assert.throws(() => reminderRequest("Past", new Date(0), false, "", ""));
  assert.throws(() => reminderRequest("Invalid", null, false, "", ""));
  for (const amount of ["0", "-1", "1.5", "366"])
    assert.throws(() => reminderRequest("Repeat", due, true, amount, "day", 0));
});
test("nonexistent daylight saving time is rejected; repeated time has an explicit chosen instant", () => {
  const before = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    assert.equal(customReminderTime("2030-03-10", "02:30"), null);
    assert.equal(
      customReminderTime("2030-11-03", "01:30").toISOString(),
      "2030-11-03T05:30:00.000Z",
    );
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});
