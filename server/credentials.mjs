import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { transaction, now } from "./db.mjs";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const metadata = "id,name,created_at,updated_at";
const aad = (id) => Buffer.from(`threadwork.repository-credential.v1:${id}`);
export function createCredentialStore({ db, dataDir }) {
  const keyPath = join(dataDir, "credentials.key");
  const cache = new Map();
  const known = new Set();
  function remember(value) {
    known.add(value);
    while (known.size > 256) known.delete(known.values().next().value);
  }
  function key(create = false) {
    try {
      if (!existsSync(keyPath)) {
        if (
          !create ||
          db.prepare("SELECT 1 FROM repository_credentials LIMIT 1").get()
        )
          fail(
            503,
            "Stored credential encryption key is missing. Restore credentials.key with its matching database.",
          );
        let fd;
        try {
          fd = openSync(
            keyPath,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              (constants.O_NOFOLLOW || 0),
            0o600,
          );
          writeFileSync(fd, randomBytes(32));
          fsyncSync(fd);
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
        const dir = openSync(dataDir, "r");
        try {
          fsyncSync(dir);
        } finally {
          closeSync(dir);
        }
      }
      if (!lstatSync(keyPath).isFile() || lstatSync(keyPath).isSymbolicLink())
        fail(
          503,
          "Stored credential encryption key is invalid. Restore the original credentials.key.",
        );
      const fd = openSync(
        keyPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
      );
      let value;
      try {
        value = readFileSync(fd);
      } finally {
        closeSync(fd);
      }
      if (value.length !== 32)
        fail(
          503,
          "Stored credential encryption key is invalid. Restore the original credentials.key.",
        );
      chmodSync(keyPath, 0o600);
      return value;
    } catch (error) {
      if (error.status) throw error;
      fail(
        503,
        "Cannot read or persist the credential encryption key. Check server-volume access and restore the matching credentials.key if needed.",
      );
    }
  }
  function decrypt(row, master = key()) {
    const prior = cache.get(row.id);
    if (prior?.ciphertext === row.encrypted_value && prior.key.equals(master))
      return prior.value;
    try {
      const envelope = JSON.parse(row.encrypted_value);
      if (
        envelope.v !== 1 ||
        typeof envelope.iv !== "string" ||
        typeof envelope.tag !== "string" ||
        typeof envelope.ciphertext !== "string"
      )
        throw new Error();
      const iv = Buffer.from(envelope.iv, "base64"),
        tag = Buffer.from(envelope.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const cipher = createDecipheriv("aes-256-gcm", master, iv);
      cipher.setAAD(aad(row.id));
      cipher.setAuthTag(tag);
      const value = Buffer.concat([
        cipher.update(Buffer.from(envelope.ciphertext, "base64")),
        cipher.final(),
      ]).toString("utf8");
      cache.set(row.id, {
        ciphertext: row.encrypted_value,
        key: master,
        value,
      });
      remember(value);
      return value;
    } catch {
      fail(
        503,
        "Cannot decrypt stored credentials. Restore credentials.key with its matching database; stored values were not replaced.",
      );
    }
  }
  function encrypt(id, value, master) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", master, iv);
    cipher.setAAD(aad(id));
    const ciphertext = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    });
  }
  function row(id) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1)
      fail(400, "Invalid credential identifier");
    return (
      db
        .prepare("SELECT * FROM repository_credentials WHERE id=?")
        .get(Number(id)) || fail(404, "Saved credential not found")
    );
  }
  function validateName(value, except) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100)
      fail(400, "Credential name must contain 1–100 characters");
    const name = value.trim();
    if (
      db
        .prepare(
          "SELECT 1 FROM repository_credentials WHERE lower(name)=lower(?) AND id!=?",
        )
        .get(name, except || 0)
    )
      fail(409, "A credential with that name already exists");
    return name;
  }
  function validateValue(value) {
    if (
      typeof value !== "string" ||
      value.length < 8 ||
      value.length > 16384 ||
      /[\r\n\0]/.test(value)
    )
      fail(
        400,
        "Enter a token containing 8–16384 characters without line breaks",
      );
    return value;
  }
  // Existing rows require the original key and valid authenticated ciphertext.
  // Never silently regenerate a key for an existing encrypted database.
  if (existsSync(keyPath)) key();
  const initial = db.prepare("SELECT * FROM repository_credentials").all();
  if (initial.length) {
    const master = key();
    for (const entry of initial) decrypt(entry, master);
  }
  return {
    list() {
      return db
        .prepare(
          `SELECT ${metadata} FROM repository_credentials ORDER BY name COLLATE NOCASE,id`,
        )
        .all();
    },
    create({ name, value }) {
      name = validateName(name);
      value = validateValue(value);
      const master = key(true);
      const result = transaction(db, () => {
        const stamp = now();
        const saved = db
          .prepare(
            "INSERT INTO repository_credentials(name,encrypted_value,created_at,updated_at) VALUES(?,'',?,?) RETURNING id",
          )
          .get(name, stamp, stamp);
        db.prepare(
          "UPDATE repository_credentials SET encrypted_value=? WHERE id=?",
        ).run(encrypt(saved.id, value, master), saved.id);
        return db
          .prepare(`SELECT ${metadata} FROM repository_credentials WHERE id=?`)
          .get(saved.id);
      });
      remember(value);
      return result;
    },
    update(id, input) {
      const existing = row(id);
      if (input.name === undefined && input.value === undefined)
        fail(400, "Provide a name or replacement token");
      const name =
        input.name === undefined
          ? existing.name
          : validateName(input.name, existing.id);
      const master = key(),
        previous = decrypt(existing, master);
      const value =
        input.value === undefined ? previous : validateValue(input.value);
      const result = transaction(db, () =>
        db
          .prepare(
            `UPDATE repository_credentials SET name=?,encrypted_value=?,updated_at=? WHERE id=? RETURNING ${metadata}`,
          )
          .get(name, encrypt(existing.id, value, master), now(), existing.id),
      );
      remember(previous);
      remember(value);
      cache.delete(existing.id);
      return result;
    },
    remove(id) {
      const existing = row(id);
      return transaction(db, () => {
        if (
          db
            .prepare(
              "SELECT 1 FROM repositories WHERE git_credential_id=? OR github_credential_id=? LIMIT 1",
            )
            .get(existing.id, existing.id)
        )
          fail(
            409,
            "Credential is used by a repository. Select a replacement before deleting it.",
          );
        remember(decrypt(existing));
        db.prepare("DELETE FROM repository_credentials WHERE id=?").run(
          existing.id,
        );
        cache.delete(existing.id);
        return { ok: true };
      });
    },
    resolve(id) {
      return decrypt(row(id));
    },
    redact(value) {
      const rows = db.prepare("SELECT * FROM repository_credentials").all();
      if (rows.length) {
        const master = key();
        for (const entry of rows) decrypt(entry, master);
      }
      const secrets = [
        ...new Set(
          [...known, ...cache.values()].map((entry) =>
            typeof entry === "string" ? entry : entry.value,
          ),
        ),
      ].sort((a, b) => b.length - a.length);
      const clean = (text) => {
        for (const secret of secrets) {
          if (text === secret) return "[redacted]";
          if (secret.length < 8) continue;
          text = text.split(secret).join("[redacted]");
          const escaped = JSON.stringify(secret).slice(1, -1);
          if (escaped !== secret) text = text.split(escaped).join("[redacted]");
        }
        return text;
      };
      const visit = (entry) =>
        typeof entry === "string"
          ? clean(entry)
          : Array.isArray(entry)
            ? entry.map(visit)
            : entry && typeof entry === "object"
              ? Object.fromEntries(
                  Object.entries(entry).map(([name, child]) => [
                    clean(name),
                    visit(child),
                  ]),
                )
              : entry;
      return visit(value);
    },
  };
}
