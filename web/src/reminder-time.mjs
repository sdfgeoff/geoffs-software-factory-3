export const reminderUnits = {
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
};
export function localDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function customReminderTime(day, time) {
  if (!day || !time) return null;
  const date = new Date(`${day}T${time}`);
  if (
    !Number.isFinite(date.getTime()) ||
    localDateValue(date) !== day ||
    `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` !==
      time
  )
    return null;
  return date;
}
export function reminderTimeLabel(value) {
  return new Date(value).toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  });
}
export function reminderRequest(
  message,
  due,
  repeat,
  amount,
  unit,
  clock = Date.now(),
) {
  if (!message.trim())
    throw new Error("Add a message so you know what to remember.");
  if (!due || !Number.isFinite(due.getTime()))
    throw new Error(
      "Choose a valid date and time. This local time may not exist because the clocks change.",
    );
  if (due.getTime() <= clock) throw new Error("Choose a time in the future.");
  const body = { message: message.trim(), when: due.toISOString() };
  if (repeat) {
    const count = Number(amount),
      ms = count * reminderUnits[unit];
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      !Number.isSafeInteger(ms) ||
      ms > 31536000000
    )
      throw new Error(
        "Choose a whole repeat interval between 1 minute and 365 days.",
      );
    body.repeat = `every ${count} ${unit}${count === 1 ? "" : "s"}`;
  }
  return body;
}
