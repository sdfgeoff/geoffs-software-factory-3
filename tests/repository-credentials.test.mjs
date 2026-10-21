import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";
import { createCredentialStore } from "../server/credentials.mjs";
import { upstreamEnv } from "../server/git.mjs";
import { githubClient, validateGithubRepository } from "../server/github.mjs";
import { now } from "../server/db.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-credentials-")),
  env = {
    ADMIN_PASSWORD: "credentials-test-password",
    AGENT_SPARK_TOKEN: "credentials-agent-token",
    LEGACY_GITHUB: "legacy-server-github-token",
  };
let app, server, url, cookie, personCookie, credential;
async function start() {
  app = createApp({ dataDir: dir, env });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
}
async function api(
  path,
  body,
  who = "admin",
  method = body ? "POST" : "GET",
  headers = {},
) {
  const r = await fetch(url + "/api" + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who === "admin"
        ? { cookie }
        : who === "person"
          ? { cookie: personCookie }
          : { authorization: `Bearer ${env.AGENT_SPARK_TOKEN}` }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
async function login(username) {
  const r = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: env.ADMIN_PASSWORD }),
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
before(async () => {
  await start();
  cookie = await login("admin");
  const admin = app.locals.db
    .prepare("SELECT * FROM users WHERE username='admin'")
    .get();
  app.locals.db
    .prepare(
      "INSERT INTO users(username,name,kind,password,created_at) VALUES('viewer','Viewer','human',?,?)",
    )
    .run(admin.password, now());
  personCookie = await login("viewer");
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
test("credential management is admin-only and values never appear in responses, mutation retry caches, or stored ciphertext", async () => {
  for (const who of ["spark", "person"]) {
    assert.equal(
      (await api("/admin/repository-credentials", undefined, who)).status,
      403,
    );
    assert.equal(
      (
        await api(
          "/admin/repository-credentials",
          { name: "Denied", value: "denied-secret-value" },
          who,
        )
      ).status,
      403,
    );
  }
  const secret = "vault-integration-original-secret";
  const result = await api(
    "/admin/repository-credentials",
    { name: "Shared GitHub token", value: secret },
    "admin",
    "POST",
    { "idempotency-key": "credential-create-test" },
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  credential = result.data;
  assert.deepEqual(Object.keys(credential).sort(), [
    "created_at",
    "id",
    "name",
    "updated_at",
  ]);
  assert.equal(credential.name, "Shared GitHub token");
  assert.equal(
    (await api("/admin/repository-credentials")).data[0].id,
    credential.id,
  );
  const row = app.locals.db
    .prepare("SELECT * FROM repository_credentials WHERE id=?")
    .get(credential.id);
  assert.ok(row.encrypted_value);
  assert.equal(JSON.stringify(row).includes(secret), false);
  assert.equal(
    app.locals.db
      .prepare("SELECT count(*) AS n FROM mutations WHERE key LIKE ?")
      .get("%credential-create-test").n,
    0,
    "credential values and operations never enter retry caches",
  );
  assert.equal(
    readFileSync(join(dir, "threadwork.sqlite")).includes(Buffer.from(secret)),
    false,
  );
  assert.equal(statSync(join(dir, "credentials.key")).mode & 0o777, 0o600);
  const rotated = await api(
    `/admin/repository-credentials/${credential.id}`,
    { name: "Rotated GitHub token", value: "vault-integration-rotated-secret" },
    "admin",
    "PATCH",
  );
  assert.equal(rotated.status, 200);
  for (const who of ["spark", "person"]) {
    assert.equal(
      (
        await api(
          `/admin/repository-credentials/${credential.id}`,
          { value: "denied-replacement-token" },
          who,
          "PATCH",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await api(
          `/admin/repository-credentials/${credential.id}`,
          undefined,
          who,
          "DELETE",
        )
      ).status,
      403,
    );
  }
  const unused = (
    await api("/admin/repository-credentials", {
      name: "Temporary unused",
      value: "temporary-unused-token",
    })
  ).data;
  assert.deepEqual(
    (
      await api(
        `/admin/repository-credentials/${unused.id}`,
        undefined,
        "admin",
        "DELETE",
      )
    ).data,
    { ok: true },
  );
  const next = (
    await api("/admin/repository-credentials", {
      name: "Next unused",
      value: "next-unused-token",
    })
  ).data;
  assert.ok(
    next.id > unused.id,
    "deleted credential identifiers are never reused",
  );
  await api(
    `/admin/repository-credentials/${next.id}`,
    undefined,
    "admin",
    "DELETE",
  );

  assert.deepEqual(Object.keys(rotated.data).sort(), [
    "created_at",
    "id",
    "name",
    "updated_at",
  ]);
  assert.equal(
    JSON.stringify(rotated.data).includes("vault-integration-rotated-secret"),
    false,
  );
});
test("saved tokens resolve dynamically for HTTPS Git and GitHub API with no fallback after a selected ID fails", async () => {
  const store = createCredentialStore({ db: app.locals.db, dataDir: dir });
  const resolve = (id) => store.resolve(id);
  const r = {
    url: "https://github.com/example/project.git",
    merge_mode: "pull_request",
    pr_provider: "github",
    main_branch: "main",
    github_owner: "example",
    github_repo: "project",
    github_credential_id: credential.id,
    git_credential_id: credential.id,
    credential_env: "LEGACY_GITHUB",
    github_token_env: "LEGACY_GITHUB",
  };
  assert.doesNotThrow(() => validateGithubRepository(r, env, resolve));
  let auth = upstreamEnv(r, env, resolve).GIT_CONFIG_VALUE_0;
  assert.equal(
    Buffer.from(auth.replace("Authorization: Basic ", ""), "base64").toString(),
    "x-access-token:vault-integration-rotated-secret",
  );
  const headers = [];
  const response = {
    number: 1,
    html_url: "https://github.com/example/project/pull/1",
    state: "open",
    merged: false,
    head: {
      ref: "work",
      sha: "a".repeat(40),
      repo: { full_name: "example/project" },
    },
    base: {
      ref: "main",
      sha: "b".repeat(40),
      repo: { full_name: "example/project" },
    },
  };
  const client = githubClient(
    r,
    env,
    async (url, options) => {
      headers.push(options.headers.Authorization);
      return Response.json(response);
    },
    undefined,
    resolve,
  );
  await client.get(1, { name: "work" });
  assert.equal(headers.at(-1), "Bearer vault-integration-rotated-secret");
  await api(
    `/admin/repository-credentials/${credential.id}`,
    { value: "vault-integration-latest-secret" },
    "admin",
    "PATCH",
  );
  await client.get(1, { name: "work" });
  assert.equal(headers.at(-1), "Bearer vault-integration-latest-secret");
  auth = upstreamEnv(r, env, resolve).GIT_CONFIG_VALUE_0;
  assert.ok(
    Buffer.from(auth.replace("Authorization: Basic ", ""), "base64")
      .toString()
      .endsWith("vault-integration-latest-secret"),
  );
  assert.throws(
    () =>
      upstreamEnv(
        { ...r, url: "git@github.com:example/project.git" },
        env,
        resolve,
      ),
    /HTTPS/,
  );
  assert.throws(() =>
    upstreamEnv({ ...r, git_credential_id: 999999 }, env, resolve),
  );
  await assert.rejects(
    githubClient(
      { ...r, github_credential_id: 999999 },
      env,
      async () => {
        throw Error("must not fallback to legacy");
      },
      undefined,
      resolve,
    ).get(1, { name: "work" }),
  );
});
test("repository credential repair succeeds before broken Git initialization/recovery, references guard deletion, and public output hides secrets", async () => {
  const db = app.locals.db;
  const stamp = now();
  const r = db
    .prepare(
      "INSERT INTO repositories(name,url,main_branch,credential_env,merge_mode,pr_provider,github_owner,github_repo,github_token_env,created_by,created_at) VALUES('Broken remote','https://github.com/example/project.git','main','MISSING_OLD_GIT_TOKEN','pull_request','github','example','project','MISSING_OLD_API_TOKEN',1,?) RETURNING *",
    )
    .get(stamp);
  // A missing hub and pending Git intent would make withRepo fetch with the old
  // invalid credentials. Administrative credential repair must not do so.
  const spark = db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  const b = db
    .prepare(
      "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(?,'repair',?,?,?) RETURNING *",
    )
    .get(r.id, spark, "a".repeat(40), stamp);
  db.prepare(
    "INSERT INTO git_operations(repository_id,branch_id,actor_id,kind,commit_hash,previous_commit,created_at) VALUES(?,?,?,'merge',?,?,?)",
  ).run(r.id, b.id, spark, "a".repeat(40), "b".repeat(40), stamp);
  const repaired = await api(
    `/repositories/${r.id}`,
    {
      git_credential_id: credential.id,
      github_credential_id: credential.id,
      require_human: false,
      credential_env: null,
      github_token_env: null,
    },
    "admin",
    "PATCH",
  );
  assert.equal(repaired.status, 200, JSON.stringify(repaired.data));
  assert.equal(repaired.data.git_credential_id, credential.id);
  assert.equal(repaired.data.github_credential_id, credential.id);
  assert.equal(repaired.data.credential_configured, true);
  assert.equal(repaired.data.github_token_configured, true);
  for (const field of [
    "credential_env",
    "github_token_env",
    "encrypted_value",
    "value",
  ])
    assert.equal(repaired.data[field], undefined);
  assert.equal(
    (
      await api(
        `/admin/repository-credentials/${credential.id}`,
        undefined,
        "admin",
        "DELETE",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await api(
        `/repositories/${r.id}`,
        { git_credential_id: 999999 },
        "admin",
        "PATCH",
      )
    ).status,
    404,
  );
  db.prepare(
    "UPDATE repositories SET url='git@github.com:example/project.git' WHERE id=?",
  ).run(r.id);
  assert.equal(
    (
      await api(
        `/repositories/${r.id}`,
        { git_credential_id: credential.id },
        "admin",
        "PATCH",
      )
    ).status,
    400,
    "SSH cannot select HTTP Git token",
  );
  const sshApi = await api(
    `/repositories/${r.id}`,
    { git_credential_id: null },
    "admin",
    "PATCH",
  );
  assert.equal(sshApi.status, 200);
  assert.equal(
    sshApi.data.github_credential_id,
    credential.id,
    "SSH can independently use a saved GitHub API token",
  );
});
test("activity ingestion redacts current vault token values and a restart preserves encrypted credentials", async () => {
  const agent = app.locals.db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  const instance = randomUUID();
  await api(
    "/worker/heartbeat",
    { instance_id: instance, state: "idle" },
    "spark",
  );
  const e = {
    event_id: randomUUID(),
    session_id: null,
    turn_id: null,
    item_id: null,
    type: "worker/log",
    occurred_at: now(),
    payload: {
      level: "info",
      message: "opaque output vault-integration-latest-secret",
    },
  };
  const r = await api("/worker/activity", { events: [e] }, "spark", "POST", {
    "x-worker-instance": instance,
  });
  assert.equal(r.status, 200);
  const logged = await api(
    "/worker/log",
    {
      level: "info",
      message: "runtime output vault-integration-latest-secret",
    },
    "spark",
    "POST",
    { "x-worker-instance": instance },
  );
  assert.equal(logged.status, 200);
  assert.equal(
    app.locals.db
      .prepare(
        "SELECT message FROM agent_logs WHERE agent_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(agent)
      .message.includes("vault-integration-latest-secret"),
    false,
  );
  const payload = app.locals.db
    .prepare("SELECT payload FROM agent_activity WHERE event_id=?")
    .get(e.event_id).payload;
  assert.equal(payload.includes("vault-integration-latest-secret"), false);
  assert.match(payload, /redacted/i);
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  await start();
  const store = createCredentialStore({ db: app.locals.db, dataDir: dir });
  assert.equal(store.resolve(credential.id), "vault-integration-latest-secret");
  const output = (await api("/admin/repository-credentials")).data;
  assert.equal(output[0].id, credential.id);
  assert.equal(
    JSON.stringify(output).includes("vault-integration-latest-secret"),
    false,
  );
});
test("schema10 migration adds nullable credential references and preserves existing environment-backed repositories", async () => {
  const { openDatabase, bootstrap } = await import("../server/db.mjs");
  const path = join(dir, "migration", "board.sqlite");
  let db = openDatabase(path);
  bootstrap(db, env);
  db.prepare(
    "INSERT INTO repositories(name,url,main_branch,credential_env,github_token_env,created_by,created_at) VALUES('Legacy','https://github.com/example/project.git','main','LEGACY_GIT','LEGACY_GITHUB',1,?)",
  ).run(now());
  for (const column of ["git_credential_id", "github_credential_id"])
    db.exec(`ALTER TABLE repositories DROP COLUMN ${column}`);
  db.exec("DROP TABLE repository_credentials;PRAGMA user_version=10");
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
    const r = db.prepare("SELECT * FROM repositories").get();
    assert.equal(r.credential_env, "LEGACY_GIT");
    assert.equal(r.github_token_env, "LEGACY_GITHUB");
    assert.equal(r.git_credential_id, null);
    assert.equal(r.github_credential_id, null);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM repository_credentials").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
