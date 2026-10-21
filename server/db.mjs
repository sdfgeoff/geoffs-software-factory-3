import { installSearchIndex } from "./search-index.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export const now = () => new Date().toISOString();
export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
      admin INTEGER NOT NULL DEFAULT 0, password TEXT, token_hash TEXT UNIQUE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, description TEXT NOT NULL DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id), archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS statuses (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS threads (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status_id INTEGER NOT NULL REFERENCES statuses(id), assignee_id INTEGER REFERENCES users(id), created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES threads(id), author_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL, edited_at TEXT);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, reply_id INTEGER REFERENCES replies(id), owner_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS thread_subscriptions (thread_id INTEGER NOT NULL REFERENCES threads(id), user_id INTEGER NOT NULL REFERENCES users(id), subscribed INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(thread_id,user_id));
    CREATE TABLE IF NOT EXISTS channel_subscriptions (channel_id INTEGER NOT NULL REFERENCES channels(id), user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(channel_id,user_id));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, type TEXT NOT NULL, actor_id INTEGER NOT NULL REFERENCES users(id), thread_id INTEGER REFERENCES threads(id), channel_id INTEGER REFERENCES channels(id), payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), user_id INTEGER NOT NULL REFERENCES users(id), read_at TEXT, accepted_at TEXT, UNIQUE(event_id,user_id));
    CREATE INDEX IF NOT EXISTS notification_inbox ON notifications(user_id,accepted_at,id);
    CREATE INDEX IF NOT EXISTS thread_channel ON threads(channel_id,created_at);
    CREATE INDEX IF NOT EXISTS reply_thread ON replies(thread_id,id);
    CREATE TABLE IF NOT EXISTS agents (user_id INTEGER PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', desired TEXT NOT NULL DEFAULT 'running', state TEXT NOT NULL DEFAULT 'offline', session_id TEXT, heartbeat_at TEXT, instance_id TEXT, error TEXT, auth_status TEXT NOT NULL DEFAULT 'unknown', login_url TEXT, login_code TEXT, login_requested INTEGER NOT NULL DEFAULT 0, stop_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS agent_logs (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agents(user_id), level TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mutations (user_id INTEGER NOT NULL REFERENCES users(id), key TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(user_id,key));

  `);
  // SQLite can add this nullable foreign key without rewriting existing replies.
  transaction(db, () => {
    if (
      !db
        .prepare("PRAGMA table_info(attachments)")
        .all()
        .some((c) => c.name === "thread_id")
    )
      db.exec(
        "ALTER TABLE attachments ADD COLUMN thread_id INTEGER REFERENCES threads(id)",
      );
    db.exec(`CREATE TABLE IF NOT EXISTS notification_schedules (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      message TEXT NOT NULL, due_at TEXT NOT NULL, interval_ms INTEGER,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','completed','cancelled')),
      created_at TEXT NOT NULL, last_fired_at TEXT
    );
    CREATE INDEX IF NOT EXISTS schedule_due ON notification_schedules(state,due_at);`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_capabilities (user_id INTEGER PRIMARY KEY REFERENCES users(id), can_work INTEGER NOT NULL DEFAULT 1, can_review INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS repositories (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, url TEXT NOT NULL, main_branch TEXT NOT NULL, credential_env TEXT, require_human INTEGER NOT NULL DEFAULT 0, created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_branches (id INTEGER PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), state TEXT NOT NULL DEFAULT 'active', head_commit TEXT NOT NULL, created_at TEXT NOT NULL, merged_at TEXT, UNIQUE(repository_id,name));
      CREATE TABLE IF NOT EXISTS branch_contributors (branch_id INTEGER NOT NULL REFERENCES managed_branches(id), user_id INTEGER NOT NULL REFERENCES users(id), PRIMARY KEY(branch_id,user_id));
      CREATE TABLE IF NOT EXISTS branch_threads (branch_id INTEGER NOT NULL REFERENCES managed_branches(id), thread_id INTEGER NOT NULL REFERENCES threads(id), PRIMARY KEY(branch_id,thread_id));
      CREATE TABLE IF NOT EXISTS branch_reviews (id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES managed_branches(id), reviewer_id INTEGER NOT NULL REFERENCES users(id), commit_hash TEXT NOT NULL, target_commit TEXT NOT NULL, decision TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', require_human INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branch_dependencies (branch_id INTEGER NOT NULL REFERENCES managed_branches(id), depends_on_id INTEGER NOT NULL REFERENCES managed_branches(id), PRIMARY KEY(branch_id,depends_on_id), CHECK(branch_id != depends_on_id));
      CREATE TABLE IF NOT EXISTS git_credentials (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS git_push_journal (repository_id INTEGER PRIMARY KEY REFERENCES repositories(id), actor_id INTEGER NOT NULL REFERENCES users(id));
      CREATE TABLE IF NOT EXISTS git_operations (id INTEGER PRIMARY KEY, repository_id INTEGER NOT NULL REFERENCES repositories(id), branch_id INTEGER REFERENCES managed_branches(id), actor_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, commit_hash TEXT NOT NULL, previous_commit TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL);
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id),notify_ready_work INTEGER NOT NULL DEFAULT 0,notify_ready_reviews INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS active_work_claims(user_id INTEGER PRIMARY KEY REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('work','review')),thread_id INTEGER UNIQUE REFERENCES threads(id),branch_id INTEGER UNIQUE REFERENCES managed_branches(id),submission_id INTEGER,commit_hash TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_submissions(id INTEGER PRIMARY KEY,thread_id INTEGER NOT NULL REFERENCES threads(id),worker_id INTEGER NOT NULL REFERENCES users(id),submitted_by INTEGER NOT NULL REFERENCES users(id),summary TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_reviews(id INTEGER PRIMARY KEY,submission_id INTEGER NOT NULL REFERENCES work_submissions(id),reviewer_id INTEGER NOT NULL REFERENCES users(id),decision TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS branch_submissions(branch_id INTEGER PRIMARY KEY REFERENCES managed_branches(id),commit_hash TEXT NOT NULL,submitted_by INTEGER NOT NULL REFERENCES users(id),state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_signals(kind TEXT NOT NULL,entity_id INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(kind,entity_id));
      CREATE TABLE IF NOT EXISTS queue_wakes(user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,entity_id INTEGER NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(user_id,kind,entity_id,revision));
    `);
    // Human inbox ordering and unread counts need independent access paths;
    // retain notification_inbox for worker accepted_at/oldest-first delivery.
    db.exec(`CREATE INDEX IF NOT EXISTS notification_latest ON notifications(user_id,id);
      CREATE INDEX IF NOT EXISTS notification_unread ON notifications(user_id) WHERE read_at IS NULL;`);
    db.exec("CREATE INDEX IF NOT EXISTS event_thread ON events(thread_id,id)");
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,agent_id INTEGER NOT NULL REFERENCES agents(user_id),event_id TEXT NOT NULL,session_id TEXT,turn_id TEXT,item_id TEXT,type TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(agent_id,event_id));
      CREATE INDEX IF NOT EXISTS agent_activity_recent ON agent_activity(agent_id,id DESC);
      CREATE INDEX IF NOT EXISTS agent_activity_turn ON agent_activity(agent_id,turn_id,id);
      CREATE INDEX IF NOT EXISTS agent_activity_retention ON agent_activity(created_at);
      CREATE TABLE IF NOT EXISTS agent_activity_links(activity_id INTEGER NOT NULL REFERENCES agent_activity(id) ON DELETE CASCADE,thread_id INTEGER NOT NULL REFERENCES threads(id),kind TEXT NOT NULL CHECK(kind IN ('tool','wake')),PRIMARY KEY(activity_id,thread_id,kind));
      CREATE INDEX IF NOT EXISTS agent_activity_thread ON agent_activity_links(thread_id,kind,activity_id);
    `);
    if (db.prepare("PRAGMA user_version").get().user_version < 9) {
      installSearchIndex(db);
      db.exec("PRAGMA user_version=9");
    }
    const repoColumns = new Set(
      db
        .prepare("PRAGMA table_info(repositories)")
        .all()
        .map((c) => c.name),
    );
    for (const [name, type] of [
      ["merge_mode", "TEXT NOT NULL DEFAULT 'direct'"],
      ["pr_provider", "TEXT"],
      ["github_owner", "TEXT"],
      ["github_repo", "TEXT"],
      ["github_token_env", "TEXT"],
    ])
      if (!repoColumns.has(name))
        db.exec(`ALTER TABLE repositories ADD COLUMN ${name} ${type}`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS branch_pull_requests(intent_id TEXT NOT NULL,branch_id INTEGER PRIMARY KEY REFERENCES managed_branches(id),requested_by INTEGER NOT NULL REFERENCES users(id),requested_head TEXT NOT NULL,requested_base TEXT NOT NULL,published_head TEXT,number INTEGER,url TEXT,state TEXT NOT NULL DEFAULT 'open',head_commit TEXT NOT NULL,base_commit TEXT NOT NULL,merge_commit TEXT,synced_at TEXT,error TEXT,previous_number INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`,
    );
    if (
      !db
        .prepare("PRAGMA table_info(branch_pull_requests)")
        .all()
        .some((c) => c.name === "intent_id")
    ) {
      db.exec("ALTER TABLE branch_pull_requests ADD COLUMN intent_id TEXT");
      db.exec(
        "UPDATE branch_pull_requests SET intent_id=lower(hex(randomblob(16))) WHERE intent_id IS NULL",
      );
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS repository_credentials(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,encrypted_value TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`,
    );
    const credentialColumns = new Set(
      db
        .prepare("PRAGMA table_info(repositories)")
        .all()
        .map((c) => c.name),
    );
    for (const name of ["git_credential_id", "github_credential_id"])
      if (!credentialColumns.has(name))
        db.exec(
          `ALTER TABLE repositories ADD COLUMN ${name} INTEGER REFERENCES repository_credentials(id)`,
        );
    if (db.prepare("PRAGMA user_version").get().user_version < 11)
      db.exec("PRAGMA user_version=11");
    if (db.prepare("PRAGMA user_version").get().user_version < 10)
      db.exec("PRAGMA user_version=10");
    if (db.prepare("PRAGMA user_version").get().user_version < 8)
      db.exec("PRAGMA user_version=8");
    if (db.prepare("PRAGMA user_version").get().user_version < 7)
      db.exec("PRAGMA user_version=7");
    if (db.prepare("PRAGMA user_version").get().user_version < 6)
      db.exec("PRAGMA user_version=6");
    if (db.prepare("PRAGMA user_version").get().user_version < 5)
      db.exec("PRAGMA user_version=5");
    if (db.prepare("PRAGMA user_version").get().user_version < 4)
      db.exec("PRAGMA user_version=4");
    if (db.prepare("PRAGMA user_version").get().user_version < 3)
      db.exec("PRAGMA user_version=3");
  });
  if (!db.prepare("SELECT 1 FROM statuses").get()) {
    for (const [i, name, color] of [
      [0, "Backlog", "#94a3b8"],
      [1, "Ready", "#8b91f7"],
      [2, "In progress", "#e5ad54"],
      [3, "In review", "#bf8df1"],
      [4, "Done", "#59c9a5"],
    ]) {
      db.prepare("INSERT INTO statuses(name,color,position) VALUES(?,?,?)").run(
        name,
        color,
        i,
      );
    }
  }
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
export function bootstrap(db, env) {
  if (!db.prepare("SELECT 1 FROM users WHERE kind='human'").get()) {
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 10)
      throw new Error(
        "Run npm run setup first: ADMIN_PASSWORD must have at least 10 characters.",
      );
    const user = db
      .prepare(
        "INSERT INTO users(username,name,kind,admin,password,created_at) VALUES(?,?,'human',1,?,?) RETURNING *",
      )
      .get(
        env.ADMIN_USERNAME || "admin",
        env.ADMIN_NAME || "Admin",
        bcrypt.hashSync(env.ADMIN_PASSWORD, 12),
        now(),
      );
    db.prepare(
      "INSERT INTO channels(name,description,created_by,created_at) VALUES(?,?,?,?)",
    ).run("general", "Announcements, ideas, and shared work.", user.id, now());
  }
  for (const [key, name, role] of [
    [
      "SPARK",
      "Spark",
      "A thoughtful engineering teammate. Investigate issues, build solutions, and collaborate with the team.",
    ],
    [
      "SAGE",
      "Sage",
      "A product and review teammate. Clarify requirements, review work, and help the team make decisions.",
    ],
  ]) {
    const credential = env[`AGENT_${key}_TOKEN`];
    if (
      credential &&
      !db.prepare("SELECT 1 FROM users WHERE username=?").get(key.toLowerCase())
    ) {
      const user = db
        .prepare(
          "INSERT INTO users(username,name,kind,token_hash,created_at) VALUES(?,?,'agent',?,?) RETURNING *",
        )
        .get(key.toLowerCase(), name, hash(credential), now());
      db.prepare("INSERT INTO agents(user_id,role) VALUES(?,?)").run(
        user.id,
        role,
      );
      db.prepare(
        "INSERT INTO channel_subscriptions(channel_id,user_id) SELECT id,? FROM channels",
      ).run(user.id);
    }
  }
}
