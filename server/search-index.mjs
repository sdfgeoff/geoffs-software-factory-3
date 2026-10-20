// Index ASCII-lowered content so candidate matching has exactly SQLite lower()
// semantics, including punctuation and non-ASCII case. Original text stays in replies.
export function installSearchIndex(db) {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name='search_replies'")
    .get();
  db.exec(`
    CREATE VIEW IF NOT EXISTS search_reply_content AS SELECT id,lower(body) AS body FROM replies;
    CREATE VIRTUAL TABLE IF NOT EXISTS search_replies USING fts5(body,content='search_reply_content',content_rowid='id',tokenize='trigram case_sensitive 1');
    CREATE TRIGGER IF NOT EXISTS search_reply_insert AFTER INSERT ON replies BEGIN
      INSERT INTO search_replies(rowid,body) VALUES(new.id,lower(new.body)); END;
    CREATE TRIGGER IF NOT EXISTS search_reply_delete AFTER DELETE ON replies BEGIN
      INSERT INTO search_replies(search_replies,rowid,body) VALUES('delete',old.id,lower(old.body)); END;
    CREATE TRIGGER IF NOT EXISTS search_reply_update AFTER UPDATE OF body,id ON replies BEGIN
      INSERT INTO search_replies(search_replies,rowid,body) VALUES('delete',old.id,lower(old.body));
      INSERT INTO search_replies(rowid,body) VALUES(new.id,lower(new.body)); END;
    CREATE INDEX IF NOT EXISTS search_reply_recent ON replies(created_at DESC,id);
    CREATE INDEX IF NOT EXISTS search_event_type ON events(type,id);

  `);
  if (!exists)
    db.exec("INSERT INTO search_replies(search_replies) VALUES('rebuild')");
}

export function trigramQuery(db, q) {
  const lower = db.prepare("SELECT lower(?) AS q").get(q).q;
  return [...lower].length >= 3 && !lower.includes("\0")
    ? '"' + lower.replaceAll('"', '""') + '"'
    : null;
}

// Common terms use bounded recent scanning; rare/absent terms use the inverted
// index. The fast result is exact only when it supplies the entire requested window.
export function replyBodyCandidates(db, q, needed) {
  const recent = db
    .prepare(
      `SELECT id FROM (SELECT id,body FROM replies ORDER BY created_at DESC,id LIMIT ?) WHERE instr(lower(body),lower(?))>0 LIMIT ?`,
    )
    .all(Math.max(512, needed), q, needed);
  if (recent.length === needed) return recent.map((r) => r.id);
  const match = trigramQuery(db, q);
  if (!match)
    return db
      .prepare(
        "SELECT id FROM replies WHERE instr(lower(body),lower(?))>0 ORDER BY created_at DESC,id LIMIT ?",
      )
      .all(q, needed)
      .map((r) => r.id);
  return db
    .prepare(
      `SELECT r.id FROM search_replies f JOIN replies r ON r.id=f.rowid WHERE search_replies MATCH ? AND instr(lower(r.body),lower(?))>0 ORDER BY r.created_at DESC,r.id LIMIT ?`,
    )
    .all(match, q, needed)
    .map((r) => r.id);
}

export function replyTextFilter(db, q) {
  const pattern = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
  const match = trigramQuery(db, q);
  if (match) {
    const hits = db
      .prepare(
        "SELECT rowid FROM search_replies WHERE search_replies MATCH ? LIMIT 2049",
      )
      .all(match);
    if (hits.length <= 2048) {
      const ids = hits.map((r) => r.rowid);
      return {
        sql: ids.length
          ? `t.id IN (SELECT thread_id FROM replies WHERE id IN (${ids.map(() => "?").join(",")}) AND body LIKE ? ESCAPE '\\')`
          : "0",
        // FTS sees text after a stored NUL; LIKE deliberately does not.
        args: ids.length ? [...ids, pattern] : [],
      };
    }
  }
  // For frequent terms, stop at the first matching reply in each thread instead
  // of enumerating every posting. Short literals retain the legacy fallback.
  return {
    sql: "EXISTS(SELECT 1 FROM replies r WHERE r.thread_id=t.id AND r.body LIKE ? ESCAPE '\\')",
    args: [pattern],
  };
}

// Reply titles are inherited from threads. Bound each ranking bucket as well as
// body matches; a common thread title must not expand into millions of rows.
export function replyThreadCandidates(db, threadIds, needed) {
  if (!threadIds.length) return [];
  const ids = JSON.stringify(threadIds);
  const recent = db
    .prepare(
      `SELECT id FROM (
    SELECT id,thread_id FROM replies ORDER BY created_at DESC,id LIMIT ?
  ) WHERE thread_id IN (SELECT value FROM json_each(?)) LIMIT ?`,
    )
    .all(Math.max(512, needed), ids, needed);
  if (recent.length === needed) return recent.map((r) => r.id);
  return db
    .prepare(
      `SELECT id FROM replies WHERE thread_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id LIMIT ?`,
    )
    .all(ids, needed)
    .map((r) => r.id);
}
