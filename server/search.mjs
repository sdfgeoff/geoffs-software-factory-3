import { replyBodyCandidates, replyThreadCandidates } from "./search-index.mjs";
import { httpRequests } from "../shared/requests.mjs";

// Search published board content and the caller's private reminders only. Selecting
// explicit fields keeps credentials out; runtime log content requires admin access.
export function searchPlatform(db, user, input) {
  const { q, limit, offset } = httpRequests.search.parse(input);
  if (!q) return { results: [], has_more: false };
  const needed = limit + offset + 1;
  const candidateIds = new Set(replyBodyCandidates(db, q, needed));
  const titles = db
    .prepare(
      `SELECT id,CASE WHEN lower(title)=lower(?) THEN 0 WHEN instr(lower(title),lower(?))>0 THEN 1 ELSE 2 END AS priority FROM threads WHERE instr(lower(title),lower(?))>0 OR lower(?)='tw-' || id`,
    )
    .all(q, q, q, q);
  for (const priority of [0, 1, 2]) {
    const ids = titles.filter((t) => t.priority === priority).map((t) => t.id);
    for (const id of replyThreadCandidates(db, ids, needed))
      candidateIds.add(id);
  }
  const candidates = JSON.stringify([...candidateIds]);
  const rows = db
    .prepare(
      `
    WITH reply_candidates AS (
      SELECT value AS id FROM json_each($candidates)
    ), content AS (
      SELECT 'channel' AS kind, c.id, c.name AS title, c.description AS body,
        c.id AS channel_id, c.name AS channel_name, NULL AS thread_id,
        NULL AS reply_id, c.created_at, CASE WHEN c.archived THEN 'Archived channel' ELSE 'Channel' END AS label
        FROM channels c
      UNION ALL
      SELECT 'thread', t.id, t.title, t.body, c.id, c.name, t.id, NULL, t.updated_at, 'TW-' || t.id
        FROM threads t JOIN channels c ON c.id=t.channel_id
      UNION ALL
      SELECT 'reply', r.id, t.title, r.body, c.id, c.name, t.id, r.id, r.created_at, 'Reply · TW-' || t.id
        FROM reply_candidates rc JOIN replies r ON r.id=rc.id JOIN threads t ON t.id=r.thread_id JOIN channels c ON c.id=t.channel_id
      UNION ALL
      SELECT 'attachment', a.id, a.name, t.title, c.id, c.name, t.id, r.id, a.created_at, 'Attachment · TW-' || t.id
        FROM attachments a LEFT JOIN replies r ON r.id=a.reply_id
        JOIN threads t ON t.id=COALESCE(r.thread_id,a.thread_id) JOIN channels c ON c.id=t.channel_id
      UNION ALL
      SELECT 'repository', p.id, p.name, 'Main branch: ' || p.main_branch, NULL, NULL, NULL, NULL, p.created_at, 'Repository'
        FROM repositories p
      UNION ALL
      SELECT 'branch', b.id, b.name, p.name || ' · ' || u.name || ' · ' || b.state, NULL, NULL,
        (SELECT thread_id FROM branch_threads WHERE branch_id=b.id ORDER BY thread_id LIMIT 1), NULL, b.created_at, 'Managed branch'
        FROM managed_branches b JOIN repositories p ON p.id=b.repository_id JOIN users u ON u.id=b.owner_id
      UNION ALL
      SELECT 'person', u.id, u.name, '@' || u.username || ' ' || COALESCE(a.role,''), NULL, NULL, NULL, NULL, u.created_at,
        CASE WHEN u.kind='agent' THEN 'Agent' ELSE 'Person' END
        FROM users u LEFT JOIN agents a ON a.user_id=u.id
      UNION ALL
      SELECT 'reminder', s.id, 'Scheduled reminder', s.message, NULL, NULL, NULL, NULL, s.created_at,
        'Private reminder · ' || s.state FROM notification_schedules s WHERE s.user_id=$user
      UNION ALL
      SELECT 'notification', n.id, 'Delivered reminder', json_extract(e.payload,'$.body'), NULL, NULL, NULL, NULL, e.created_at,
        'Private reminder · delivered' FROM notifications n JOIN events e ON e.id=n.event_id
        WHERE n.user_id=$user AND e.type='notification.scheduled'
      UNION ALL
      SELECT 'agent-log', l.id, u.name || ' runtime log', l.message, NULL, NULL, NULL, NULL, l.created_at,
        'Runtime log · ' || l.level FROM agent_logs l JOIN users u ON u.id=l.agent_id WHERE $admin=1
    )
    SELECT *, CASE WHEN kind='agent-log' THEN (SELECT agent_id FROM agent_logs WHERE id=content.id) ELSE NULL END AS agent_id FROM content WHERE
      instr(lower(title),lower($q))>0 OR instr(lower(body),lower($q))>0
      OR (thread_id IS NOT NULL AND lower($q)='tw-' || thread_id)
    ORDER BY CASE WHEN lower(title)=lower($q) THEN 0 WHEN instr(lower(title),lower($q))>0 THEN 1 ELSE 2 END,
      created_at DESC, kind, id
    LIMIT $limit OFFSET $offset
  `,
    )
    .all({
      candidates,
      user: user.id,
      admin: user.admin ? 1 : 0,
      q,
      limit: limit + 1,
      offset,
    });
  const results = rows.slice(0, limit).map(({ body, ...row }) => {
    const text = (body || "").replace(/\s+/g, " ");
    const at = text.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, at - 70);
    return {
      ...row,
      snippet:
        (start ? "…" : "") +
        text.slice(start, start + 230) +
        (text.length > start + 230 ? "…" : ""),
    };
  });
  return { results, has_more: rows.length > limit };
}
