import { randomUUID } from "node:crypto";

// Ephemeral invalidation hints, never event payloads. A gap/restart forces recovery
// from authoritative endpoints; notification delivery remains independently durable.
export function createRefreshJournal(db, capacity = 256) {
  const epoch = randomUUID();
  let revision = 0,
    cursor = db.prepare("SELECT COALESCE(MAX(id),0) id FROM events").get().id;
  const history = [];
  const version = () => `${epoch}:${revision}`;
  function publish(hint = {}) {
    const rows = db
      .prepare(
        "SELECT id,type,thread_id FROM events WHERE id>? ORDER BY id LIMIT 1001",
      )
      .all(cursor);
    if (rows.length) cursor = rows.at(-1).id;
    const threadIds = [
      ...new Set([
        ...(hint.threadIds || []),
        ...rows.map((row) => row.thread_id).filter(Boolean),
      ]),
    ];
    const full =
      rows.length > 1000 ||
      threadIds.length > 200 ||
      (hint.full ??
        (rows.length === 0 ||
          rows.some(
            (row) => !row.thread_id && !row.type.startsWith("notification."),
          )));
    if (rows.length > 1000)
      cursor = db.prepare("SELECT MAX(id) id FROM events").get().id;
    history.push({
      revision: ++revision,
      full,
      threadIds: full ? [] : threadIds,
    });
    if (history.length > capacity) history.shift();
    return version();
  }
  function changes(since) {
    const prefix = epoch + ":",
      number =
        typeof since === "string" && since.startsWith(prefix)
          ? Number(since.slice(prefix.length))
          : NaN;
    if (
      !Number.isSafeInteger(number) ||
      number < 0 ||
      number > revision ||
      number < (history[0]?.revision || 1) - 1
    )
      return { version: version(), changed: true, reset: true, threadIds: [] };
    if (number === revision)
      return {
        version: version(),
        changed: false,
        reset: false,
        threadIds: [],
      };
    const updates = history.filter((entry) => entry.revision > number),
      ids = [...new Set(updates.flatMap((entry) => entry.threadIds))],
      reset = updates.some((entry) => entry.full) || ids.length > 200;
    return {
      version: version(),
      changed: true,
      reset,
      threadIds: reset ? [] : ids,
    };
  }
  return { version, publish, changes };
}
