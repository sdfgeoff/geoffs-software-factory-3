import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, bootstrap } from "../server/db.mjs";

test("schema 3 upgrade preserves accounts, sessions, conversations and reminders and creates orchestration tables idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-upgrade-")),
    path = join(dir, "database.sqlite");
  let db;
  try {
    db = openDatabase(path);
    bootstrap(db, {
      ADMIN_PASSWORD: "migration-admin-password",
      AGENT_SPARK_TOKEN: "migration-agent",
    });
    db.exec(`INSERT INTO sessions VALUES('retained-session',1,'2099-01-01T00:00:00Z');
   INSERT INTO threads VALUES(1,1,'Retained thread','Discussion',1,NULL,1,'stamp','stamp');
   INSERT INTO replies VALUES(1,1,1,'Retained reply','stamp',NULL);
   INSERT INTO notification_schedules(user_id,message,due_at,created_at) VALUES(1,'Retained reminder','2099-01-01T00:00:00Z','stamp');`);
    // Remove every orchestration table to recreate the pre-orchestration schema.
    db.exec("PRAGMA foreign_keys=OFF");
    for (const table of [
      "git_push_journal",
      "git_operations",
      "git_credentials",
      "branch_dependencies",
      "branch_reviews",
      "branch_threads",
      "branch_contributors",
      "managed_branches",
      "repositories",
      "work_capabilities",
    ])
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec("PRAGMA user_version=3");
    db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      db = openDatabase(path);
      assert.equal(db.prepare("PRAGMA user_version").get().user_version, 8);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM users").get().n, 2);
      assert.equal(
        db.prepare("SELECT token_hash FROM sessions").get().token_hash,
        "retained-session",
      );
      assert.equal(
        db.prepare("SELECT body FROM replies").get().body,
        "Retained reply",
      );
      assert.equal(
        db.prepare("SELECT message FROM notification_schedules").get().message,
        "Retained reminder",
      );
      for (const table of [
        "repositories",
        "managed_branches",
        "branch_reviews",
        "branch_contributors",
        "git_operations",
        "git_push_journal",
      ])
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      db.close();
      db = null;
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
