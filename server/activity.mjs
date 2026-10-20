import { z } from "zod";
import { transaction, now } from "./db.mjs";
const MAX_PAYLOAD = 32768,
  MAX_ROWS = 50000,
  RETENTION = 7 * 86400000;
const supported = new Set([
  "worker/wake",
  "worker/disconnected",
  "worker/activity_gap",
  "worker/log",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "error",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
]);
const envelope = z
  .object({
    event_id: z.string().uuid(),
    session_id: z.string().min(1).max(200).nullable(),
    turn_id: z.string().max(200).nullable().optional(),
    item_id: z.string().max(200).nullable().optional(),
    type: z
      .string()
      .max(100)
      .refine((v) => supported.has(v), "Unsupported activity event type"),
    occurred_at: z.string().datetime({ offset: true }),
    payload: z.record(z.unknown()),
  })
  .strict();
const keySecret =
  /(?:token|password|authorization|cookie|credential|api[_-]?key|secret|login[_-]?code|private[_-]?key)/i;
function cleanText(value) {
  return value
    .slice(0, 24000)
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      "[redacted private key]",
    )
    .replace(/\bBearer\s+[a-zA-Z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, "[redacted]")
    .replace(
      /\b(?:gh[pousr]_[a-zA-Z0-9_]{15,}|github_pat_[a-zA-Z0-9_]{15,})/g,
      "[redacted]",
    )
    .replace(
      /((?:password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|agent[_-]?token|secret)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1[redacted]",
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/data:[^\s;,]*;base64,[a-zA-Z0-9+/=]+/g, "[binary omitted]");
}
function clean(value, depth = 0) {
  if (depth > 10) return "[truncated]";
  if (typeof value === "string") return cleanText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((v) => clean(v, depth + 1));
  if (value && typeof value === "object") {
    if (["image", "input_image", "audio", "input_audio"].includes(value.type))
      return { type: value.type, omitted: true };
    const out = {};
    for (const [key, v] of Object.entries(value).slice(0, 100)) {
      if (
        ["__proto__", "prototype", "constructor"].includes(key) ||
        /^(?:raw_?reasoning|raw_?content|encrypted_?content|reasoning_content|chain_?of_?thought)$/i.test(
          key,
        )
      )
        continue;
      out[key] = keySecret.test(key)
        ? "[redacted]"
        : /^(?:base64|image|image_data|bytes|binary|encrypted_content)$/i.test(
              key,
            )
          ? "[binary omitted]"
          : clean(v, depth + 1);
    }
    return out;
  }
  return null;
}
const pick = (obj, keys) => {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
};
export function sanitizeActivityPayload(type, input, { secrets = [] } = {}) {
  let value = {};
  if (type === "item/started" || type === "item/completed") {
    const item = input.item || {};
    const common = ["id", "type", "status"];
    const fields = {
      commandExecution: [
        "command",
        "cwd",
        "processId",
        "exitCode",
        "durationMs",
        "aggregatedOutput",
        "output",
      ],
      mcpToolCall: [
        "server",
        "tool",
        "arguments",
        "result",
        "error",
        "durationMs",
      ],
      agentMessage: ["text", "phase"],
      fileChange: ["changes"],
      reasoning: ["summary"],
      plan: ["text"],
      contextCompaction: [],
      dynamicToolCall: [
        "tool",
        "arguments",
        "status",
        "contentItems",
        "success",
        "durationMs",
      ],
      webSearch: ["query", "action"],
      imageView: ["path"],
      collabAgentToolCall: [
        "tool",
        "status",
        "senderThreadId",
        "receiverThreadIds",
      ],
    };
    if (!Object.hasOwn(fields, item.type))
      return { item: clean(pick(item, common)) };
    value = { item: pick(item, [...common, ...fields[item.type]]) };
    if (
      ["mcpToolCall", "dynamicToolCall"].includes(item.type) &&
      typeof value.item.arguments === "string"
    ) {
      try {
        value.item.arguments = JSON.parse(value.item.arguments);
      } catch {}
    }
    if (item.type === "reasoning")
      value.item.summary = Array.isArray(item.summary)
        ? item.summary
            .slice(0, 100)
            .map((part) =>
              typeof part === "string" ? part : pick(part, ["type", "text"]),
            )
        : [];
  } else if (
    type.endsWith("/delta") ||
    type === "item/reasoning/summaryTextDelta" ||
    type === "item/commandExecution/outputDelta"
  )
    value = pick(input, ["delta", "summaryIndex"]);
  else if (type.startsWith("turn/") && type !== "turn/plan/updated")
    value = { turn: pick(input.turn, ["id", "status", "error"]) };
  else if (type === "turn/plan/updated")
    value = pick(input, ["plan", "explanation"]);
  else if (type === "worker/wake")
    value = pick(input, ["notification_ids", "delivery"]);
  else if (type === "worker/activity_gap")
    value = pick(input, ["dropped", "message"]);
  else if (type === "worker/log") value = pick(input, ["level", "message"]);
  else if (type === "error") value = { error: input.error };
  else value = pick(input, ["message"]);
  let safe = clean(value);
  const exactSecrets = secrets
    .filter((v) => typeof v === "string" && v.length >= 8)
    .sort((a, b) => b.length - a.length);
  const redactString = (text) =>
    exactSecrets.reduce(
      (out, secret) => out.split(secret).join("[redacted]"),
      text,
    );
  const redactKnown = (value) =>
    typeof value === "string"
      ? redactString(value)
      : Array.isArray(value)
        ? value.map(redactKnown)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, v]) => [
                redactString(key),
                redactKnown(v),
              ]),
            )
          : value;
  safe = redactKnown(safe);
  if (Buffer.byteLength(JSON.stringify(safe)) <= MAX_PAYLOAD) return safe;
  // Keep a valid bounded JSON document instead of slicing serialized UTF-8.
  return {
    truncated: true,
    preview: cleanText(JSON.stringify(safe).slice(0, 12000)),
  };
}
function integer(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function associations(db, agentId, type, payload) {
  const links = new Map();
  const add = (threadId, kind) => {
    const id = integer(threadId);
    if (id && db.prepare("SELECT 1 FROM threads WHERE id=?").get(id))
      links.set(`${id}:${kind}`, { thread_id: id, kind });
  };
  if (
    (type === "item/started" || type === "item/completed") &&
    payload.item?.type === "mcpToolCall" &&
    payload.item.server === "threadwork"
  ) {
    let args = payload.item.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = null;
      }
    }
    if (args && typeof args === "object") {
      add(args.thread_id, "tool");
      for (const value of Array.isArray(args.thread_ids)
        ? args.thread_ids.slice(0, 100)
        : [])
        add(value, "tool");
      const branch = integer(args.branch_id);
      if (branch)
        for (const t of db
          .prepare("SELECT thread_id FROM branch_threads WHERE branch_id=?")
          .all(branch))
          add(t.thread_id, "tool");
    }
  }
  if (type === "worker/wake")
    for (const value of Array.isArray(payload.notification_ids)
      ? payload.notification_ids.slice(0, 100)
      : []) {
      const n = integer(value);
      if (!n) continue;
      const event = db
        .prepare(
          "SELECT e.thread_id FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.id=? AND n.user_id=?",
        )
        .get(n, agentId);
      if (event?.thread_id) add(event.thread_id, "wake");
    }
  return [...links.values()];
}
export function pruneActivity(
  db,
  { agentId, at = Date.now(), maxRows = MAX_ROWS, counts = true } = {},
) {
  const cutoff = new Date(at - RETENTION).toISOString();
  db.prepare("DELETE FROM agent_activity WHERE created_at<?").run(cutoff);
  if (!counts) return;
  const agents = agentId
    ? [{ agent_id: agentId }]
    : db.prepare("SELECT DISTINCT agent_id FROM agent_activity").all();
  for (const agent of agents) {
    const threshold = db
      .prepare(
        "SELECT id FROM agent_activity WHERE agent_id=? ORDER BY id DESC LIMIT 1 OFFSET ?",
      )
      .get(agent.agent_id, maxRows - 1);
    if (threshold)
      db.prepare("DELETE FROM agent_activity WHERE agent_id=? AND id<?").run(
        agent.agent_id,
        threshold.id,
      );
  }
}
export function installActivity({ app, db, admin, env = process.env }) {
  const configuredSecrets = Object.entries(env)
    .filter(
      ([key, value]) =>
        keySecret.test(key) && typeof value === "string" && value.length >= 8,
    )
    .map(([, value]) => value);
  const fail = (status, message) => {
    throw Object.assign(new Error(message), { status });
  };
  const prune = (options) => transaction(db, () => pruneActivity(db, options));
  prune();
  const timer = setInterval(() => {
    try {
      prune();
    } catch (error) {
      console.error("Activity retention failed", error.message);
    }
  }, 3600000);
  timer.unref();
  app.post("/api/worker/activity", (req, res) => {
    // This route is installed after both existing worker identity and lease guards.
    const input = z
      .object({ events: z.array(envelope).max(64) })
      .strict()
      .parse(req.body);
    for (const e of input.events)
      if (Buffer.byteLength(JSON.stringify(e.payload)) > MAX_PAYLOAD)
        fail(413, "Activity payloads must be 32 KiB or smaller");
    const result = transaction(db, () => {
      let inserted = 0;
      for (const e of input.events) {
        const safe = sanitizeActivityPayload(e.type, e.payload, {
          secrets: [
            ...configuredSecrets,
            req.headers.authorization?.replace(/^Bearer /, ""),
          ],
        });
        const row = db
          .prepare(
            "INSERT OR IGNORE INTO agent_activity(agent_id,event_id,session_id,turn_id,item_id,type,occurred_at,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
          )
          .get(
            req.user.id,
            e.event_id,
            e.session_id,
            e.turn_id || null,
            e.item_id || null,
            e.type,
            e.occurred_at,
            JSON.stringify(safe),
            now(),
          );
        if (!row) continue;
        inserted++;
        for (const link of associations(db, req.user.id, e.type, safe))
          db.prepare("INSERT INTO agent_activity_links VALUES(?,?,?)").run(
            row.id,
            link.thread_id,
            link.kind,
          );
      }
      pruneActivity(db, { agentId: req.user.id });
      return { accepted: input.events.map((e) => e.event_id), inserted };
    });
    res.json(result);
  });
  const querySchema = z
    .object({
      after: z.coerce.number().int().nonnegative().optional(),
      before: z.coerce.number().int().positive().optional(),
      turn_id: z.string().min(1).max(200).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
      include_wakes: z.enum(["true", "false"]).optional(),
    })
    .strict()
    .refine(
      (q) => q.after === undefined || q.before === undefined,
      "Use after or before, not both",
    );
  function read(req, res, kind) {
    const value = z.coerce.number().int().positive().parse(req.params.id);
    const q = querySchema.parse(req.query);
    if (
      kind === "agent" &&
      !db.prepare("SELECT 1 FROM agents WHERE user_id=?").get(value)
    )
      fail(404, "Agent not found");
    if (
      kind === "thread" &&
      !db.prepare("SELECT 1 FROM threads WHERE id=?").get(value)
    )
      fail(404, "Thread not found");
    prune({ counts: false });
    const clauses = [],
      args = [];
    if (kind === "agent") {
      clauses.push("a.agent_id=?");
      args.push(value);
    } else {
      clauses.push(
        `EXISTS(SELECT 1 FROM agent_activity_links l WHERE l.activity_id=a.id AND l.thread_id=?${q.include_wakes === "true" ? "" : " AND l.kind='tool'"})`,
      );
      args.push(value);
    }
    if (q.after !== undefined) {
      clauses.push("a.id>?");
      args.push(q.after);
    }
    if (q.before !== undefined) {
      clauses.push("a.id<?");
      args.push(q.before);
    }
    if (q.turn_id) {
      clauses.push("a.turn_id=?");
      args.push(q.turn_id);
    }
    const rows = db
      .prepare(
        `SELECT a.*,u.name AS agent_name FROM agent_activity a JOIN users u ON u.id=a.agent_id WHERE ${clauses.join(" AND ")} ORDER BY a.id ${q.after !== undefined ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...args, q.limit + 1);
    const has_more = rows.length > q.limit;
    const events = rows.slice(0, q.limit).map((row) => ({
      ...row,
      payload: JSON.parse(row.payload),
      links: db
        .prepare(
          "SELECT thread_id,kind FROM agent_activity_links WHERE activity_id=? ORDER BY thread_id,kind",
        )
        .all(row.id),
    }));
    res.json({
      events,
      has_more,
      cursor: events.at(-1)?.id ?? q.after ?? q.before ?? null,
    });
  }
  app.get("/api/admin/agents/:id/activity", admin, (req, res) =>
    read(req, res, "agent"),
  );
  app.get("/api/admin/threads/:id/activity", admin, (req, res) =>
    read(req, res, "thread"),
  );
  return { shutdown: () => clearInterval(timer) };
}
