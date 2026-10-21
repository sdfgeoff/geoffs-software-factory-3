import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { git, repoPath } from "../server/git.mjs";
import { validateGithubRepository, githubClient } from "../server/github.mjs";
import { now } from "../server/db.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-pr-")),
  dataDir = join(dir, "data"),
  remote = join(dir, "origin.git"),
  seed = join(dir, "seed");
const env = {
  ADMIN_PASSWORD: "pr-test-password",
  AGENT_SPARK_TOKEN: "pr-spark-token",
  AGENT_SAGE_TOKEN: "pr-sage-token",
  GH_API_TOKEN: "server-only-github-secret",
  GH_ROTATED_TOKEN: "rotated-server-only-secret",
};
let app, server, url, cookie, repo, spark, sage;
const prs = new Map(),
  calls = [];
let nextNumber = 1,
  loseCreate = false,
  wrongIdentity = false,
  providerDenied = false;
async function githubFetch(input, options) {
  const u = new URL(input);
  assert.equal(u.origin, "https://api.github.com");
  assert.equal(options.redirect, "error");
  assert.ok(options.signal);
  calls.push({
    url: u.href,
    method: options.method,
    body: options.body ? JSON.parse(options.body) : null,
    authorization: options.headers.Authorization,
  });
  if (providerDenied)
    return new Response(
      JSON.stringify({ message: `credential leak ${env.GH_API_TOKEN}` }),
      { status: 403 },
    );
  if (u.pathname.endsWith("/pulls") && options.method === "GET")
    return Response.json(
      [...prs.values()].filter(
        (p) =>
          `${p.head.repo.owner.login}:${p.head.ref}` ===
            u.searchParams.get("head") &&
          p.base.ref === u.searchParams.get("base"),
      ),
    );
  if (u.pathname.endsWith("/pulls") && options.method === "POST") {
    const body = JSON.parse(options.body);
    const sha = await git(remote, ["rev-parse", `refs/heads/${body.head}`]),
      base = await git(remote, ["rev-parse", `refs/heads/${body.base}`]);
    const number = nextNumber++;
    const p = {
      number,
      html_url: `https://github.com/example/project/pull/${number}`,
      state: "open",
      merged: false,
      merge_commit_sha: null,
      created_at: now(),
      body: body.body,
      head: {
        ref: body.head,
        sha,
        repo: { full_name: "example/project", owner: { login: "example" } },
      },
      base: {
        ref: body.base,
        sha: base,
        repo: { full_name: "example/project" },
      },
    };
    prs.set(number, p);
    if (loseCreate) {
      loseCreate = false;
      throw new Error("response lost after GitHub created pull request");
    }
    return Response.json(p, { status: 201 });
  }
  const number = Number(u.pathname.split("/").at(-1)),
    p = prs.get(number);
  if (!p) return new Response("{}", { status: 404 });
  if (p.autoHead)
    p.head.sha = await git(remote, ["rev-parse", `refs/heads/${p.head.ref}`]);
  return Response.json(wrongIdentity ? { ...p, number: p.number + 100 } : p);
}
async function start() {
  app = createApp({ dataDir, env, githubFetch });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
}
async function api(
  path,
  body,
  who = "spark",
  method = body ? "POST" : "GET",
  headers = {},
) {
  const r = await fetch(url + "/api" + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(who === "human"
        ? { cookie }
        : {
            authorization: `Bearer ${who === "spark" ? env.AGENT_SPARK_TOKEN : env.AGENT_SAGE_TOKEN}`,
          }),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
async function feature(name) {
  const response = await api(`/repositories/${repo.id}/branches`, { name });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const b = response.data;
  const work = join(dir, name.replaceAll("/", "-"));
  await git(dir, ["clone", remote, work]);
  await git(work, ["checkout", "-b", name]);
  writeFileSync(join(work, "feature"), name + "\n");
  await git(work, ["add", "."]);
  await git(work, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    name,
  ]);
  const head = await git(work, ["rev-parse", "HEAD"]);
  await git(repoPath(dataDir, repo.id), [
    "fetch",
    work,
    `${head}:refs/heads/${name}`,
  ]);
  await api(`/branches/${b.id}`);
  const review = await api(
    `/branches/${b.id}/reviews`,
    { commit: head, decision: "approved" },
    "sage",
  );
  assert.equal(review.status, 200, JSON.stringify(review.data));
  return { ...b, head_commit: head, work };
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
  await start();
  const login = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: env.ADMIN_PASSWORD }),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  spark = app.locals.db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  sage = app.locals.db
    .prepare("SELECT id FROM users WHERE username='sage'")
    .get().id;
  await api(
    `/users/${sage}/capabilities`,
    { can_work: true, can_review: true },
    "human",
  );
  repo = (
    await api(
      "/repositories",
      { name: "Pull requests", url: remote, merge_mode: "direct" },
      "human",
    )
  ).data;
  // The real Git transport remains a local bare fixture. Configure policy through
  // the public API against its actual GitHub identity, then restore only transport.
  app.locals.db
    .prepare("UPDATE repositories SET url=? WHERE id=?")
    .run("git@github.com:example/project.git", repo.id);
  const policy = await api(
    `/repositories/${repo.id}`,
    {
      merge_mode: "pull_request",
      pr_provider: "github",
      github_owner: "example",
      github_repo: "project",
      github_token_env: "GH_API_TOKEN",
    },
    "human",
    "PATCH",
  );
  assert.equal(policy.status, 200, JSON.stringify(policy.data));
  app.locals.db
    .prepare("UPDATE repositories SET url=? WHERE id=?")
    .run(remote, repo.id);
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
test("repository policy validation, public credential privacy, and explicit reviewed PR creation leave main unchanged", async () => {
  const valid = {
    merge_mode: "pull_request",
    pr_provider: "github",
    github_owner: "example",
    github_repo: "project",
    github_token_env: "GH_API_TOKEN",
  };
  for (const url of [
    "https://github.com/example/project.git",
    "git@github.com:example/project.git",
    "ssh://git@github.com/example/project.git",
  ])
    assert.doesNotThrow(() => validateGithubRepository({ ...valid, url }, env));
  for (const url of [
    "https://evil.example/example/project.git",
    "https://github.com/other/project.git",
    "https://github.com/example/project.git?token=x",
    "https://user:secret@github.com/example/project.git",
  ])
    assert.throws(() => validateGithubRepository({ ...valid, url }, env));
  assert.throws(() =>
    validateGithubRepository(
      {
        ...valid,
        url: "https://github.com/example/project",
        github_token_env: "MISSING",
      },
      env,
    ),
  );
  assert.doesNotThrow(() =>
    validateGithubRepository(
      {
        ...valid,
        github_repo: ".github",
        url: "git@github.com:example/.github.git",
      },
      env,
    ),
  );
  const repository = (await api("/repositories")).data[0];
  assert.equal(repository.merge_mode, "pull_request");
  assert.equal(repository.github_token_configured, true);
  assert.equal(repository.github_token_env, undefined);
  assert.equal(repository.credential_env, undefined);
  const b = await feature("pr/one"),
    before = await git(remote, ["rev-parse", "main"]);
  assert.equal((await api(`/branches/${b.id}/merge`, {}, "sage")).status, 403);
  const result = await api(`/branches/${b.id}/merge`, {});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.state, "active");
  assert.equal(result.data.pull_request.state, "open");
  assert.equal(result.data.pull_request.head_commit, b.head_commit);
  assert.equal(await git(remote, ["rev-parse", "main"]), before);
  assert.equal(await git(remote, ["rev-parse", "pr/one"]), b.head_commit);
  assert.equal(
    app.locals.db
      .prepare("SELECT count(*) AS n FROM git_operations WHERE kind='merge'")
      .get().n,
    0,
  );
  assert.equal(
    calls.some((c) => /\/merge$/.test(new URL(c.url).pathname)),
    false,
    "never invokes GitHub merge API",
  );
  assert.equal(calls.filter((c) => c.method === "POST").length, 1);
  await api(`/branches/${b.id}/merge`, {});
  assert.equal(
    calls.filter((c) => c.method === "POST").length,
    1,
    "same branch reuses current PR",
  );
  assert.equal(
    (
      await api(
        `/repositories/${repo.id}`,
        { merge_mode: "direct" },
        "human",
        "PATCH",
      )
    ).status,
    409,
    "cannot switch mode with an open PR",
  );
});
test("lost create responses recover across process restart without duplicate PRs; closed is not merged and can start a new PR", async () => {
  const b = await feature("pr/recover");
  loseCreate = true;
  const response = await api(`/branches/${b.id}/merge`, {});
  assert.equal(response.status, 502);
  const created = nextNumber - 1;
  assert.equal(
    app.locals.db
      .prepare("SELECT number FROM branch_pull_requests WHERE branch_id=?")
      .get(b.id).number,
    null,
  );
  const beforePosts = calls.filter((c) => c.method === "POST").length;
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  await start();
  const synced = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  assert.equal(synced.data.pull_request.number, created);
  assert.equal(calls.filter((c) => c.method === "POST").length, beforePosts);
  prs.get(created).state = "closed";
  const closed = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(closed.data.pull_request.state, "closed");
  assert.equal(closed.data.state, "active");
  const reopened = await api(`/branches/${b.id}/merge`, {});
  assert.equal(reopened.status, 200);
  assert.notEqual(reopened.data.pull_request.number, created);
  assert.equal(reopened.data.pull_request.state, "open");
});
test("strict provider identity, denied credentials, external branch divergence and stale board approvals are safely rejected", async () => {
  const b = await feature("pr/conflict");
  await api(`/branches/${b.id}/merge`, {});
  wrongIdentity = true;
  let result = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(result.status, 502);
  wrongIdentity = false;
  providerDenied = true;
  result = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(result.status, 503);
  assert.equal(JSON.stringify(result.data).includes(env.GH_API_TOKEN), false);
  providerDenied = false;
  // Another contributor fast-forwards upstream independently; the server must
  // not rewrite those commits when retrying the previously reviewed local head.
  await git(b.work, ["push", remote, `HEAD:refs/heads/${b.name}`]);
  writeFileSync(join(b.work, "external"), "someone else\n");
  await git(b.work, ["add", "."]);
  await git(b.work, [
    "-c",
    "user.name=External",
    "-c",
    "user.email=external@example.com",
    "commit",
    "-m",
    "External",
  ]);
  await git(b.work, ["push", remote, `HEAD:refs/heads/${b.name}`]);
  const external = await git(b.work, ["rev-parse", "HEAD"]);
  app.locals.db
    .prepare(
      "UPDATE branch_pull_requests SET published_head=NULL WHERE branch_id=?",
    )
    .run(b.id);
  result = await api(`/branches/${b.id}/merge`, {});
  assert.equal(result.status, 409);
  assert.equal(await git(remote, ["rev-parse", b.name]), external);
  // A new local revision has no exact approval and is never published by sync.
  writeFileSync(join(b.work, "local"), "unreviewed\n");
  await git(b.work, ["add", "."]);
  await git(b.work, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Unreviewed",
  ]);
  const local = await git(b.work, ["rev-parse", "HEAD"]);
  await git(repoPath(dataDir, repo.id), [
    "fetch",
    b.work,
    `${local}:refs/heads/${b.name}`,
  ]);
  await api(`/branches/${b.id}`);
  assert.equal((await api(`/branches/${b.id}/merge`, {})).status, 409);
  await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(await git(remote, ["rev-parse", b.name]), external);
});
test("GitHub external merge is final authority, preserves unpublished local work and durably notifies its own requester", async () => {
  const b = await feature("pr/authority");
  const opened = await api(`/branches/${b.id}/merge`, {});
  const number = opened.data.pull_request.number;
  const external = "d".repeat(40),
    squash = "e".repeat(40);
  const pr = prs.get(number);
  pr.head.sha = external;
  pr.state = "closed";
  pr.merged = true;
  pr.merge_commit_sha = squash;
  const synced = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(synced.status, 200, JSON.stringify(synced.data));
  assert.equal(synced.data.state, "merged");
  assert.equal(
    synced.data.head_commit,
    b.head_commit,
    "local ref is preserved",
  );
  assert.equal(synced.data.pull_request.head_commit, external);
  assert.equal(synced.data.pull_request.merge_commit, squash);
  assert.equal(synced.data.pull_request.approval_stale, true);
  assert.ok(
    app.locals.db
      .prepare(
        "SELECT n.id FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? AND e.type='branch.merged' AND json_extract(e.payload,'$.branch_id')=?",
      )
      .get(spark, b.id),
    "remote merge notifies owner even owner=requester actor",
  );
  const count = app.locals.db
    .prepare(
      "SELECT count(*) AS n FROM events WHERE type='branch.merged' AND json_extract(payload,'$.branch_id')=?",
    )
    .get(b.id).n;
  await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(
    app.locals.db
      .prepare(
        "SELECT count(*) AS n FROM events WHERE type='branch.merged' AND json_extract(payload,'$.branch_id')=?",
      )
      .get(b.id).n,
    count,
    "poll retries do not duplicate merge notification",
  );
});
test("provider refuses redirected/foreign PR URLs and mismatched returned pull request numbers", async () => {
  const r = {
    github_owner: "example",
    github_repo: "project",
    github_token_env: "GH_API_TOKEN",
    main_branch: "main",
  };
  const p = {
    number: 1,
    html_url: "https://evil.example/pull/1",
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
  const client = githubClient(r, env, async () => Response.json(p));
  await assert.rejects(client.get(1, { name: "work" }), /URL/);
  p.html_url = "https://github.com/example/project/pull/1";
  await assert.rejects(
    client.get(2, { name: "work" }),
    /different pull request/,
  );
});
test("lost create recovery recognizes its durable marker after external edits and merge without duplicate PRs", async () => {
  const b = await feature("pr/lost-external");
  loseCreate = true;
  assert.equal((await api(`/branches/${b.id}/merge`, {})).status, 502);
  const created = nextNumber - 1,
    p = prs.get(created);
  p.head.sha = "c".repeat(40);
  p.state = "closed";
  p.merged = true;
  p.merge_commit_sha = "f".repeat(40);
  const posts = calls.filter((c) => c.method === "POST").length;
  const recovered = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(recovered.data.pull_request.number, created);
  assert.equal(recovered.data.state, "merged");
  assert.equal(recovered.data.pull_request.approval_stale, true);
  assert.equal(calls.filter((c) => c.method === "POST").length, posts);
});
test("existing PR recovery publishes a newly approved durable intent after a crash before push", async () => {
  const b = await feature("pr/publish-recovery");
  const opened = await api(`/branches/${b.id}/merge`, {});
  const number = opened.data.pull_request.number;
  prs.get(number).autoHead = true;
  const posts = calls.filter((c) => c.method === "POST").length;
  writeFileSync(join(b.work, "next"), "approved next revision\n");
  await git(b.work, ["add", "."]);
  await git(b.work, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Next revision",
  ]);
  const sha = await git(b.work, ["rev-parse", "HEAD"]);
  await git(repoPath(dataDir, repo.id), [
    "fetch",
    b.work,
    `${sha}:refs/heads/${b.name}`,
  ]);
  await api(`/branches/${b.id}`);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: sha, decision: "approved" },
        "sage",
      )
    ).status,
    200,
  );
  app.locals.db
    .prepare(
      "UPDATE branch_pull_requests SET requested_head=? WHERE branch_id=?",
    )
    .run(sha, b.id);
  const previousMain = await git(remote, ["rev-parse", "main"]);
  const recovered = await api(`/branches/${b.id}/pull-request/sync`, {});
  assert.equal(recovered.status, 200, JSON.stringify(recovered.data));
  assert.equal(await git(remote, ["rev-parse", b.name]), sha);
  assert.equal(recovered.data.pull_request.number, number);
  assert.equal(recovered.data.pull_request.head_commit, sha);
  assert.equal(calls.filter((c) => c.method === "POST").length, posts);
  assert.equal(await git(remote, ["rev-parse", "main"]), previousMain);
});
test("startup polling reconciles GitHub merge without user sync and cached closed PR cannot bypass a reopened PR policy", async () => {
  const b = await feature("pr/polling");
  const opened = await api(`/branches/${b.id}/merge`, {});
  const p = prs.get(opened.data.pull_request.number);
  p.state = "closed";
  await api(`/branches/${b.id}/pull-request/sync`, {});
  p.state = "open";
  assert.equal(
    (
      await api(
        `/repositories/${repo.id}`,
        { merge_mode: "direct" },
        "human",
        "PATCH",
      )
    ).status,
    409,
    "fresh provider state blocks policy bypass after reopen",
  );
  p.state = "closed";
  p.merged = true;
  p.merge_commit_sha = "b".repeat(40);
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  await start();
  for (
    let i = 0;
    i < 200 &&
    app.locals.db
      .prepare("SELECT state FROM managed_branches WHERE id=?")
      .get(b.id).state !== "merged";
    i++
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.equal(
    app.locals.db
      .prepare("SELECT state FROM managed_branches WHERE id=?")
      .get(b.id).state,
    "merged",
  );
});
test("schema9 migration defaults existing repositories to direct and preserves Git history/reviews", async () => {
  const { openDatabase, bootstrap } = await import("../server/db.mjs");
  const path = join(dir, "migration", "board.sqlite");
  let db = openDatabase(path);
  bootstrap(db, env);
  db.prepare(
    "INSERT INTO repositories(name,url,main_branch,created_by,created_at) VALUES('Existing','/existing.git','main',1,?)",
  ).run(now());
  db.prepare(
    "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(1,'existing',2,?,?)",
  ).run("a".repeat(40), now());
  db.prepare(
    "INSERT INTO branch_reviews(branch_id,reviewer_id,commit_hash,target_commit,decision,created_at) VALUES(1,3,?,?,'approved',?)",
  ).run("a".repeat(40), "b".repeat(40), now());
  db.exec("DROP TABLE branch_pull_requests");
  for (const column of [
    "merge_mode",
    "pr_provider",
    "github_owner",
    "github_repo",
    "github_token_env",
  ])
    db.exec(`ALTER TABLE repositories DROP COLUMN ${column}`);
  db.exec("PRAGMA user_version=9");
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 11);
    const r = db.prepare("SELECT * FROM repositories").get();
    assert.equal(r.merge_mode, "direct");
    assert.equal(r.github_token_env, null);
    assert.equal(
      db.prepare("SELECT head_commit FROM managed_branches").get().head_commit,
      "a".repeat(40),
    );
    assert.equal(
      db.prepare("SELECT decision FROM branch_reviews").get().decision,
      "approved",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM branch_pull_requests").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
test("failed update of an existing PR preserves its observed GitHub revisions instead of reporting the requested unpublished commit", async () => {
  const b = await feature("pr/metadata-on-failure");
  const opened = await api(`/branches/${b.id}/merge`, {});
  assert.equal(opened.status, 200);
  const observed = opened.data.pull_request;
  writeFileSync(join(b.work, "external"), "external branch change\n");
  await git(b.work, ["add", "."]);
  await git(b.work, [
    "-c",
    "user.name=External",
    "-c",
    "user.email=external@example.com",
    "commit",
    "-m",
    "External change",
  ]);
  await git(b.work, ["push", remote, `HEAD:refs/heads/${b.name}`]);
  const external = await git(b.work, ["rev-parse", "HEAD"]);
  await git(b.work, ["reset", "--hard", b.head_commit]);
  writeFileSync(join(b.work, "unpublished"), "new approved local revision\n");
  await git(b.work, ["add", "."]);
  await git(b.work, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Approved local change",
  ]);
  const requested = await git(b.work, ["rev-parse", "HEAD"]);
  await git(repoPath(dataDir, repo.id), [
    "fetch",
    b.work,
    `${requested}:refs/heads/${b.name}`,
  ]);
  await api(`/branches/${b.id}`);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/reviews`,
        { commit: requested, decision: "approved" },
        "sage",
      )
    ).status,
    200,
  );
  const attempted = await api(`/branches/${b.id}/merge`, {});
  assert.equal(attempted.status, 409);
  const detail = (await api(`/branches/${b.id}`)).data;
  assert.equal(detail.head_commit, requested);
  assert.equal(detail.pull_request.head_commit, observed.head_commit);
  assert.equal(detail.pull_request.base_commit, observed.base_commit);
  assert.notEqual(detail.pull_request.head_commit, requested);
  assert.equal(detail.pull_request.approval_stale, true);
  assert.ok(detail.pull_request.error);
  assert.equal(await git(remote, ["rev-parse", b.name]), external);
  assert.equal(
    app.locals.db
      .prepare(
        "SELECT requested_head FROM branch_pull_requests WHERE branch_id=?",
      )
      .get(b.id).requested_head,
    requested,
  );
});
