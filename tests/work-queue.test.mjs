import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { git } from "../server/git.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-queue-")),
  env = {
    ADMIN_PASSWORD: "queue-test-password",
    AGENT_SPARK_TOKEN: "queue-spark",
    AGENT_SAGE_TOKEN: "queue-sage",
  };
let app, server, url, cookie, spark, sage;
const auth = (who) =>
  who === "human" ? { cookie } : { authorization: `Bearer queue-${who}` };
async function api(path, body, who = "spark", method = body ? "POST" : "GET") {
  const r = await fetch(url + "/api" + path, {
    method,
    headers: { "content-type": "application/json", ...auth(who) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}
async function start() {
  app = createApp({ dataDir: join(dir, "data"), env });
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  url = `http://127.0.0.1:${server.address().port}`;
}
async function ticket(title, status = 2) {
  return (
    await api("/threads", { channel_id: 1, title, status_id: status }, "human")
  ).data;
}
const count = (who, type) =>
  Number(
    app.locals.db
      .prepare(
        "SELECT count(*) AS n FROM notifications n JOIN events e ON e.id=n.event_id WHERE n.user_id=? AND e.type=?",
      )
      .get(who, type).n,
  );
const prefs = (work, reviews, who = "spark") =>
  api(
    "/work-preferences",
    { notify_ready_work: work, notify_ready_reviews: reviews },
    who,
    "PUT",
  );
before(async () => {
  await start();
  const r = await fetch(url + "/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: env.ADMIN_PASSWORD }),
  });
  cookie = r.headers.get("set-cookie").split(";")[0];
  spark = app.locals.db
    .prepare("SELECT id FROM users WHERE username='spark'")
    .get().id;
  sage = app.locals.db
    .prepare("SELECT id FROM users WHERE username='sage'")
    .get().id;
  await api("/channels/1/subscription", { subscribed: true }, "human", "PUT");
  await api(
    `/users/${sage}/capabilities`,
    { can_work: true, can_review: true },
    "human",
  );
});
after(async () => {
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
});
test("opt-in wakes include self and deduplicate; work and review claims race atomically across shared capacity", async () => {
  assert.deepEqual((await api("/work-preferences")).data, {
    notify_ready_work: false,
    notify_ready_reviews: false,
  });
  const a = await ticket("First ready"),
    b = await ticket("Second ready");
  assert.equal(count(spark, "work.ready"), 0);
  assert.equal((await prefs(true, false)).status, 200);
  assert.equal(count(spark, "work.ready"), 2);
  await prefs(true, false);
  assert.equal(count(spark, "work.ready"), 2);
  const result = await Promise.all([
    api(`/threads/${a.id}/claim`, { expected_updated_at: a.updated_at }),
    api(`/threads/${a.id}/claim`, {}, "sage"),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
  const worker = result[0].status === 200 ? "spark" : "sage",
    other = worker === "spark" ? "sage" : "spark",
    workerId = worker === "spark" ? spark : sage;
  assert.equal((await api(`/threads/${b.id}/claim`, {}, worker)).status, 409);
  assert.equal(
    (await api(`/threads/${a.id}`, { status_id: 2 }, other, "PATCH")).status,
    409,
    "foreign status edit cannot cancel claim",
  );
  assert.equal(
    (
      await api(
        `/threads/${a.id}`,
        { assignee_id: other === "spark" ? spark : sage },
        other,
        "PATCH",
      )
    ).status,
    409,
  );
  const submitted = await api(
    `/threads/${a.id}/submit-work`,
    { summary: "Created follow-up tickets TW-20 and TW-21" },
    worker,
  );
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.assignee_id, workerId);
  assert.equal(submitted.data.status_name, "In review");
  const sid = submitted.data.current_submission.id;
  assert.equal(
    (await api("/work-queue", undefined, worker)).data.active_claim,
    null,
  );
  // The other agent needs explicit review permission if it happens to be Spark.
  await api(
    `/users/${other === "spark" ? spark : sage}/capabilities`,
    { can_work: true, can_review: true },
    "human",
  );
  const queued = (await api("/work-queue", undefined, other)).data;
  assert.ok(
    queued.reviews.some((r) => r.kind === "ticket" && r.submission_id === sid),
  );
  assert.equal(
    (await api(`/threads/${a.id}/claim-review`, { submission_id: sid }, worker))
      .status,
    403,
  );
  const racers = await Promise.all([
    api(`/threads/${a.id}/claim-review`, { submission_id: sid }, other),
    api(`/threads/${a.id}/claim-review`, { submission_id: sid }, "human"),
  ]);
  assert.deepEqual(racers.map((r) => r.status).sort(), [200, 409]);
  const reviewer = racers[0].status === 200 ? other : "human";
  assert.equal(
    (
      await api(
        `/threads/${a.id}/submit-work`,
        { summary: "replacement" },
        worker,
      )
    ).status,
    409,
    "cannot silently steal active reviewer work",
  );
  assert.equal(
    (await api(`/threads/${b.id}/claim`, {}, reviewer)).status,
    409,
    "review occupies same capacity",
  );
  const approved = await api(
    `/threads/${a.id}/reviews`,
    { submission_id: sid, decision: "approved", body: "Outputs are complete" },
    reviewer,
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.data.status_name, "Done");
  assert.equal(
    (await api("/work-queue", undefined, reviewer)).data.active_claim,
    null,
  );
});
test("requested fixes stay reserved, busy workers defer, release resurfaces eligible work, capability and subscription gates apply", async () => {
  const t = await ticket("Needs iteration"),
    other = await ticket("Other task");
  await api(`/threads/${t.id}/claim`, {});
  const submitted = await api(`/threads/${t.id}/submit-work`, {
    summary: "draft",
  });
  const sid = submitted.data.current_submission.id;
  await prefs(false, true, "sage");
  const before = count(sage, "review.ready");
  assert.ok(before >= 1);
  await api(`/threads/${t.id}/claim-review`, { submission_id: sid }, "sage");
  await api(`/threads/${t.id}/release-review`, { submission_id: sid }, "sage");
  assert.ok(
    count(sage, "review.ready") > before,
    "released review wakes eligible reviewers again",
  );
  await api(`/threads/${other.id}/claim`, {});
  const changes = await api(
    `/threads/${t.id}/reviews`,
    {
      submission_id: sid,
      decision: "changes_requested",
      body: "Please finish",
    },
    "sage",
  );
  assert.equal(changes.status, 200);
  assert.equal(changes.data.assignee_id, spark);
  assert.equal(changes.data.status_name, "In progress");
  assert.equal(
    (await api(`/threads/${t.id}`, { assignee_id: sage }, "sage", "PATCH"))
      .status,
    409,
    "reserved fixes cannot be stolen through generic assignment",
  );
  assert.equal((await api(`/threads/${t.id}/claim`, {}, "sage")).status, 409);
  assert.equal(
    (await api(`/threads/${t.id}/claim`, {})).status,
    409,
    "original worker currently busy",
  );
  const notifications = count(spark, "work.ready");
  await api(`/threads/${other.id}/release-claim`, {});
  assert.ok(
    count(spark, "work.ready") > notifications,
    "free capacity resurfaces existing work",
  );
  assert.equal((await api(`/threads/${t.id}/claim`, {})).status, 200);
  await api(
    `/users/${spark}/capabilities`,
    { can_work: false, can_review: true },
    "human",
  );
  assert.equal(
    (await api(`/threads/${t.id}/submit-work`, { summary: "cannot submit" }))
      .status,
    403,
  );
  await api(
    `/users/${spark}/capabilities`,
    { can_work: true, can_review: true },
    "human",
  );
  await api(`/threads/${t.id}/release-claim`, {});
  await api("/channels/1/subscription", { subscribed: false }, "spark", "PUT");
  assert.equal((await api("/work-queue")).data.work.length, 0);
  assert.equal((await api(`/threads/${t.id}/claim`, {})).status, 403);
  const n = count(spark, "work.ready");
  await api("/channels/1/subscription", { subscribed: true }, "spark", "PUT");
  assert.ok(
    count(spark, "work.ready") > n,
    "subscription enable wakes current eligible work",
  );
});
test("explicit reassignment supersedes pending output and durable claims/preferences survive restart", async () => {
  const t = await ticket("Handoff review");
  await api(`/threads/${t.id}/claim`, {});
  const s = await api(`/threads/${t.id}/submit-work`, {
    summary: "old owner output",
  });
  const sid = s.data.current_submission.id;
  await api(`/threads/${t.id}/claim-review`, { submission_id: sid }, "sage");
  const moved = await api(
    `/threads/${t.id}`,
    { assignee_id: sage },
    "human",
    "PATCH",
  );
  assert.equal(moved.status, 200);
  assert.equal(
    (await api("/work-queue", undefined, "sage")).data.active_claim,
    null,
  );
  assert.equal(
    (
      await api(
        `/threads/${t.id}/reviews`,
        { submission_id: sid, decision: "approved" },
        "human",
      )
    ).status,
    409,
  );
  const current = await ticket("Persistent claim");
  await api(`/threads/${current.id}/claim`, {});
  const before = count(spark, "work.ready");
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  await start();
  assert.equal(
    (await api("/work-queue")).data.active_claim.thread_id,
    current.id,
  );
  assert.equal((await api("/work-preferences")).data.notify_ready_work, true);
  assert.equal(
    count(spark, "work.ready"),
    before,
    "restart does not repeat queue wakes",
  );
  await api(`/threads/${current.id}/release-claim`, {});
});
test("branch submissions and revision claims release capacity and reject stale pushes, non-code bypass, and concurrent reviewers", async () => {
  const remote = join(dir, "origin.git"),
    seed = join(dir, "seed");
  await git(dir, ["init", "--bare", "--initial-branch=main", remote]);
  await git(dir, ["init", "--initial-branch=main", seed]);
  writeFileSync(join(seed, "README"), "base\n");
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
  const r = (
    await api("/repositories", { name: "Queue repo", url: remote }, "human")
  ).data;
  const t = await ticket("Code job");
  await api(`/threads/${t.id}/claim`, {});
  const b = (
    await api(`/repositories/${r.id}/branches`, {
      name: "queue/code",
      thread_ids: [t.id],
    })
  ).data;
  assert.equal(
    (await api(`/threads/${t.id}/submit-work`, { summary: "skip code review" }))
      .status,
    409,
  );
  const submitted = await api(`/branches/${b.id}/submit-review`, {
    commit: b.head_commit,
  });
  assert.equal(submitted.status, 200);
  assert.equal((await api("/work-queue")).data.active_claim, null);
  assert.equal((await api(`/threads/${t.id}`)).data.status_name, "In review");
  const queue = (await api("/work-queue", undefined, "sage")).data;
  assert.ok(queue.reviews.some((x) => x.kind === "branch" && x.id === b.id));
  const claims = await Promise.all([
    api(`/branches/${b.id}/claim-review`, { commit: b.head_commit }, "sage"),
    api(`/branches/${b.id}/claim-review`, { commit: b.head_commit }, "human"),
  ]);
  assert.deepEqual(claims.map((r) => r.status).sort(), [200, 409]);
  const reviewer = claims[0].status === 200 ? "sage" : "human";
  await api(`/branches/${b.id}/submit-review`, { commit: b.head_commit });
  assert.equal(
    (await api("/work-queue", undefined, reviewer)).data.active_claim.branch_id,
    b.id,
    "same revision resubmit preserves reviewer",
  );
  await api(
    `/branches/${b.id}/release-review`,
    { commit: b.head_commit },
    reviewer,
  );
  await api(
    `/branches/${b.id}/claim-review`,
    { commit: b.head_commit },
    "sage",
  );
  const basic = Buffer.from("threadwork:queue-spark").toString("base64");
  const clone = join(dir, "clone");
  await git(dir, [
    "-c",
    `http.extraHeader=Authorization: Basic ${basic}`,
    "clone",
    `${url}/api/git/${r.id}.git`,
    clone,
  ]);
  await git(clone, ["checkout", "queue/code"]);
  writeFileSync(join(clone, "code"), "new revision\n");
  await git(clone, ["add", "."]);
  await git(clone, [
    "-c",
    "user.name=Spark",
    "-c",
    "user.email=spark@threadwork.local",
    "commit",
    "-m",
    "Code",
  ]);
  await git(clone, [
    "-c",
    `http.extraHeader=Authorization: Basic ${basic}`,
    "push",
    "origin",
    "queue/code",
  ]);
  assert.equal(
    (await api("/work-queue", undefined, "sage")).data.active_claim,
    null,
  );
  assert.equal((await api(`/branches/${b.id}`)).data.submitted_commit, null);
  assert.equal(
    (
      await api(
        `/branches/${b.id}/claim-review`,
        { commit: b.head_commit },
        "sage",
      )
    ).status,
    409,
  );
  const sha = await git(clone, ["rev-parse", "HEAD"]);
  await api(`/branches/${b.id}/submit-review`, { commit: sha });
  await api(`/branches/${b.id}/claim-review`, { commit: sha }, "sage");
  const reviewed = await api(
    `/branches/${b.id}/reviews`,
    { commit: sha, decision: "changes_requested" },
    "sage",
  );
  assert.equal(reviewed.status, 200);
  assert.equal(
    (await api("/work-queue", undefined, "sage")).data.active_claim,
    null,
  );
  const ticketState = (await api(`/threads/${t.id}`)).data;
  assert.equal(ticketState.status_name, "In progress");
  assert.equal(ticketState.assignee_id, spark);
  assert.equal((await api(`/threads/${t.id}/claim`, {}, "sage")).status, 409);
  assert.equal((await api(`/threads/${t.id}/claim`, {})).status, 200);
});
test("v4 database migration creates queue tables while preserving repositories, reviews, credentials, and discussions", async () => {
  const { openDatabase, bootstrap, hash, now } =
    await import("../server/db.mjs");
  const path = join(dir, "migration", "board.sqlite");
  let db = openDatabase(path);
  bootstrap(db, env);
  db.prepare(
    "INSERT INTO repositories(name,url,main_branch,created_by,created_at) VALUES('Existing','/server/existing.git','main',1,?)",
  ).run(now());
  db.prepare(
    "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(1,'existing',?, ?,?)",
  ).run(spark, "a".repeat(40), now());
  db.prepare(
    "INSERT INTO branch_reviews(branch_id,reviewer_id,commit_hash,target_commit,decision,created_at) VALUES(1,?, ?,?,'approved',?)",
  ).run(sage, "a".repeat(40), "b".repeat(40), now());
  db.prepare(
    "INSERT INTO git_credentials VALUES(?,1,'existing credential',?)",
  ).run(hash("migration-test-token"), "2099-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO threads(channel_id,title,status_id,created_by,created_at,updated_at) VALUES(1,'Preserved thread',2,1,?,?)",
  ).run(now(), now());
  db.exec(
    "DROP TABLE queue_wakes; DROP TABLE queue_signals; DROP TABLE work_reviews; DROP TABLE active_work_claims; DROP TABLE work_submissions; DROP TABLE branch_submissions; DROP TABLE work_preferences; PRAGMA user_version=4;",
  );
  db.close();
  db = openDatabase(path);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 5);
    assert.equal(
      db.prepare("SELECT name FROM repositories").get().name,
      "Existing",
    );
    assert.equal(
      db.prepare("SELECT head_commit FROM managed_branches").get().head_commit,
      "a".repeat(40),
    );
    assert.equal(
      db.prepare("SELECT decision FROM branch_reviews").get().decision,
      "approved",
    );
    assert.equal(
      db.prepare("SELECT token_hash FROM git_credentials").get().token_hash,
      hash("migration-test-token"),
    );
    assert.equal(
      db.prepare("SELECT title FROM threads").get().title,
      "Preserved thread",
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM active_work_claims").get().n,
      0,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM work_preferences").get().n,
      0,
    );
  } finally {
    db.close();
  }
});
