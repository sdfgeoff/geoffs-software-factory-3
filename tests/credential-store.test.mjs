import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openDatabase } from "../server/db.mjs";
import { createCredentialStore } from "../server/credentials.mjs";

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "threadwork-vault-"));
  const db = openDatabase(join(dir, "board.sqlite"));
  try {
    run({ dir, db, store: createCredentialStore({ db, dataDir: dir }) });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("vault persists authenticated ciphertext, rotates nonce, and restores with its matching key", () =>
  fixture(({ dir, db, store }) => {
    const value = 'test-secret-with-"quotes"-and-\\slashes';
    assert.throws(() => store.create({ name: "Short", value: "hunter2" }), {
      status: 400,
    });
    const item = store.create({ name: "Git token", value });
    assert.deepEqual(Object.keys(item).sort(), [
      "created_at",
      "id",
      "name",
      "updated_at",
    ]);
    assert.equal(statSync(join(dir, "credentials.key")).mode & 0o777, 0o600);
    const first = db
      .prepare("SELECT encrypted_value FROM repository_credentials WHERE id=?")
      .get(item.id).encrypted_value;
    assert.ok(!first.includes(value));
    assert.equal(
      createCredentialStore({ db, dataDir: dir }).resolve(item.id),
      value,
    );
    store.update(item.id, { value });
    const second = db
      .prepare("SELECT encrypted_value FROM repository_credentials WHERE id=?")
      .get(item.id).encrypted_value;
    assert.notEqual(first, second);
    const replacement = "rotated-test-token-value";
    store.update(item.id, { value: replacement });
    assert.equal(store.resolve(item.id), replacement);
    const cleaned = store.redact({
      text: `old ${value} new ${replacement}`,
      nested: [value],
      escaped: JSON.stringify(value),
      [replacement]: value,
    });
    const serialized = JSON.stringify(cleaned);
    assert.ok(!serialized.includes(replacement));
    assert.ok(!serialized.includes("slashes"));
    assert.equal(cleaned.nested[0], "[redacted]");
    assert.equal(cleaned["[redacted]"], "[redacted]");
    assert.throws(
      () => store.create({ name: "gIT TOKEN", value: "other-token" }),
      { status: 409 },
    );
  }));

test("missing, mismatched, and malformed keys fail without replacing encrypted records", () =>
  fixture(({ dir, db, store }) => {
    const item = store.create({
      name: "API",
      value: "vault-persistence-test-token",
    });
    const keyPath = join(dir, "credentials.key"),
      original = readFileSync(keyPath);
    const ciphertext = db
      .prepare("SELECT encrypted_value FROM repository_credentials WHERE id=?")
      .get(item.id).encrypted_value;
    unlinkSync(keyPath);
    assert.throws(() => store.resolve(item.id), { status: 503 });
    assert.throws(() => createCredentialStore({ db, dataDir: dir }), {
      status: 503,
    });
    assert.throws(
      () => store.create({ name: "Another", value: "another-test-token" }),
      { status: 503 },
    );
    writeFileSync(keyPath, randomBytes(32));
    const wrong = readFileSync(keyPath);
    assert.throws(() => store.resolve(item.id), { status: 503 });
    assert.throws(() => createCredentialStore({ db, dataDir: dir }), {
      status: 503,
    });
    assert.deepEqual(readFileSync(keyPath), wrong);
    writeFileSync(keyPath, "broken");
    assert.throws(() => createCredentialStore({ db, dataDir: dir }), {
      status: 503,
    });
    writeFileSync(keyPath, original);
    assert.equal(
      createCredentialStore({ db, dataDir: dir }).resolve(item.id),
      "vault-persistence-test-token",
    );
    assert.equal(
      db
        .prepare(
          "SELECT encrypted_value FROM repository_credentials WHERE id=?",
        )
        .get(item.id).encrypted_value,
      ciphertext,
    );
  }));

test("ciphertext cannot be swapped between credential identities or modified", () =>
  fixture(({ db, store }) => {
    const a = store.create({ name: "One", value: "first-vault-token" });
    const b = store.create({ name: "Two", value: "second-vault-token" });
    const original = db
      .prepare("SELECT encrypted_value FROM repository_credentials WHERE id=?")
      .get(a.id).encrypted_value;
    db.prepare(
      "UPDATE repository_credentials SET encrypted_value=? WHERE id=?",
    ).run(original, b.id);
    assert.throws(() => store.resolve(b.id), { status: 503 });
    const tampered = JSON.parse(original);
    tampered.tag = Buffer.alloc(16).toString("base64");
    db.prepare(
      "UPDATE repository_credentials SET encrypted_value=? WHERE id=?",
    ).run(JSON.stringify(tampered), a.id);
    assert.throws(() => store.resolve(a.id), { status: 503 });
  }));
