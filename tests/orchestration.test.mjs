import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "../server/app.mjs";
import { git } from "../server/git.mjs";
import { now, hash } from "../server/db.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-git-")),
  remote = join(dir, "origin.git"),
  seed = join(dir, "seed"),
  clone = join(dir, "clone");
let app, server, url, cookie, repo, branch, spark, sage;
async function api(
  path,
  body,
  identity = "spark-token",
  method = body ? "POST" : "GET",
) {
  const response = await fetch(url + "/api" + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(identity === "human"
        ? { cookie }
        : { authorization: `Bearer ${identity}` }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
async function g(cwd, args, identity = "spark-token") {
  const basic = Buffer.from(`threadwork:${identity}`).toString("base64");
  return git(cwd, [
    "-c",
    `http.extraHeader=Authorization: Basic ${basic}`,
    ...args,
  ]);
}
before(async () => {
  await git(dir, ["init", "--bare", "--initial-branch=main", remote]);
  await git(dir, ["init", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README"), "initial\n");
  await git(seed, ["add", "."]);
  await git(seed, [
    "-c",
    "user.name=Seed",
    "-c",
    "user.email=seed@example.com",
    "commit",
    "-m",
    "Initial",
  ]);
  await git(seed, ["push", remote, "main"]);
  app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "orchestration-test-password",
      AGENT_SPARK_TOKEN: "spark-token",
      AGENT_SAGE_TOKEN: "sage-token",
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "admin",
      password: "orchestration-test-password",
    }),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  const db = app.locals.db;
  spark = db.prepare("SELECT id FROM users WHERE username='spark'").get().id;
  sage = db.prepare("SELECT id FROM users WHERE username='sage'").get().id;
  db.prepare(
    "INSERT INTO threads(channel_id,title,status_id,created_by,created_at,updated_at) VALUES(1,?,1,1,?,?)",
  ).run("Test work", now(), now());
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
test("repository registration, authenticated Git pushes, exact reviews and explicit merge", async () => {
  assert.equal(
    (await api("/repositories", { name: "denied", url: remote })).status,
    403,
  );
  let response = await api(
    "/repositories",
    { name: "Example", url: remote },
    "human",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  repo = response.data;
  assert.equal(repo.credential_env, undefined);
  response = await api(`/repositories/${repo.id}/branches`, {
    name: "feature/one",
    thread_ids: [1],
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  branch = response.data;
  await g(dir, ["clone", `${url}/api/git/${repo.id}.git`, clone]);
  await g(clone, ["checkout", "feature/one"]);
  writeFileSync(join(clone, "feature"), "one\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Feature",
  ]);
  await g(clone, ["push", "origin", "feature/one"]);
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  response = await api(`/branches/${branch.id}`);
  assert.equal(response.data.head_commit, sha);
  assert.equal(
    (
      await api(`/branches/${branch.id}/reviews`, {
        commit: sha,
        decision: "approved",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        `/branches/${branch.id}/reviews`,
        { commit: sha, decision: "approved" },
        "sage-token",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        `/users/${sage}/capabilities`,
        { can_work: true, can_review: true },
        "human",
      )
    ).status,
    200,
  );
  response = await api(
    `/branches/${branch.id}/reviews`,
    { commit: sha, decision: "approved" },
    "sage-token",
  );
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.notEqual(
    await git(remote, ["rev-parse", "main"]),
    sha,
    "approval must not merge",
  );
  assert.equal(
    (await api(`/branches/${branch.id}/merge`, {}, "sage-token")).status,
    403,
  );
  response = await api(`/branches/${branch.id}/merge`, {});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(await git(remote, ["rev-parse", "main"]), sha);
  assert.equal(
    (await api(`/branches/${branch.id}/merge`, {})).status,
    200,
    "merge retry safe",
  );
  const notice = app.locals.db
    .prepare(
      "SELECT n.* FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? AND e.type='branch.reviewed'",
    )
    .get(spark);
  assert.ok(notice, "review notifies worker");
});
test("gateway rejects other writers, main updates, unknown branches, force pushes and stale reviews", async () => {
  let response = await api(`/repositories/${repo.id}/branches`, {
    name: "feature/two",
    thread_ids: [1],
  });
  assert.equal(response.status, 200);
  const b = response.data;
  await g(clone, ["fetch", "origin"]);
  await g(clone, ["checkout", "-b", "feature/two", "origin/feature/two"]);
  writeFileSync(join(clone, "feature"), "two\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Second",
  ]);
  await assert.rejects(
    g(clone, ["push", "origin", "feature/two"], "sage-token"),
  );
  await assert.rejects(g(clone, ["push", "origin", "HEAD:main"]));
  await assert.rejects(g(clone, ["push", "origin", "HEAD:unknown"]));
  await g(clone, ["push", "origin", "feature/two"]);
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: sha, decision: "approved" },
        "sage-token",
      )
    ).status,
    200,
  );
  writeFileSync(join(clone, "feature"), "three\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Third",
  ]);
  await g(clone, ["push", "origin", "feature/two"]);
  assert.equal(
    (await api(`/branches/${b.id}/merge`, {})).status,
    409,
    "new head invalidates approval",
  );
  await git(clone, ["reset", "--hard", sha]);
  await assert.rejects(g(clone, ["push", "--force", "origin", "feature/two"]));
  const handoff = await api(`/branches/${b.id}/handoff`, { owner_id: sage });
  assert.equal(handoff.status, 200);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: handoff.data.head_commit, decision: "approved" },
        "human",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(`/branches/${b.id}/reviews`, {
        commit: handoff.data.head_commit,
        decision: "approved",
      })
    ).status,
    403,
    "former worker cannot self review after handoff",
  );
});
test("human Git credentials expire, dependencies reject cycles, escalation persists and pending merge recovers", async () => {
  const cred = await api("/git-credentials", {}, "human");
  assert.equal(cred.status, 200);
  const auth =
    "Basic " +
    Buffer.from(`${cred.data.username}:${cred.data.token}`).toString("base64");
  assert.equal(
    (
      await fetch(
        `${url}/api/git/${repo.id}.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: auth } },
      )
    ).status,
    200,
  );
  app.locals.db
    .prepare("UPDATE git_credentials SET expires_at=?")
    .run("2000-01-01T00:00:00Z");
  assert.equal(
    (
      await fetch(
        `${url}/api/git/${repo.id}.git/info/refs?service=git-upload-pack`,
        { headers: { authorization: auth } },
      )
    ).status,
    401,
  );
  const a = (await api(`/repositories/${repo.id}/branches`, { name: "deps/a" }))
      .data,
    b = (await api(`/repositories/${repo.id}/branches`, { name: "deps/b" }))
      .data;
  assert.equal(
    (await api(`/branches/${a.id}/dependencies`, { depends_on_id: b.id }))
      .status,
    200,
  );
  assert.equal(
    (await api(`/branches/${b.id}/dependencies`, { depends_on_id: a.id }))
      .status,
    400,
  );
  assert.equal(
    (
      await api(
        `/branches/${a.id}/reviews`,
        { commit: a.head_commit, decision: "approved", require_human: true },
        "sage-token",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        `/branches/${a.id}/reviews`,
        { commit: a.head_commit, decision: "approved", require_human: false },
        "sage-token",
      )
    ).status,
    200,
  );
  assert.match(
    (await api(`/branches/${a.id}/merge`, {})).data.error,
    /Human approval/,
  );
  const db = app.locals.db;
  db.prepare(
    "INSERT INTO git_operations(repository_id,branch_id,actor_id,kind,commit_hash,previous_commit,created_at) VALUES(?,?,?,'merge',?,?,?)",
  ).run(repo.id, b.id, spark, b.head_commit, b.head_commit, now());
  await api(`/branches/${b.id}/merge`, {});
  assert.equal(
    db.prepare("SELECT state FROM managed_branches WHERE id=?").get(b.id).state,
    "merged",
  );
});
test("merge serializes with ownership transfer and a concurrent newer push", async () => {
  const b = (
    await api(`/repositories/${repo.id}/branches`, { name: "concurrent" })
  ).data;
  await g(clone, ["fetch", "origin"]);
  await g(clone, ["checkout", "-b", "concurrent", "origin/concurrent"]);
  writeFileSync(join(clone, "concurrent"), "approved\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Concurrent",
  ]);
  await g(clone, ["push", "origin", "concurrent"]);
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: sha, decision: "approved" },
        "sage-token",
      )
    ).status,
    200,
  );
  const gate = join(dir, "merge-gate"),
    started = join(dir, "merge-started");
  writeFileSync(
    join(remote, "hooks", "pre-receive"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(dir, "wait-hook.mjs")}'\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(dir, "wait-hook.mjs"),
    `import{writeFileSync,existsSync}from'node:fs';writeFileSync(${JSON.stringify(started)},'yes');const end=Date.now()+5000;while(!existsSync(${JSON.stringify(gate)})&&Date.now()<end)await new Promise(r=>setTimeout(r,10));`,
  );
  const merge = api(`/branches/${b.id}/merge`, {});
  const { existsSync } = await import("node:fs");
  for (let i = 0; i < 200 && !existsSync(started); i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(started), "upstream merge began");
  const transfer = api(`/branches/${b.id}/handoff`, { owner_id: sage });
  writeFileSync(join(clone, "concurrent"), "unreviewed\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Unreviewed",
  ]);
  const push = g(clone, ["push", "origin", "concurrent"]).then(
    () => true,
    () => false,
  );
  writeFileSync(gate, "go");
  assert.equal((await merge).status, 200);
  assert.equal((await transfer).status, 409);
  assert.equal(await push, false);
  assert.equal(await git(remote, ["rev-parse", "main"]), sha);
  rmSync(join(remote, "hooks", "pre-receive"));
});
test("restart recovers push attribution and gateway fetch refreshes independently advanced main", async () => {
  const b = (
    await api(`/repositories/${repo.id}/branches`, { name: "restart" })
  ).data;
  await api(`/branches/${b.id}/handoff`, { owner_id: sage });
  const { repoPath } = await import("../server/git.mjs");
  const hub = repoPath(join(dir, "data"), repo.id);
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  await git(hub, ["fetch", clone, sha]);
  await git(hub, ["update-ref", "refs/heads/restart", sha]);
  app.locals.db
    .prepare("INSERT INTO git_push_journal VALUES(?,?)")
    .run(repo.id, sage);
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "orchestration-test-password",
      AGENT_SPARK_TOKEN: "spark-token",
      AGENT_SAGE_TOKEN: "sage-token",
    },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api(`/branches/${b.id}`)).data.head_commit, sha);
  assert.ok(
    app.locals.db
      .prepare(
        "SELECT 1 FROM branch_contributors WHERE branch_id=? AND user_id=?",
      )
      .get(b.id, sage),
  );
  await api(`/branches/${b.id}/handoff`, { owner_id: 1 }, "human");
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: sha, decision: "approved" },
        "sage-token",
      )
    ).status,
    403,
  );
  const inspected = (
    await api(`/repositories/${repo.id}/branches`, { name: "inspected-target" })
  ).data;
  const oldTarget = (await api(`/branches/${inspected.id}/diff`)).data
    .target_commit;
  await git(seed, ["fetch", remote, "main"]);
  await git(seed, ["reset", "--hard", "FETCH_HEAD"]);
  writeFileSync(join(seed, "upstream"), "external\n");
  await git(seed, ["add", "."]);
  await git(seed, [
    "-c",
    "user.name=External",
    "-c",
    "user.email=external@example.com",
    "commit",
    "-m",
    "External main",
  ]);
  await git(seed, ["push", remote, "main"]);
  const advanced = await git(seed, ["rev-parse", "HEAD"]);
  await g(clone, ["fetch", `${url}/api/git/${repo.id}.git`, "main"]);
  assert.equal(await git(clone, ["rev-parse", "FETCH_HEAD"]), advanced);
  assert.equal(
    (
      await api(
        `/branches/${inspected.id}/reviews`,
        {
          commit: inspected.head_commit,
          target_commit: oldTarget,
          decision: "approved",
        },
        "sage-token",
      )
    ).status,
    409,
    "reject approval after inspected main target moves",
  );
  assert.equal(
    (
      await api(
        `/repositories/${repo.id}`,
        { require_human: true },
        "human",
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await api("/repositories")).data[0].require_human, 1);
});
