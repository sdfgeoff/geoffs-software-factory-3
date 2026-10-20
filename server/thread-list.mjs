import { z } from "zod";
import { replyTextFilter } from "./search-index.mjs";
const positive = z.coerce.number().int().positive();
export const threadQuery = `SELECT t.*,c.name AS channel_name,u.name AS author_name,u.username AS author_username,u.kind AS author_kind,a.name AS assignee_name,a.kind AS assignee_kind,s.name AS status_name,s.color AS status_color,(SELECT COUNT(*) FROM replies r WHERE r.thread_id=t.id) AS reply_count FROM threads t JOIN channels c ON c.id=t.channel_id JOIN users u ON u.id=t.created_by LEFT JOIN users a ON a.id=t.assignee_id JOIN statuses s ON s.id=t.status_id`;

export function listThreads(db, query) {
  const clauses = [];
  const args = [];
  if (query.ids !== undefined) {
    const ids = [
      ...new Set(
        z.array(positive).min(1).max(200).parse(String(query.ids).split(",")),
      ),
    ];
    clauses.push(`t.id IN (${ids.map(() => "?").join(",")})`);
    args.push(...ids);
  }
  if (query.channel) {
    clauses.push("t.channel_id=?");
    args.push(positive.parse(query.channel));
  }
  if (query.assignee) {
    clauses.push("t.assignee_id=?");
    args.push(positive.parse(query.assignee));
  }
  if (query.q) {
    const raw = String(query.q).slice(0, 200);
    const reply = replyTextFilter(db, raw);
    clauses.push(
      `(t.title LIKE ? ESCAPE '\\' OR t.body LIKE ? ESCAPE '\\' OR ${reply.sql})`,
    );
    const pattern = "%" + raw.replace(/[\\%_]/g, "\\$&") + "%";
    args.push(pattern, pattern, ...reply.args);
  }
  if (query.paged === "1") {
    if (query.status) {
      clauses.push("t.status_id=?");
      args.push(positive.parse(query.status));
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const counts = db
      .prepare(
        "SELECT t.status_id,COUNT(*) AS count FROM threads t" +
          where +
          " GROUP BY t.status_id",
      )
      .all(...args);
    const total = counts.reduce((n, row) => n + row.count, 0);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .parse(query.limit);
    const direction = query.after ? "after" : "before";
    const cursor = query.after || query.before;
    const pageClauses = [...clauses],
      pageArgs = [...args];
    if (cursor) {
      const [stamp, id] = z
        .tuple([z.string().min(1).max(40), positive])
        .parse(String(cursor).split("|"));
      pageClauses.push(
        `(t.created_at,t.id) ${direction === "after" ? ">" : "<"} (?,?)`,
      );
      pageArgs.push(stamp, id);
    }
    const pageWhere = pageClauses.length
      ? " WHERE " + pageClauses.join(" AND ")
      : "";
    let items = db
      .prepare(
        threadQuery +
          pageWhere +
          ` ORDER BY t.created_at ${direction === "after" ? "ASC" : "DESC"},t.id ${direction === "after" ? "ASC" : "DESC"} LIMIT ?`,
      )
      .all(...pageArgs, limit);
    if (direction === "after") items.reverse();
    const boundary = (item, comparison) =>
      item &&
      !!db
        .prepare(
          "SELECT 1 FROM threads t" +
            where +
            (where ? " AND " : " WHERE ") +
            `(t.created_at,t.id) ${comparison} (?,?) LIMIT 1`,
        )
        .get(...args, item.created_at, item.id);
    const encode = (item) => `${item.created_at}|${item.id}`;
    const first = items[0],
      last = items.at(-1);
    return {
      items,
      total,
      statusCounts: Object.fromEntries(
        counts.map((r) => [r.status_id, r.count]),
      ),
      older: boundary(last, "<") ? encode(last) : null,
      newer: boundary(first, ">") ? encode(first) : null,
    };
  }
  const offset = Math.max(0, Math.min(100000, Number(query.offset) || 0));
  return db
    .prepare(
      threadQuery +
        (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
        " ORDER BY t.created_at DESC,t.id DESC LIMIT 500 OFFSET ?",
    )
    .all(...args, offset);
}
