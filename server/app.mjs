import { installOrchestration, gitIdentity } from "./orchestration.mjs";
import express from "express";
import { searchPlatform } from "./search.mjs";
import { parseSchedule, deliverSchedules } from "./schedules.mjs";
import multer from "multer";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  openDatabase,
  bootstrap,
  transaction,
  hash,
  token,
  now,
} from "./db.mjs";

const username = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,39}$/,
    "Use 2–40 lowercase letters, numbers, underscores or hyphens.",
  );
const text = z.string().max(50000);
const positive = z.coerce.number().int().positive();
const attachmentIds = z.array(z.string().uuid()).max(10).default([]);
const openingTitle = (body, attachments) => {
  const line = body
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/!?(?:\[([^\]]*)\])\([^)]+\)/g, "$1")
        .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find(Boolean);
  const title = line || attachments[0]?.name || "Attachment";
  if (title.length <= 80) return title;
  const prefix = title.slice(0, 79);
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 50 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
};
const safeUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  kind: u.kind,
  admin: !!u.admin,
  created_at: u.created_at,
});
const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  throw error;
};
const publicAgent = (a) => {
  const {
    instance_id,
    login_code,
    login_url,
    login_requested,
    stop_version,
    ...rest
  } = a;
  return rest;
};
export function createApp({
  dataDir = resolve("data"),
  env = process.env,
} = {}) {
  mkdirSync(join(dataDir, "uploads"), { recursive: true });
  const db = openDatabase(join(dataDir, "threadwork.sqlite"));
  bootstrap(db, env);
  const app = express();
  app.disable("x-powered-by");
  const streams = new Set();
  const broadcast = () => {
    for (const response of streams)
      response.write("event: refresh\ndata: {}\n\n");
  };
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      let host;
      try {
        host = new URL(req.headers.origin).host;
      } catch {
        return res.status(403).json({ error: "Invalid origin" });
      }
      if (host !== req.headers.host)
        return res
          .status(403)
          .json({ error: "Cross-origin requests are not allowed" });
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", (req, res) =>
    res.json({ ok: true, version: "0.1.0" }),
  );
  const loginAttempts = new Map();
  app.post("/api/login", async (req, res) => {
    const input = z
      .object({ username: z.string().max(100), password: z.string().max(200) })
      .parse(req.body);
    const key = req.ip;
    const attempt = loginAttempts.get(key) || { count: 0, start: Date.now() };
    if (Date.now() - attempt.start > 600000) {
      attempt.count = 0;
      attempt.start = Date.now();
    }
    if (++attempt.count > 30)
      fail(429, "Too many login attempts. Try again in 10 minutes.");
    loginAttempts.set(key, attempt);
    if (loginAttempts.size > 10000)
      for (const [k, v] of loginAttempts)
        if (Date.now() - v.start > 600000) loginAttempts.delete(k);
    const user = db
      .prepare("SELECT * FROM users WHERE username=? AND kind='human'")
      .get(input.username);
    const valid = await bcrypt.compare(
      input.password,
      user?.password ||
        "$2b$12$qYOwTXhq7b5FqTz7.Qrj1e1EvAba88rIu0nsPRlH2xw3rUlhTxKgi",
    );
    if (!user || !valid) fail(401, "Incorrect username or password");
    loginAttempts.delete(key);
    const credential = token();
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      hash(credential),
      user.id,
      new Date(Date.now() + 7 * 86400000).toISOString(),
    );
    res.setHeader(
      "Set-Cookie",
      `tw_session=${credential}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${env.COOKIE_SECURE === "true" ? "; Secure" : ""}`,
    );
    res.json({ user: safeUser(user) });
  });
  app.use("/api", (req, res, next) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const cookie = req.headers.cookie?.match(
      /(?:^|;\s*)tw_session=([a-f0-9]+)/,
    )?.[1];
    let user;
    if (
      /^\/git\/\d+\.git\//.test(req.path) &&
      req.headers.authorization?.startsWith("Basic ")
    )
      user = gitIdentity(db, req.headers.authorization);
    else if (bearer)
      user = db
        .prepare("SELECT * FROM users WHERE token_hash=? AND kind='agent'")
        .get(hash(bearer));
    else if (cookie)
      user = db
        .prepare(
          "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
        )
        .get(hash(cookie), now());
    if (!user) {
      if (req.path.startsWith("/git/"))
        res.setHeader("WWW-Authenticate", 'Basic realm="Threadwork Git"');
      return res.status(401).json({ error: "Sign in required" });
    }
    req.user = safeUser(user);
    req.session = cookie;
    if (
      user.kind === "agent" &&
      req.headers["x-worker-instance"] &&
      req.path !== "/worker/heartbeat"
    ) {
      const lease = db
        .prepare("SELECT instance_id,heartbeat_at FROM agents WHERE user_id=?")
        .get(user.id);
      if (
        lease.instance_id !== req.headers["x-worker-instance"] ||
        Date.now() - Date.parse(lease.heartbeat_at) > 30000
      )
        return res.status(409).json({ error: "Worker lease expired" });
    }
    next();
  });
  const admin = (req, res, next) => {
    if (!req.user.admin)
      return res.status(403).json({ error: "Admin access required" });
    next();
  };
  const worker = (req, res, next) => {
    if (req.user.kind !== "agent")
      return res.status(403).json({ error: "Agent credential required" });
    next();
  };
  const getThread = (id) =>
    db.prepare("SELECT * FROM threads WHERE id=?").get(positive.parse(id)) ||
    fail(404, "Thread not found");
  const getChannel = (id) =>
    db.prepare("SELECT * FROM channels WHERE id=?").get(positive.parse(id)) ||
    fail(404, "Channel not found");
  const participate = (threadId, userId) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO thread_subscriptions(thread_id,user_id) VALUES(?,?)",
      )
      .run(threadId, userId);
  const mentions = (content) => {
    const ids = new Set();
    for (const match of content.matchAll(
      /(?:^|[^\w])@([a-z][a-z0-9_-]{1,39})(?![a-z0-9_-])/gi,
    )) {
      const user = db
        .prepare("SELECT id FROM users WHERE username=?")
        .get(match[1]);
      if (user) ids.add(user.id);
    }
    return [...ids];
  };
  function event(type, actor, thread, payload = {}, extra = []) {
    const channelId = thread?.channel_id || payload.channel_id || null;
    const e = db
      .prepare(
        "INSERT INTO events(type,actor_id,thread_id,channel_id,payload,created_at) VALUES(?,?,?,?,?,?) RETURNING *",
      )
      .get(
        type,
        actor,
        thread?.id || null,
        channelId,
        JSON.stringify(payload),
        now(),
      );
    const recipients = new Set(extra);
    if (thread)
      for (const sub of db
        .prepare(
          "SELECT user_id FROM thread_subscriptions WHERE thread_id=? AND subscribed=1",
        )
        .all(thread.id))
        recipients.add(sub.user_id);
    if (type === "thread.created")
      for (const sub of db
        .prepare("SELECT user_id FROM channel_subscriptions WHERE channel_id=?")
        .all(channelId))
        recipients.add(sub.user_id);
    recipients.delete(actor);
    for (const id of recipients)
      db.prepare(
        "INSERT OR IGNORE INTO notifications(event_id,user_id) VALUES(?,?)",
      ).run(e.id, id);
    return e;
  }
  // Atomic idempotency keys let agent tools safely retry after a lost HTTP response.
  function mutate(req, res, fn) {
    const key = req.headers["idempotency-key"];
    if (key && !/^[a-zA-Z0-9:_-]{1,150}$/.test(key))
      fail(400, "Invalid idempotency key");
    const cacheKey = key ? `${req.method}:${req.path}:${key}` : null;
    const result = transaction(db, () => {
      if (cacheKey) {
        const cached = db
          .prepare("SELECT response FROM mutations WHERE user_id=? AND key=?")
          .get(req.user.id, cacheKey);
        if (cached) return JSON.parse(cached.response);
      }
      const value = fn();
      // Credentials are returned once and stored only as hashes, never in retry caches.
      if (cacheKey && value?.token)
        fail(
          400,
          "Idempotency keys are not supported for credential operations",
        );
      if (cacheKey)
        db.prepare("INSERT INTO mutations VALUES(?,?,?)").run(
          req.user.id,
          cacheKey,
          JSON.stringify(value),
        );
      return value;
    });
    broadcast();
    res.json(result);
  }
  installOrchestration({
    app,
    db,
    dataDir,
    env,
    admin,
    event,
    participate,
    broadcast,
    mutate,
    fail,
  });
  app.get("/api/search", (req, res) =>
    res.json(searchPlatform(db, req.user, req.query)),
  );
  app.post("/api/notification-schedules", (req, res) => {
    const input = z
      .object({
        message: z.string().trim().min(1).max(50000),
        when: z.string().min(1).max(100),
        repeat: z.string().min(1).max(100).optional(),
      })
      .strict()
      .parse(req.body);
    mutate(req, res, () => {
      let schedule;
      try {
        schedule = parseSchedule(input.when, input.repeat);
      } catch (error) {
        fail(400, error.message);
      }
      return db
        .prepare(
          "INSERT INTO notification_schedules(user_id,message,due_at,interval_ms,created_at) VALUES(?,?,?,?,?) RETURNING *",
        )
        .get(
          req.user.id,
          input.message,
          schedule.due_at,
          schedule.interval_ms,
          now(),
        );
    });
  });
  app.get("/api/notification-schedules", (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM notification_schedules WHERE user_id=? AND state='active' ORDER BY due_at,id",
        )
        .all(req.user.id),
    ),
  );
  app.delete("/api/notification-schedules/:id", (req, res) =>
    mutate(req, res, () => {
      const schedule = db
        .prepare(
          "UPDATE notification_schedules SET state='cancelled' WHERE id=? AND user_id=? AND state='active' RETURNING *",
        )
        .get(positive.parse(req.params.id), req.user.id);
      if (!schedule) fail(404, "Active schedule not found");
      return schedule;
    }),
  );
  app.post("/api/logout", (req, res) => {
    if (req.session)
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
        hash(req.session),
      );
    res.setHeader(
      "Set-Cookie",
      "tw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    );
    res.json({ ok: true });
  });
  app.get("/api/me", (req, res) => res.json(req.user));
  app.get("/api/bootstrap", (req, res) =>
    res.json({
      user: req.user,
      users: db
        .prepare("SELECT * FROM users ORDER BY kind,name")
        .all()
        .map(safeUser),
      channels: db
        .prepare(
          "SELECT c.*,EXISTS(SELECT 1 FROM channel_subscriptions s WHERE s.channel_id=c.id AND s.user_id=?) AS subscribed,(SELECT COUNT(*) FROM threads t WHERE t.channel_id=c.id) AS thread_count FROM channels c ORDER BY archived,name",
        )
        .all(req.user.id),
      statuses: db.prepare("SELECT * FROM statuses ORDER BY position,id").all(),
      agents: db
        .prepare(
          "SELECT a.*,u.name,u.username FROM agents a JOIN users u ON u.id=a.user_id",
        )
        .all()
        .map(publicAgent),
      unread: db
        .prepare(
          "SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL",
        )
        .get(req.user.id).n,
    }),
  );
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(": connected\n\n");
    streams.add(res);
    const timer = setInterval(() => {
      const valid =
        req.session &&
        db
          .prepare("SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?")
          .get(hash(req.session), now());
      if (!valid) return res.end();
      res.write(": heartbeat\n\n");
    }, 20000);
    req.on("close", () => {
      streams.delete(res);
      clearInterval(timer);
    });
  });
  app.post("/api/channels", (req, res) =>
    mutate(req, res, () => {
      const input = z
        .object({
          name: username,
          description: z.string().max(1000).default(""),
        })
        .parse(req.body);
      return db
        .prepare(
          "INSERT INTO channels(name,description,created_by,created_at) VALUES(?,?,?,?) RETURNING *",
        )
        .get(input.name, input.description, req.user.id, now());
    }),
  );
  app.patch("/api/channels/:id", (req, res) =>
    mutate(req, res, () => {
      const old = getChannel(req.params.id);
      const input = z
        .object({
          name: username.optional(),
          description: z.string().max(1000).optional(),
          archived: z.boolean().optional(),
        })
        .parse(req.body);
      return db
        .prepare(
          "UPDATE channels SET name=?,description=?,archived=? WHERE id=? RETURNING *",
        )
        .get(
          input.name ?? old.name,
          input.description ?? old.description,
          input.archived === undefined ? old.archived : +input.archived,
          old.id,
        );
    }),
  );
  app.put("/api/channels/:id/subscription", (req, res) =>
    mutate(req, res, () => {
      const c = getChannel(req.params.id);
      const { subscribed } = z
        .object({ subscribed: z.boolean() })
        .parse(req.body);
      if (subscribed)
        db.prepare(
          "INSERT OR IGNORE INTO channel_subscriptions VALUES(?,?)",
        ).run(c.id, req.user.id);
      else
        db.prepare(
          "DELETE FROM channel_subscriptions WHERE channel_id=? AND user_id=?",
        ).run(c.id, req.user.id);
      return { subscribed };
    }),
  );
  const threadQuery = `SELECT t.*,c.name AS channel_name,u.name AS author_name,u.username AS author_username,u.kind AS author_kind,a.name AS assignee_name,a.kind AS assignee_kind,s.name AS status_name,s.color AS status_color,(SELECT COUNT(*) FROM replies r WHERE r.thread_id=t.id) AS reply_count FROM threads t JOIN channels c ON c.id=t.channel_id JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.assignee_id JOIN statuses s ON s.id=t.status_id`;
  app.get("/api/threads", (req, res) => {
    const clauses = [];
    const args = [];
    if (req.query.channel) {
      clauses.push("t.channel_id=?");
      args.push(positive.parse(req.query.channel));
    }
    if (req.query.assignee) {
      clauses.push("t.assignee_id=?");
      args.push(positive.parse(req.query.assignee));
    }
    if (req.query.q) {
      clauses.push(
        "(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM replies r WHERE r.thread_id=t.id AND r.body LIKE ? ESCAPE '\\'))",
      );
      const q = `%${String(req.query.q)
        .slice(0, 200)
        .replace(/[\\%_]/g, "\\$&")}%`;
      args.push(q, q, q);
    }
    const offset = Math.max(0, Math.min(100000, Number(req.query.offset) || 0));
    res.json(
      db
        .prepare(
          threadQuery +
            (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
            " ORDER BY t.created_at DESC,t.id DESC LIMIT 500 OFFSET ?",
        )
        .all(...args, offset),
    );
  });
  app.get("/api/threads/:id", (req, res) => {
    const t = getThread(req.params.id);
    const replies = db
      .prepare(
        "SELECT r.*,u.name AS author_name,u.username AS author_username,u.kind AS author_kind FROM replies r JOIN users u ON u.id=r.author_id WHERE r.thread_id=? ORDER BY r.id",
      )
      .all(t.id);
    for (const reply of replies)
      reply.attachments = db
        .prepare("SELECT * FROM attachments WHERE reply_id=?")
        .all(reply.id);
    const activity = db
      .prepare(
        "SELECT e.*,u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor_id WHERE e.thread_id=? ORDER BY e.id DESC LIMIT 100",
      )
      .all(t.id)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload) }));
    res.json({
      ...db.prepare(threadQuery + " WHERE t.id=?").get(t.id),
      attachments: db
        .prepare("SELECT * FROM attachments WHERE thread_id=?")
        .all(t.id),
      replies,
      activity,
      subscribed: !!db
        .prepare(
          "SELECT 1 FROM thread_subscriptions WHERE thread_id=? AND user_id=? AND subscribed=1",
        )
        .get(t.id, req.user.id),
    });
  });
  app.post("/api/threads", (req, res) =>
    mutate(req, res, () => {
      const input = z
        .object({
          channel_id: positive,
          title: z.string().trim().max(240).optional(),
          body: text.default(""),
          attachment_ids: attachmentIds,
          status_id: positive.optional(),
          assignee_id: positive.nullable().optional(),
        })
        .parse(req.body);
      if (!input.title && !input.body.trim() && !input.attachment_ids.length)
        fail(400, "Write a message or add an attachment");
      const attachments = input.attachment_ids.map(
        (id) =>
          db
            .prepare(
              "SELECT * FROM attachments WHERE id=? AND owner_id=? AND reply_id IS NULL AND thread_id IS NULL",
            )
            .get(id, req.user.id) ||
          fail(400, "Attachment unavailable or belongs to someone else"),
      );
      const title = input.title || openingTitle(input.body, attachments);
      const channel = getChannel(input.channel_id);
      if (channel.archived)
        fail(400, "Reopen this channel before creating threads");
      const status =
        input.status_id ||
        db.prepare("SELECT id FROM statuses ORDER BY position,id LIMIT 1").get()
          .id;
      const stamp = now();
      const t = db
        .prepare(
          "INSERT INTO threads(channel_id,title,body,status_id,assignee_id,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) RETURNING *",
        )
        .get(
          input.channel_id,
          title,
          input.body,
          status,
          input.assignee_id || null,
          req.user.id,
          stamp,
          stamp,
        );
      for (const attachment of attachments)
        db.prepare("UPDATE attachments SET thread_id=? WHERE id=?").run(
          t.id,
          attachment.id,
        );
      const mentioned = mentions(title + " " + input.body);
      for (const id of [
        req.user.id,
        ...mentioned,
        ...(input.assignee_id ? [input.assignee_id] : []),
      ])
        participate(t.id, id);
      event(
        "thread.created",
        req.user.id,
        t,
        {
          title: t.title,
          body: t.body,
          assignee_id: t.assignee_id,
          attachment_ids: input.attachment_ids,
        },
        mentioned,
      );
      return t;
    }),
  );
  app.patch("/api/threads/:id", (req, res) =>
    mutate(req, res, () => {
      const t = getThread(req.params.id);
      const input = z
        .object({
          title: z.string().trim().min(1).max(240).optional(),
          body: text.optional(),
          status_id: positive.optional(),
          assignee_id: positive.nullable().optional(),
        })
        .parse(req.body);
      const changes = {};
      for (const [key, value] of Object.entries(input))
        if (value !== t[key]) changes[key] = { from: t[key], to: value };
      if (!Object.keys(changes).length) return t;
      const updated = db
        .prepare(
          "UPDATE threads SET title=?,body=?,status_id=?,assignee_id=?,updated_at=? WHERE id=? RETURNING *",
        )
        .get(
          input.title ?? t.title,
          input.body ?? t.body,
          input.status_id ?? t.status_id,
          input.assignee_id === undefined ? t.assignee_id : input.assignee_id,
          now(),
          t.id,
        );
      const mentioned = mentions(
        (input.title || "") + " " + (input.body || ""),
      );
      for (const id of [
        req.user.id,
        ...mentioned,
        ...(updated.assignee_id ? [updated.assignee_id] : []),
      ])
        participate(t.id, id);
      event(
        "thread.updated",
        req.user.id,
        updated,
        { title: updated.title, changes },
        [
          ...mentioned,
          ...(changes.assignee_id?.to ? [changes.assignee_id.to] : []),
        ],
      );
      return updated;
    }),
  );
  app.put("/api/threads/:id/subscription", (req, res) =>
    mutate(req, res, () => {
      const t = getThread(req.params.id);
      const { subscribed } = z
        .object({ subscribed: z.boolean() })
        .parse(req.body);
      db.prepare(
        "INSERT INTO thread_subscriptions VALUES(?,?,?) ON CONFLICT(thread_id,user_id) DO UPDATE SET subscribed=excluded.subscribed",
      ).run(t.id, req.user.id, +subscribed);
      return { subscribed };
    }),
  );
  app.post("/api/threads/:id/replies", (req, res) =>
    mutate(req, res, () => {
      const t = getThread(req.params.id);
      const input = z
        .object({
          body: text.default(""),
          attachment_ids: attachmentIds,
        })
        .parse(req.body);
      if (!input.body.trim() && !input.attachment_ids.length)
        fail(400, "Write a reply or add an attachment");
      for (const id of input.attachment_ids)
        if (
          !db
            .prepare(
              "SELECT 1 FROM attachments WHERE id=? AND owner_id=? AND reply_id IS NULL AND thread_id IS NULL",
            )
            .get(id, req.user.id)
        )
          fail(400, "Attachment unavailable or belongs to someone else");
      const reply = db
        .prepare(
          "INSERT INTO replies(thread_id,author_id,body,created_at) VALUES(?,?,?,?) RETURNING *",
        )
        .get(t.id, req.user.id, input.body, now());
      for (const id of input.attachment_ids)
        db.prepare("UPDATE attachments SET reply_id=? WHERE id=?").run(
          reply.id,
          id,
        );
      db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(now(), t.id);
      const mentioned = mentions(input.body);
      for (const id of [req.user.id, ...mentioned]) participate(t.id, id);
      event(
        "reply.created",
        req.user.id,
        t,
        {
          title: t.title,
          reply_id: reply.id,
          body: reply.body,
          attachment_ids: input.attachment_ids,
        },
        mentioned,
      );
      return reply;
    }),
  );
  app.patch("/api/replies/:id", (req, res) =>
    mutate(req, res, () => {
      const r =
        db
          .prepare("SELECT * FROM replies WHERE id=?")
          .get(positive.parse(req.params.id)) || fail(404, "Reply not found");
      if (r.author_id !== req.user.id && !req.user.admin)
        fail(403, "Only the author or admin can edit this reply");
      const { body } = z.object({ body: text }).parse(req.body);
      if (
        !body.trim() &&
        !db.prepare("SELECT 1 FROM attachments WHERE reply_id=?").get(r.id)
      )
        fail(400, "Reply cannot be empty");
      db.prepare("UPDATE replies SET body=?,edited_at=? WHERE id=?").run(
        body,
        now(),
        r.id,
      );
      const t = getThread(r.thread_id);
      const mentioned = mentions(body);
      for (const id of [req.user.id, ...mentioned]) participate(t.id, id);
      db.prepare("UPDATE threads SET updated_at=? WHERE id=?").run(now(), t.id);
      event(
        "reply.edited",
        req.user.id,
        t,
        { title: t.title, reply_id: r.id, body },
        mentioned,
      );
      return { ok: true };
    }),
  );
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
  });
  app.post("/api/attachments", upload.single("file"), (req, res) => {
    if (!req.file) fail(400, "A file is required");
    const id = randomUUID();
    const bytes = req.file.buffer;
    let mime = "application/octet-stream";
    if (
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      mime = "image/png";
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
      mime = "image/jpeg";
    else if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
      mime = "image/gif";
    else if (
      bytes.subarray(0, 4).toString() === "RIFF" &&
      bytes.subarray(8, 12).toString() === "WEBP"
    )
      mime = "image/webp";
    const name =
      req.file.originalname.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 240) ||
      "attachment";
    writeFileSync(join(dataDir, "uploads", id), bytes, { mode: 0o600 });
    try {
      const attachment = db
        .prepare(
          "INSERT INTO attachments(id,owner_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?) RETURNING *",
        )
        .get(id, req.user.id, name, mime, bytes.length, now());
      res.json(attachment);
    } catch (error) {
      unlinkSync(join(dataDir, "uploads", id));
      throw error;
    }
  });
  app.get("/api/attachments/:id", (req, res) => {
    const a =
      db.prepare("SELECT * FROM attachments WHERE id=?").get(req.params.id) ||
      fail(404, "Attachment not found");
    if (!a.reply_id && !a.thread_id && a.owner_id !== req.user.id)
      fail(403, "Attachment has not been posted");
    res.setHeader("Content-Type", a.mime);
    res.setHeader(
      "Content-Disposition",
      `${a.mime.startsWith("image/") && req.query.download !== "1" ? "inline" : "attachment"}; filename="attachment"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.sendFile(resolve(dataDir, "uploads", a.id));
  });
  app.delete("/api/attachments/:id", (req, res) => {
    const a =
      db
        .prepare(
          "SELECT * FROM attachments WHERE id=? AND owner_id=? AND reply_id IS NULL AND thread_id IS NULL",
        )
        .get(req.params.id, req.user.id) ||
      fail(404, "Unposted attachment not found");
    db.prepare("DELETE FROM attachments WHERE id=?").run(a.id);
    try {
      unlinkSync(join(dataDir, "uploads", a.id));
    } catch {}
    res.json({ ok: true });
  });
  const inboxQuery = `SELECT n.*,e.type,e.actor_id,e.thread_id,e.channel_id,e.payload,e.created_at,u.name AS actor_name,u.username AS actor_username,c.name AS channel_name FROM notifications n JOIN events e ON e.id=n.event_id JOIN users u ON u.id=e.actor_id LEFT JOIN channels c ON c.id=e.channel_id`;
  app.get("/api/inbox", (req, res) =>
    res.json(
      db
        .prepare(inboxQuery + " WHERE n.user_id=? ORDER BY n.id DESC LIMIT 200")
        .all(req.user.id)
        .map((n) => ({ ...n, payload: JSON.parse(n.payload) })),
    ),
  );
  app.post("/api/inbox/read", (req, res) =>
    mutate(req, res, () => {
      const { ids } = z
        .object({ ids: z.array(positive).max(200).optional() })
        .parse(req.body);
      if (ids)
        for (const id of ids)
          db.prepare(
            "UPDATE notifications SET read_at=? WHERE id=? AND user_id=?",
          ).run(now(), id, req.user.id);
      else
        db.prepare(
          "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
        ).run(now(), req.user.id);
      return { ok: true };
    }),
  );
  app.post("/api/admin/users", admin, async (req, res) => {
    const input = z
      .object({
        username,
        name: z.string().trim().min(1).max(80),
        password: z.string().min(10).max(200),
        admin: z.boolean().default(false),
      })
      .parse(req.body);
    const password = await bcrypt.hash(input.password, 12);
    const user = db
      .prepare(
        "INSERT INTO users(username,name,kind,admin,password,created_at) VALUES(?,?,'human',?,?,?) RETURNING *",
      )
      .get(input.username, input.name, +input.admin, password, now());
    broadcast();
    res.json(safeUser(user));
  });
  app.post("/api/admin/agents", admin, (req, res) =>
    mutate(req, res, () => {
      const input = z
        .object({
          username,
          name: z.string().trim().min(1).max(80),
          role: z.string().min(1).max(20000),
          model: z.string().max(100).default(""),
        })
        .parse(req.body);
      const credential = token();
      const u = db
        .prepare(
          "INSERT INTO users(username,name,kind,token_hash,created_at) VALUES(?,?,'agent',?,?) RETURNING *",
        )
        .get(input.username, input.name, hash(credential), now());
      db.prepare("INSERT INTO agents(user_id,role,model) VALUES(?,?,?)").run(
        u.id,
        input.role,
        input.model,
      );
      return { user: safeUser(u), token: credential };
    }),
  );
  app.get("/api/admin/agents/:id", admin, (req, res) => {
    const agent =
      db
        .prepare(
          "SELECT a.*,u.name,u.username FROM agents a JOIN users u ON u.id=a.user_id WHERE user_id=?",
        )
        .get(positive.parse(req.params.id)) || fail(404, "Agent not found");
    const logs = db
      .prepare(
        "SELECT * FROM agent_logs WHERE agent_id=? ORDER BY id DESC LIMIT 60",
      )
      .all(agent.user_id);
    res.json({
      ...agent,
      instance_id: undefined,
      logs,
      subscriptions: db
        .prepare("SELECT channel_id FROM channel_subscriptions WHERE user_id=?")
        .all(agent.user_id)
        .map((s) => s.channel_id),
    });
  });
  app.patch("/api/admin/agents/:id", admin, (req, res) =>
    mutate(req, res, () => {
      const a =
        db
          .prepare("SELECT * FROM agents WHERE user_id=?")
          .get(positive.parse(req.params.id)) || fail(404, "Agent not found");
      const input = z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          role: z.string().min(1).max(20000).optional(),
          model: z.string().max(100).optional(),
          desired: z.enum(["running", "paused"]).optional(),
        })
        .parse(req.body);
      if (input.name)
        db.prepare("UPDATE users SET name=? WHERE id=?").run(
          input.name,
          a.user_id,
        );
      db.prepare(
        "UPDATE agents SET role=?,model=?,desired=? WHERE user_id=?",
      ).run(
        input.role ?? a.role,
        input.model ?? a.model,
        input.desired ?? a.desired,
        a.user_id,
      );
      return { ok: true };
    }),
  );
  app.put("/api/admin/agents/:id/subscriptions", admin, (req, res) =>
    mutate(req, res, () => {
      const id = positive.parse(req.params.id);
      if (!db.prepare("SELECT 1 FROM agents WHERE user_id=?").get(id))
        fail(404, "Agent not found");
      const { channel_id, subscribed } = z
        .object({ channel_id: positive, subscribed: z.boolean() })
        .parse(req.body);
      getChannel(channel_id);
      if (subscribed)
        db.prepare(
          "INSERT OR IGNORE INTO channel_subscriptions VALUES(?,?)",
        ).run(channel_id, id);
      else
        db.prepare(
          "DELETE FROM channel_subscriptions WHERE channel_id=? AND user_id=?",
        ).run(channel_id, id);
      return { ok: true };
    }),
  );
  app.post("/api/admin/agents/:id/command", admin, (req, res) =>
    mutate(req, res, () => {
      const { command } = z
        .object({ command: z.enum(["login", "stop", "rotate-token"]) })
        .parse(req.body);
      const id = positive.parse(req.params.id);
      if (!db.prepare("SELECT 1 FROM agents WHERE user_id=?").get(id))
        fail(404, "Agent not found");
      if (command === "login")
        db.prepare(
          "UPDATE agents SET login_requested=1,login_code=NULL,login_url=NULL WHERE user_id=?",
        ).run(id);
      if (command === "stop")
        db.prepare(
          "UPDATE agents SET stop_version=stop_version+1,desired='paused' WHERE user_id=?",
        ).run(id);
      if (command === "rotate-token") {
        const credential = token();
        db.prepare("UPDATE users SET token_hash=? WHERE id=?").run(
          hash(credential),
          id,
        );
        db.prepare(
          "UPDATE agents SET instance_id=NULL,heartbeat_at=NULL WHERE user_id=?",
        ).run(id);
        return { token: credential };
      }
      return { ok: true };
    }),
  );
  app.post("/api/admin/statuses", admin, (req, res) =>
    mutate(req, res, () => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(40),
          color: z.string().regex(/^#[a-f0-9]{6}$/i),
        })
        .parse(req.body);
      return db
        .prepare(
          "INSERT INTO statuses(name,color,position) VALUES(?,?,(SELECT COALESCE(MAX(position),0)+1 FROM statuses)) RETURNING *",
        )
        .get(input.name, input.color);
    }),
  );
  app.patch("/api/admin/statuses/:id", admin, (req, res) =>
    mutate(req, res, () => {
      const input = z
        .object({
          name: z.string().trim().min(1).max(40),
          color: z.string().regex(/^#[a-f0-9]{6}$/i),
          position: z.number().int().min(0),
        })
        .parse(req.body);
      return (
        db
          .prepare(
            "UPDATE statuses SET name=?,color=?,position=? WHERE id=? RETURNING *",
          )
          .get(
            input.name,
            input.color,
            input.position,
            positive.parse(req.params.id),
          ) || fail(404, "Status not found")
      );
    }),
  );
  app.use("/api/worker", worker);
  app.post("/api/worker/heartbeat", (req, res) => {
    const input = z
      .object({
        instance_id: z.string().uuid(),
        state: z.enum([
          "idle",
          "working",
          "paused",
          "error",
          "auth_required",
          "starting",
        ]),
        session_id: z.string().max(200).nullable().optional(),
        auth_status: z.string().max(100).optional(),
        error: z.string().max(2000).nullable().optional(),
        login_url: z.string().url().nullable().optional(),
        login_code: z.string().max(100).nullable().optional(),
        login_handled: z.boolean().optional(),
      })
      .parse(req.body);
    const a = db
      .prepare("SELECT * FROM agents WHERE user_id=?")
      .get(req.user.id);
    if (
      a.instance_id &&
      a.instance_id !== input.instance_id &&
      Date.now() - Date.parse(a.heartbeat_at) < 30000
    )
      fail(
        409,
        "Another worker already owns this agent. Stop it before starting a replacement.",
      );
    db.prepare(
      "UPDATE agents SET instance_id=?,heartbeat_at=?,state=?,session_id=?,auth_status=?,error=?,login_url=?,login_code=?,login_requested=? WHERE user_id=?",
    ).run(
      input.instance_id,
      now(),
      input.state,
      input.session_id ?? a.session_id,
      input.auth_status ?? a.auth_status,
      input.error ?? null,
      input.login_url === undefined ? a.login_url : input.login_url,
      input.login_code === undefined ? a.login_code : input.login_code,
      input.login_handled ? 0 : a.login_requested,
      req.user.id,
    );
    if (
      a.state !== input.state ||
      a.auth_status !== input.auth_status ||
      input.login_code
    )
      broadcast();
    const config = db
      .prepare(
        "SELECT a.*,u.name,u.username FROM agents a JOIN users u ON u.id=a.user_id WHERE user_id=?",
      )
      .get(req.user.id);
    res.json({ ...config, instance_id: undefined });
  });
  app.use("/api/worker", (req, res, next) => {
    const a = db
      .prepare("SELECT * FROM agents WHERE user_id=?")
      .get(req.user.id);
    if (
      !a.instance_id ||
      a.instance_id !== req.headers["x-worker-instance"] ||
      Date.now() - Date.parse(a.heartbeat_at) > 30000
    )
      return res
        .status(409)
        .json({ error: "Worker lease expired; heartbeat before continuing" });
    next();
  });
  app.get("/api/worker/inbox", (req, res) =>
    res.json(
      db
        .prepare(
          inboxQuery +
            " WHERE n.user_id=? AND n.accepted_at IS NULL ORDER BY n.id LIMIT 30",
        )
        .all(req.user.id)
        .map((n) => ({ ...n, payload: JSON.parse(n.payload) })),
    ),
  );
  app.post("/api/worker/ack", (req, res) => {
    const { ids } = z
      .object({ ids: z.array(positive).max(30) })
      .parse(req.body);
    for (const id of ids)
      db.prepare(
        "UPDATE notifications SET accepted_at=?,read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?",
      ).run(now(), now(), id, req.user.id);
    res.json({ ok: true });
  });
  app.post("/api/worker/log", (req, res) => {
    const input = z
      .object({
        level: z.enum(["info", "error", "warn"]),
        message: z.string().max(2000),
      })
      .parse(req.body);
    db.prepare(
      "INSERT INTO agent_logs(agent_id,level,message,created_at) VALUES(?,?,?,?)",
    ).run(req.user.id, input.level, input.message, now());
    db.prepare(
      "DELETE FROM agent_logs WHERE agent_id=? AND id NOT IN(SELECT id FROM agent_logs WHERE agent_id=? ORDER BY id DESC LIMIT 200)",
    ).run(req.user.id, req.user.id);
    res.json({ ok: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "API route not found" }),
  );
  const dist = resolve("dist");
  if (existsSync(join(dist, "index.html"))) {
    app.use(express.static(dist));
    app.get("/{*path}", (req, res) => res.sendFile(join(dist, "index.html")));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError)
      return res.status(400).json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
    if (error.code === "LIMIT_FILE_SIZE")
      return res
        .status(413)
        .json({ error: "Attachments must be 20 MB or smaller" });
    if (error.code?.startsWith("LIMIT_"))
      return res.status(400).json({ error: error.message });
    if (error.message?.includes("UNIQUE constraint"))
      return res.status(409).json({ error: "That name is already in use" });
    if (error.message?.includes("FOREIGN KEY constraint"))
      return res
        .status(400)
        .json({ error: "Referenced user, channel or status does not exist" });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "Request is too large" });
    if (error instanceof SyntaxError && "body" in error)
      return res.status(400).json({ error: "Invalid JSON" });
    if (!error.status) console.error(error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : "Unexpected server error",
    });
  });
  const runSchedules = () => {
    if (deliverSchedules(db)) broadcast();
  };
  // Recover overdue reminders before accepting traffic, closing the handle on failure.
  try {
    runSchedules();
  } catch (error) {
    db.close();
    throw error;
  }
  const scheduleTimer = setInterval(() => {
    try {
      runSchedules();
    } catch (error) {
      console.error("Notification scheduler failed", error);
    }
  }, 1000);
  scheduleTimer.unref();
  app.locals.db = db;
  let closed = false;
  app.locals.shutdown = () => {
    if (closed) return;
    closed = true;
    clearInterval(scheduleTimer);
    for (const response of streams) response.end();
    db.close();
  };
  return app;
}
