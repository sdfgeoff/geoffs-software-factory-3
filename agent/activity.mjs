import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const itemFields = {
  agentMessage: ["text", "phase"],
  plan: ["text"],
  reasoning: ["summary"],
  commandExecution: [
    "command",
    "cwd",
    "status",
    "commandActions",
    "aggregatedOutput",
    "exitCode",
    "durationMs",
  ],
  fileChange: ["changes", "status"],
  mcpToolCall: [
    "server",
    "tool",
    "status",
    "arguments",
    "result",
    "error",
    "durationMs",
  ],
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
  contextCompaction: [],
};
const deltas = new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
]);
const secretKey =
  /(?:password|passwd|authorization|cookie|api[_-]?key|token|login[_-]?code|credential|secret|private[_-]?key|encrypted)/i;

export function activitySanitizer(env = process.env) {
  const secrets = Object.entries(env)
    .filter(([key, value]) => secretKey.test(key) || /(?:^|_)TOKEN$/.test(key))
    .map(([, value]) => value)
    .filter((value) => typeof value === "string" && value.length >= 8)
    .sort((a, b) => b.length - a.length);
  function text(value) {
    for (const secret of secrets)
      value = value.split(secret).join("[REDACTED]");
    return value
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
        "[REDACTED PRIVATE KEY]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
      .replace(
        /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
        "[REDACTED]",
      )
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(
        /\b(password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        "$1=[REDACTED]",
      )
      .replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g, "[binary omitted]");
  }
  function sanitize(value) {
    let remaining = 16000,
      nodes = 500;
    function visit(v, depth = 0) {
      if (--nodes <= 0 || depth > 8) return "[truncated]";
      if (typeof v === "string") {
        const safe = text(v);
        const size = Math.max(0, Math.min(8000, remaining));
        const output = safe.slice(0, size);
        remaining -= output.length;
        return output + (safe.length > size ? "…[truncated]" : "");
      }
      if (v === null || typeof v === "boolean" || typeof v === "number")
        return v;
      if (Array.isArray(v))
        return v.slice(0, 60).map((entry) => visit(entry, depth + 1));
      if (v && typeof v === "object") {
        const output = {};
        for (const [key, entry] of Object.entries(v).slice(0, 60)) {
          if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype" ||
            [
              "rawContent",
              "raw_content",
              "raw_reasoning",
              "encryptedContent",
              "encrypted_content",
            ].includes(key)
          )
            continue;
          output[key.slice(0, 100)] = secretKey.test(key)
            ? "[REDACTED]"
            : /^(data|bytes|base64)$/i.test(key)
              ? "[binary omitted]"
              : visit(entry, depth + 1);
        }
        return output;
      }
      return null;
    }
    const result = visit(value);
    if (Buffer.byteLength(JSON.stringify(result)) > 30000)
      return {
        truncated: true,
        preview: text(JSON.stringify(result)).slice(0, 6000),
      };
    return result;
  }
  // Hold a suffix so split credentials cannot leak through separate deltas.
  const hold = Math.max(128, ...secrets.map((value) => value.length + 64));
  sanitize.streamPrefix = (value) => {
    let cut = Math.max(0, value.length - hold);
    for (const secret of secrets) {
      let at = value.indexOf(secret);
      while (at !== -1) {
        if (at < cut && at + secret.length > cut) cut = at;
        at = value.indexOf(secret, at + 1);
      }
    }
    for (const match of value.matchAll(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)|\bBearer\s+[A-Za-z0-9._~+\/-]+=*|\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+|https?:\/\/[^\s/@]+:[^\s/@]+@|\b(?:password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    )) {
      if (match.index < cut && match.index + match[0].length > cut)
        cut = match.index;
    }
    return [value.slice(0, cut), value.slice(cut)];
  };
  return sanitize;
}

export function normalizeActivity(message) {
  const { method: type, params: p = {} } = message;
  let payload;
  if (type === "item/started" || type === "item/completed") {
    const source = p.item;
    if (!source || !Object.hasOwn(itemFields, source.type)) return null;
    const item = { id: source.id, type: source.type };
    for (const field of itemFields[source.type])
      if (source[field] !== undefined) item[field] = source[field];
    payload = { item };
  } else if (deltas.has(type))
    payload = {
      delta: p.delta,
      ...(p.summaryIndex === undefined ? {} : { summaryIndex: p.summaryIndex }),
    };
  else if (type === "turn/started" || type === "turn/completed")
    payload = {
      turn: { id: p.turn?.id, status: p.turn?.status, error: p.turn?.error },
    };
  else if (type === "turn/plan/updated")
    payload = { plan: p.plan, explanation: p.explanation };
  else if (type === "error")
    payload = { error: p.error, willRetry: p.willRetry };
  else return null;
  return {
    type,
    session_id: p.threadId || null,
    turn_id: p.turnId || p.turn?.id || null,
    item_id: p.itemId || p.item?.id || null,
    payload,
  };
}

// Telemetry has its own journal. Delivery never controls notification acceptance.
export class ActivityRecorder {
  constructor({
    root,
    api,
    context = () => ({}),
    env = process.env,
    stdout = (event) =>
      console.log(JSON.stringify({ source: "threadwork.activity", ...event })),
    maxBytes = 2 * 1024 * 1024,
  }) {
    this.file = join(root, "activity-spool.json");
    this.api = api;
    this.context = context;
    this.enabled = env.AGENT_ACTIVITY !== "false";
    this.stdoutEnabled = env.AGENT_ACTIVITY_STDOUT !== "false";
    this.sanitize = activitySanitizer(env);
    this.stdout = stdout;
    this.maxBytes = maxBytes;
    this.events = [];
    let spoolError;
    if (this.enabled && existsSync(this.file)) {
      try {
        const stored = JSON.parse(readFileSync(this.file, "utf8"));
        if (!Array.isArray(stored)) throw new Error("Invalid activity journal");
        this.events = stored;
      } catch {
        spoolError = true;
        try {
          renameSync(this.file, this.file + ".corrupt-" + Date.now());
        } catch {
          /* Reported independently below. */
        }
      }
    }
    this.streams = new Map();
    if (spoolError)
      this.record({
        type: "worker/activity_gap",
        payload: {
          dropped: 0,
          message:
            "Unreadable activity journal quarantined; runtime delivery state is unaffected.",
        },
      });
    this.timer = setInterval(() => {
      this.flushStreams();
      void this.flush();
    }, 1000);
    this.timer.unref();
  }
  persist() {
    writeFileSync(this.file + ".tmp", JSON.stringify(this.events), {
      mode: 0o600,
    });
    renameSync(this.file + ".tmp", this.file);
  }
  record(event) {
    if (!this.enabled) return;
    try {
      const context = this.context();
      const safe = {
        event_id: randomUUID(),
        occurred_at: new Date().toISOString(),
        session_id: context.session_id || null,
        turn_id: context.turn_id || null,
        item_id: null,
        ...event,
        payload: this.sanitize(event.payload || {}),
      };
      if (this.stdoutEnabled) this.stdout(safe);
      this.events.push(safe);
      let dropped = 0;
      while (
        this.events.length > 1 &&
        Buffer.byteLength(JSON.stringify(this.events)) > this.maxBytes
      ) {
        this.events.shift();
        dropped++;
      }
      if (dropped) {
        const gap = {
          event_id: randomUUID(),
          occurred_at: new Date().toISOString(),
          session_id: context.session_id || null,
          turn_id: null,
          item_id: null,
          type: "worker/activity_gap",
          payload: {
            dropped,
            message: "Activity spool overflow; oldest events discarded.",
          },
        };
        this.events.push(gap);
        if (this.stdoutEnabled) this.stdout(gap);
      }
      this.persist();
    } catch (error) {
      // A broken telemetry disk cannot break an accepted runtime notification.
      console.error(
        JSON.stringify({
          source: "threadwork.activity",
          error: "Could not journal agent activity",
          code: error.code || "ACTIVITY_ERROR",
        }),
      );
    }
  }
  notification(message) {
    if (!this.enabled) return;
    const event = normalizeActivity(message);
    if (!event) return;
    const context = this.context();
    event.session_id ||= context.session_id || null;
    event.turn_id ||= context.turn_id || null;
    if (deltas.has(event.type)) {
      const key = JSON.stringify([
        event.session_id,
        event.turn_id,
        event.item_id,
        event.type,
        event.payload.summaryIndex,
      ]);
      let stream = this.streams.get(key);
      if (!stream) {
        stream = { ...event, payload: { ...event.payload, delta: "" } };
        this.streams.set(key, stream);
      }
      stream.payload.delta += String(event.payload.delta || "");
      if (stream.payload.delta.length >= 8000) this.flushStreams();
      if (stream.payload.delta.length > 32000 || this.streams.size > 64) {
        this.streams.delete(key);
        this.record({
          type: "worker/activity_gap",
          payload: {
            dropped: 1,
            message:
              "Oversized incomplete activity stream omitted; completed items remain authoritative.",
          },
        });
      }
      return;
    }
    const terminal =
      event.type === "item/completed" || event.type === "turn/completed";
    this.flushStreams(terminal, terminal ? event : null);
    this.record(event);
  }
  flushStreams(final = false, scope = null) {
    for (const [key, event] of this.streams) {
      const matches =
        final &&
        (!scope ||
          (scope.turn_id === event.turn_id &&
            (!scope.item_id || scope.item_id === event.item_id)));
      const [prefix, tail] = matches
        ? [event.payload.delta, ""]
        : this.sanitize.streamPrefix(event.payload.delta);
      if (prefix)
        this.record({ ...event, payload: { ...event.payload, delta: prefix } });
      event.payload.delta = tail;
      if (!tail) this.streams.delete(key);
    }
  }
  async flush() {
    if (!this.enabled || this.flushing || !this.events.length) return;
    this.flushing = true;
    const batch = this.events.slice(0, 16);
    try {
      const result = await this.api("/worker/activity", {
        method: "POST",
        body: { events: batch },
        retries: 0,
        timeout: 3000,
      });
      const accepted = new Set(result.accepted || []);
      this.events = this.events.filter(
        (event) => !accepted.has(event.event_id),
      );
      this.persist();
    } catch {
      /* Durable spool retries on the next tick, including after restart. */
    } finally {
      this.flushing = false;
    }
  }
  stop() {
    clearInterval(this.timer);
    this.flushStreams();
    if (this.streams.size)
      this.record({
        type: "worker/activity_gap",
        payload: {
          dropped: this.streams.size,
          message: "Incomplete trailing output omitted during worker shutdown.",
        },
      });
    this.streams.clear();
  }
}
