import {
  httpRequests as requests,
  requestId,
  branchName,
} from "../shared/requests.mjs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { z } from "zod";
import { hash, token, now, transaction } from "./db.mjs";
import {
  git,
  gitEnv,
  repoPath,
  initializeRepo,
  upstreamEnv,
  validateRepositoryUrl,
} from "./git.mjs";

const id = requestId();
export function gitIdentity(db, authorization) {
  if (!authorization?.startsWith("Basic ")) return null;
  const decoded = Buffer.from(authorization.slice(6), "base64").toString();
  const at = decoded.indexOf(":");
  if (at < 0) return null;
  const username = decoded.slice(0, at),
    secret = decoded.slice(at + 1);
  return (
    db
      .prepare("SELECT * FROM users WHERE kind='agent' AND token_hash=?")
      .get(hash(secret)) ||
    db
      .prepare(
        "SELECT u.* FROM git_credentials c JOIN users u ON u.id=c.user_id WHERE c.token_hash=? AND c.expires_at>? AND u.username=?",
      )
      .get(hash(secret), now(), username)
  );
}
export function installOrchestration({
  app,
  db,
  workQueue,
  dataDir,
  env,
  admin,
  event,
  participate,
  broadcast,
  mutate,
  fail,
}) {
  const locks = new Map();
  async function locked(repoId, fn) {
    const previous = locks.get(repoId) || Promise.resolve();
    let release;
    const tail = new Promise((r) => (release = r));
    locks.set(repoId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(repoId) === tail) locks.delete(repoId);
    }
  }
  const repo = (value) =>
    db.prepare("SELECT * FROM repositories WHERE id=?").get(id.parse(value)) ||
    fail(404, "Repository not found");
  const publicRepo = ({ credential_env, ...r }) => ({
    ...r,
    credential_configured: !!credential_env,
  });
  const cap = (u) =>
    db
      .prepare(
        "SELECT can_work,can_review FROM work_capabilities WHERE user_id=?",
      )
      .get(u.id) || { can_work: 1, can_review: u.kind === "human" ? 1 : 0 };
  const capable = (u, name) =>
    cap(u)[name] ||
    fail(
      403,
      name === "can_work"
        ? "Implementation permission required"
        : "Review permission required",
    );
  const branch = (value) =>
    db
      .prepare(
        "SELECT b.*,r.name AS repository_name,u.name AS owner_name FROM managed_branches b JOIN repositories r ON r.id=b.repository_id JOIN users u ON u.id=b.owner_id WHERE b.id=?",
      )
      .get(id.parse(value)) || fail(404, "Branch not found");
  const detail = (value) => {
    const b = branch(value);
    return {
      ...b,
      ...workQueue.branchState(b.id),
      thread_ids: db
        .prepare("SELECT thread_id FROM branch_threads WHERE branch_id=?")
        .all(b.id)
        .map((x) => x.thread_id),
      reviews: db
        .prepare(
          "SELECT v.*,u.name AS reviewer_name,u.kind AS reviewer_kind FROM branch_reviews v JOIN users u ON u.id=v.reviewer_id WHERE branch_id=? ORDER BY v.id DESC",
        )
        .all(b.id),
      dependencies: db
        .prepare(
          "SELECT b.* FROM branch_dependencies d JOIN managed_branches b ON b.id=d.depends_on_id WHERE d.branch_id=?",
        )
        .all(b.id),
    };
  };
  const notify = (b, actor, type, payload = {}, extra = []) => {
    const threads = db
      .prepare(
        "SELECT t.* FROM branch_threads l JOIN threads t ON t.id=l.thread_id WHERE l.branch_id=?",
      )
      .all(b.id);
    for (const t of threads) {
      participate(t.id, actor);
      event(
        type,
        actor,
        t,
        {
          branch_id: b.id,
          branch_name: b.name,
          repository_id: b.repository_id,
          ...payload,
        },
        [b.owner_id, ...extra],
      );
    }
    if (!threads.length)
      event(type, actor, null, { branch_id: b.id, ...payload }, [
        b.owner_id,
        ...extra,
      ]);
  };
  const atomic = (fn) => {
    const out = transaction(db, fn);
    broadcast();
    return out;
  };
  const head = (r, name) =>
    git(repoPath(dataDir, r.id), [
      "rev-parse",
      "--verify",
      `refs/heads/${name}^{commit}`,
    ]);
  const fetchMain = async (r) => {
    await git(
      repoPath(dataDir, r.id),
      [
        "fetch",
        "--no-tags",
        r.url,
        `+refs/heads/${r.main_branch}:refs/remotes/upstream/${r.main_branch}`,
      ],
      upstreamEnv(r, env),
    );
    const current = await git(repoPath(dataDir, r.id), [
      "rev-parse",
      `refs/remotes/upstream/${r.main_branch}`,
    ]);
    await git(repoPath(dataDir, r.id), [
      "update-ref",
      `refs/heads/${r.main_branch}`,
      current,
    ]);
    return current;
  };
  async function reconcile(r, actor) {
    const journal = db
      .prepare("SELECT actor_id FROM git_push_journal WHERE repository_id=?")
      .get(r.id);
    actor = journal?.actor_id || actor;
    for (const b of db
      .prepare(
        "SELECT * FROM managed_branches WHERE repository_id=? AND state='active'",
      )
      .all(r.id)) {
      const next = await head(r, b.name);
      if (next !== b.head_commit)
        atomic(() => {
          db.prepare(
            "UPDATE managed_branches SET head_commit=? WHERE id=?",
          ).run(next, b.id);
          db.prepare(
            "INSERT OR IGNORE INTO branch_contributors VALUES(?,?)",
          ).run(b.id, actor || b.owner_id);
          workQueue.branchChanged(b, actor || b.owner_id);
          notify(b, actor || b.owner_id, "branch.updated", { commit: next });
        });
    }
    db.prepare("DELETE FROM git_push_journal WHERE repository_id=?").run(r.id);
  }
  // A durable intent closes the push/SQLite crash window. Never retry an uncertain
  // upstream write: reconcile it before allowing any further operation on that repo.
  async function recover(r) {
    const pending = db
      .prepare(
        "SELECT * FROM git_operations WHERE repository_id=? AND state='pending'",
      )
      .all(r.id);
    if (!pending.length) return;
    const current = await fetchMain(r);
    for (const operation of pending) {
      const merged =
        operation.commit_hash === current ||
        (await git(repoPath(dataDir, r.id), [
          "merge-base",
          "--is-ancestor",
          operation.commit_hash,
          current,
        ]).then(
          () => true,
          () => false,
        ));
      atomic(() => {
        if (merged) {
          db.prepare(
            "UPDATE managed_branches SET state='merged',merged_at=? WHERE id=?",
          ).run(now(), operation.branch_id);
          workQueue.branchMerged(
            branch(operation.branch_id),
            operation.actor_id,
          );
          notify(
            branch(operation.branch_id),
            operation.actor_id,
            "branch.merged",
            { commit: operation.commit_hash, recovered: true },
          );
        }
        db.prepare("UPDATE git_operations SET state=?,error=? WHERE id=?").run(
          merged ? "complete" : "failed",
          merged
            ? null
            : "Upstream did not contain the requested commit; request merge again.",
          operation.id,
        );
      });
    }
    await git(repoPath(dataDir, r.id), [
      "update-ref",
      `refs/heads/${r.main_branch}`,
      current,
    ]);
  }
  const ensureReady = async (r) => {
    if (!existsSync(join(repoPath(dataDir, r.id), ".threadwork-ready")))
      await initializeRepo(dataDir, r, env);
  };
  const withRepo = (req, res, fn) => {
    const r = repo(
      req.params.repositoryId || branch(req.params.id).repository_id,
    );
    return locked(r.id, async () => {
      await ensureReady(repo(r.id));
      await recover(r);
      await reconcile(r, req.user.id);
      const key = req.headers["idempotency-key"];
      if (key && !/^[a-zA-Z0-9:_-]{1,150}$/.test(key))
        fail(400, "Invalid idempotency key");
      const cacheKey = key ? `${req.method}:${req.path}:${key}` : null;
      if (cacheKey) {
        const cached = db
          .prepare("SELECT response FROM mutations WHERE user_id=? AND key=?")
          .get(req.user.id, cacheKey);
        if (cached) return res.json(JSON.parse(cached.response));
        const send = res.json.bind(res);
        res.json = (value) => {
          if (res.statusCode >= 400) return send(value);
          transaction(db, () =>
            db
              .prepare("INSERT OR IGNORE INTO mutations VALUES(?,?,?)")
              .run(req.user.id, cacheKey, JSON.stringify(value)),
          );
          return send(value);
        };
      }
      return fn(repo(r.id));
    });
  };
  app.get("/api/orchestration", (req, res) =>
    res.json({
      repositories: db
        .prepare("SELECT * FROM repositories ORDER BY id")
        .all()
        .map(publicRepo),
      branches: db
        .prepare(
          "SELECT b.*,r.name AS repository_name,u.name AS owner_name FROM managed_branches b JOIN repositories r ON r.id=b.repository_id JOIN users u ON u.id=b.owner_id ORDER BY b.id DESC",
        )
        .all()
        .map((b) => ({ ...b, ...workQueue.branchState(b.id) })),
      capabilities: db
        .prepare("SELECT id,kind FROM users")
        .all()
        .map((u) => ({ user_id: u.id, ...cap(u) })),
    }),
  );
  app.get("/api/repositories", (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM repositories ORDER BY id")
        .all()
        .map(publicRepo),
    ),
  );
  app.post("/api/repositories", admin, async (req, res) => {
    const key = req.headers["idempotency-key"];
    if (key && !/^[a-zA-Z0-9:_-]{1,150}$/.test(key))
      fail(400, "Invalid idempotency key");
    const cacheKey = key ? `${req.method}:${req.path}:${key}` : null;
    if (cacheKey) {
      const cached = db
        .prepare("SELECT response FROM mutations WHERE user_id=? AND key=?")
        .get(req.user.id, cacheKey);
      if (cached) return res.json(JSON.parse(cached.response));
    }
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        url: z.string().trim().min(1).max(2000),
        main_branch: branchName.default("main"),
        credential_env: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .optional(),
        require_human: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    validateRepositoryUrl(input.url);
    // Validate before persisting the row so a missing secret cannot leave a registered repository.
    upstreamEnv(input, env);
    const r = atomic(() =>
      db
        .prepare(
          "INSERT INTO repositories(name,url,main_branch,credential_env,require_human,created_by,created_at) VALUES(?,?,?,?,?,?,?) RETURNING *",
        )
        .get(
          input.name,
          input.url,
          input.main_branch,
          input.credential_env || null,
          +input.require_human,
          req.user.id,
          now(),
        ),
    );
    await locked(r.id, async () => {
      try {
        await initializeRepo(dataDir, r, env);
      } catch (error) {
        atomic(() =>
          db.prepare("DELETE FROM repositories WHERE id=?").run(r.id),
        );
        rmSync(repoPath(dataDir, r.id), { recursive: true, force: true });
        throw error;
      }
    });
    const output = publicRepo(r);
    if (cacheKey)
      transaction(db, () =>
        db
          .prepare("INSERT OR IGNORE INTO mutations VALUES(?,?,?)")
          .run(req.user.id, cacheKey, JSON.stringify(output)),
      );
    res.json(output);
  });
  app.patch("/api/repositories/:repositoryId", admin, async (req, res) => {
    const input = z
      .object({ require_human: z.boolean() })
      .strict()
      .parse(req.body);
    await withRepo(req, res, async (r) => {
      res.json(
        atomic(() => {
          db.prepare("UPDATE repositories SET require_human=? WHERE id=?").run(
            +input.require_human,
            r.id,
          );
          return publicRepo(repo(r.id));
        }),
      );
    });
  });
  app.post("/api/users/:id/capabilities", admin, (req, res) => {
    const input = z
      .object({ can_work: z.boolean(), can_review: z.boolean() })
      .strict()
      .parse(req.body);
    mutate(req, res, () => {
      id.parse(req.params.id);
      const capabilityUser =
        db.prepare("SELECT * FROM users WHERE id=?").get(req.params.id) ||
        fail(404, "User not found");
      const previousCapabilities = workQueue.capabilities(capabilityUser);
      db.prepare(
        "INSERT INTO work_capabilities VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET can_work=excluded.can_work,can_review=excluded.can_review",
      ).run(req.params.id, +input.can_work, +input.can_review);
      if (
        (input.can_work && !previousCapabilities.can_work) ||
        (input.can_review && !previousCapabilities.can_review)
      )
        workQueue.eligibilityChanged(req.user.id, Number(req.params.id));
      return { user_id: Number(req.params.id), ...input };
    });
  });
  app.post("/api/git-credentials", (req, res) => {
    if (req.user.kind !== "human")
      fail(403, "Agents use their existing board token");
    const input = z
      .object({ label: z.string().max(100).default("Git access") })
      .strict()
      .parse(req.body || {});
    mutate(req, res, () => {
      const secret = token(),
        expires_at = new Date(Date.now() + 24 * 3600000).toISOString();
      db.prepare("INSERT INTO git_credentials VALUES(?,?,?,?)").run(
        hash(secret),
        req.user.id,
        input.label,
        expires_at,
      );
      return { username: req.user.username, token: secret, expires_at };
    });
  });
  app.delete("/api/git-credentials", (req, res) =>
    mutate(req, res, () => {
      db.prepare("DELETE FROM git_credentials WHERE user_id=?").run(
        req.user.id,
      );
      return { ok: true };
    }),
  );
  app.get("/api/branches", (req, res) => {
    let rows = db
      .prepare(
        "SELECT b.*,r.name AS repository_name,u.name AS owner_name FROM managed_branches b JOIN repositories r ON r.id=b.repository_id JOIN users u ON u.id=b.owner_id ORDER BY b.id DESC",
      )
      .all();
    if (req.query.thread_id) {
      const t = id.parse(req.query.thread_id);
      rows = rows.filter((b) =>
        db
          .prepare(
            "SELECT 1 FROM branch_threads WHERE branch_id=? AND thread_id=?",
          )
          .get(b.id, t),
      );
    }
    res.json(rows.map((b) => ({ ...b, ...workQueue.branchState(b.id) })));
  });
  app.get("/api/branches/:id", async (req, res) => {
    await withRepo(req, res, async () => res.json(detail(req.params.id)));
  });
  app.get("/api/branches/:id/diff", async (req, res) => {
    await withRepo(req, res, async (r) => {
      await reconcile(r, req.user.id);
      const b = branch(req.params.id),
        target = await fetchMain(r);
      const diff = await git(repoPath(dataDir, r.id), [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        "--patch",
        `${target}...${b.head_commit}`,
      ]);
      res.json({ commit: b.head_commit, target_commit: target, diff });
    });
  });
  app.post("/api/repositories/:repositoryId/branches", async (req, res) => {
    capable(req.user, "can_work");
    const input = requests.createBranch.parse(req.body);
    await withRepo(req, res, async (r) => {
      if (input.name === r.main_branch)
        fail(400, "Main cannot be a managed working branch");
      if (
        db
          .prepare(
            "SELECT 1 FROM managed_branches WHERE repository_id=? AND name=?",
          )
          .get(r.id, input.name)
      )
        fail(409, "Branch is already registered");
      for (const t of input.thread_ids)
        if (!db.prepare("SELECT 1 FROM threads WHERE id=?").get(t))
          fail(404, "Thread not found");
      const target = await fetchMain(r);
      let sha = input.base || target;
      const remote = await git(
        repoPath(dataDir, r.id),
        ["ls-remote", "--heads", r.url, `refs/heads/${input.name}`],
        upstreamEnv(r, env),
      );
      if (remote) {
        await git(
          repoPath(dataDir, r.id),
          ["fetch", "--no-tags", r.url, `refs/heads/${input.name}`],
          upstreamEnv(r, env),
        );
        sha = await git(repoPath(dataDir, r.id), ["rev-parse", "FETCH_HEAD"]);
      }
      await git(repoPath(dataDir, r.id), ["cat-file", "-e", `${sha}^{commit}`]);
      const orphan = await head(r, input.name).catch(() => null);
      await git(repoPath(dataDir, r.id), [
        "update-ref",
        `refs/heads/${input.name}`,
        sha,
        orphan || "0000000000000000000000000000000000000000",
      ]);
      const b = atomic(() => {
        const b = db
          .prepare(
            "INSERT INTO managed_branches(repository_id,name,owner_id,head_commit,created_at) VALUES(?,?,?,?,?) RETURNING *",
          )
          .get(r.id, input.name, req.user.id, sha, now());
        for (const t of new Set(input.thread_ids))
          db.prepare("INSERT INTO branch_threads VALUES(?,?)").run(b.id, t);
        db.prepare("INSERT OR IGNORE INTO branch_contributors VALUES(?,?)").run(
          b.id,
          req.user.id,
        );
        notify(b, req.user.id, "branch.created");
        return detail(b.id);
      });
      res.json(b);
    });
  });
  const owner = (b, u) => {
    if (b.owner_id !== u.id)
      fail(
        403,
        "Only the branch owner may change this branch; an admin may explicitly hand it off",
      );
    if (b.state !== "active") fail(409, "Branch is already merged");
    capable(u, "can_work");
  };
  app.post("/api/branches/:id/link", (req, res) => {
    const input = requests.linkBranch.parse(req.body);
    mutate(req, res, () => {
      const b = branch(req.params.id);
      owner(b, req.user);
      db.prepare("INSERT OR IGNORE INTO branch_threads VALUES(?,?)").run(
        b.id,
        input.thread_id,
      );
      notify(b, req.user.id, "branch.linked");
      return detail(b.id);
    });
  });
  app.post("/api/branches/:id/handoff", async (req, res) => {
    const input = requests.handoffBranch.parse(req.body);
    await withRepo(req, res, async () => {
      const b = branch(req.params.id);
      if (b.owner_id !== req.user.id && !req.user.admin)
        fail(403, "Only the owner or an admin can hand off a branch");
      if (b.state !== "active") fail(409, "Branch is already merged");
      const next =
        db.prepare("SELECT * FROM users WHERE id=?").get(input.owner_id) ||
        fail(404, "User not found");
      capable(next, "can_work");
      res.json(
        atomic(() => {
          db.prepare("UPDATE managed_branches SET owner_id=? WHERE id=?").run(
            next.id,
            b.id,
          );
          workQueue.branchChanged(b, req.user.id);
          notify(
            { ...b, owner_id: next.id },
            req.user.id,
            "branch.handed_off",
            { previous_owner_id: b.owner_id },
            [b.owner_id],
          );
          return detail(b.id);
        }),
      );
    });
  });
  app.post("/api/branches/:id/dependencies", async (req, res) => {
    const input = requests.branchDependency.parse(req.body);
    await withRepo(req, res, async () =>
      mutate(req, res, () => {
        const b = branch(req.params.id);
        owner(b, req.user);
        branch(input.depends_on_id);
        const cycle = db
          .prepare(
            "WITH RECURSIVE deps(id) AS (SELECT ? UNION SELECT d.depends_on_id FROM branch_dependencies d JOIN deps ON d.branch_id=deps.id) SELECT 1 FROM deps WHERE id=?",
          )
          .get(input.depends_on_id, b.id);
        if (cycle) fail(400, "Dependency would create a cycle");
        db.prepare("INSERT OR IGNORE INTO branch_dependencies VALUES(?,?)").run(
          b.id,
          input.depends_on_id,
        );
        notify(b, req.user.id, "branch.dependencies_changed");
        return detail(b.id);
      }),
    );
  });
  app.delete("/api/branches/:id/dependencies/:dependencyId", async (req, res) =>
    withRepo(req, res, async () =>
      mutate(req, res, () => {
        const b = branch(req.params.id);
        owner(b, req.user);
        db.prepare(
          "DELETE FROM branch_dependencies WHERE branch_id=? AND depends_on_id=?",
        ).run(b.id, id.parse(req.params.dependencyId));
        notify(b, req.user.id, "branch.dependencies_changed");
        return detail(b.id);
      }),
    ),
  );
  for (const action of ["submit-review", "claim-review", "release-review"])
    app.post(`/api/branches/:id/${action}`, async (req, res) => {
      const input = requests.branchRevision.parse(req.body);
      await withRepo(req, res, async () => {
        const b = branch(req.params.id);
        if (b.head_commit !== input.commit)
          fail(409, "Branch changed; refresh its current commit");
        res.json(
          atomic(() => {
            if (action === "submit-review") {
              workQueue.branchSubmit(b, req.user, input.commit);
              notify(b, req.user.id, "branch.submitted", {
                commit: input.commit,
              });
            }
            if (action === "claim-review") {
              workQueue.branchClaim(b, req.user, input.commit);
              notify(b, req.user.id, "review.claimed", {
                commit: input.commit,
              });
            }
            if (action === "release-review") {
              const c = workQueue.branchState(b.id).review_claim;
              if (!c) fail(409, "No review claim to release");
              if (c.user_id !== req.user.id && !req.user.admin)
                fail(403, "Only the reviewer or an admin may release review");
              db.prepare(
                "DELETE FROM active_work_claims WHERE branch_id=?",
              ).run(b.id);
              notify(b, req.user.id, "review.released", {
                commit: input.commit,
              });
              workQueue.reviewReleased(req.user.id, "branch", b.id, c.user_id);
            }
            return detail(b.id);
          }),
        );
      });
    });
  app.post("/api/branches/:id/reviews", async (req, res) => {
    capable(req.user, "can_review");
    const input = requests.reviewBranch.parse(req.body);
    await withRepo(req, res, async (r) => {
      await reconcile(r, req.user.id);
      const b = branch(req.params.id);
      if (b.state !== "active") fail(409, "Branch is already merged");
      if (
        b.owner_id === req.user.id ||
        db
          .prepare(
            "SELECT 1 FROM branch_contributors WHERE branch_id=? AND user_id=?",
          )
          .get(b.id, req.user.id)
      )
        fail(
          403,
          "The branch owner or a contributor cannot review their own work",
        );
      if (b.head_commit !== input.commit)
        fail(409, "Branch changed; review its current commit");
      const target = await fetchMain(r);
      if (input.target_commit && input.target_commit !== target)
        fail(
          409,
          "Main changed since inspection; inspect the current diff before reviewing",
        );
      const authors = await git(repoPath(dataDir, r.id), [
        "log",
        "--format=%ae",
        `${target}..${b.head_commit}`,
      ]);
      if (
        authors
          .split("\n")
          .some(
            (a) => a.toLowerCase() === `${req.user.username}@threadwork.local`,
          )
      )
        fail(403, "A contributor cannot approve their own commits");
      res.json(
        atomic(() => {
          workQueue.branchReviewed(b, req.user, input.decision);
          db.prepare(
            "INSERT INTO branch_reviews(branch_id,reviewer_id,commit_hash,target_commit,decision,body,require_human,created_at) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            b.id,
            req.user.id,
            input.commit,
            target,
            input.decision,
            input.body,
            +input.require_human,
            now(),
          );
          notify(b, req.user.id, "branch.reviewed", {
            decision: input.decision,
            commit: input.commit,
            require_human: input.require_human,
          });
          return detail(b.id);
        }),
      );
    });
  });
  app.post("/api/branches/:id/merge", async (req, res) => {
    await withRepo(req, res, async (r) => {
      await reconcile(r, req.user.id);
      const b = branch(req.params.id);
      if (b.owner_id !== req.user.id && req.user.kind !== "human")
        fail(403, "Only the worker or a human can request merge");
      capable(req.user, "can_work");
      if (b.state === "merged") return res.json(detail(b.id));
      const target = await fetchMain(r);
      const sha = await head(r, b.name);
      const reviews = db
        .prepare(
          "SELECT v.*,u.kind FROM branch_reviews v JOIN users u ON u.id=v.reviewer_id WHERE branch_id=? AND commit_hash=? AND target_commit=? ORDER BY v.id DESC",
        )
        .all(b.id, sha, target);
      const latest = new Map();
      for (const v of reviews)
        if (!latest.has(v.reviewer_id)) latest.set(v.reviewer_id, v);
      const valid = [...latest.values()].filter(
        (v) =>
          v.reviewer_id !== b.owner_id &&
          cap({ id: v.reviewer_id, kind: v.kind }).can_review &&
          !db
            .prepare(
              "SELECT 1 FROM branch_contributors WHERE branch_id=? AND user_id=?",
            )
            .get(b.id, v.reviewer_id),
      );
      if (valid.some((v) => v.decision === "changes_requested"))
        fail(409, "A reviewer requested changes for this revision");
      const requireHuman =
        !!r.require_human ||
        !!db
          .prepare(
            "SELECT 1 FROM branch_reviews WHERE branch_id=? AND require_human=1",
          )
          .get(b.id);
      if (
        !valid.some(
          (v) =>
            v.decision === "approved" && (!requireHuman || v.kind === "human"),
        )
      )
        fail(
          409,
          requireHuman
            ? "Human approval is required for this commit and target"
            : "Approval is required for this exact commit and current main",
        );
      if (
        db
          .prepare(
            "SELECT 1 FROM branch_dependencies d JOIN managed_branches b ON b.id=d.depends_on_id WHERE d.branch_id=? AND b.state!='merged'",
          )
          .get(b.id)
      )
        fail(409, "Merge dependencies first");
      try {
        await git(repoPath(dataDir, r.id), [
          "merge-base",
          "--is-ancestor",
          target,
          sha,
        ]);
      } catch {
        fail(
          409,
          "Main has diverged. Merge current main into the working branch, push, and obtain a new review.",
        );
      }
      const operation = atomic(() =>
        db
          .prepare(
            "INSERT INTO git_operations(repository_id,branch_id,actor_id,kind,commit_hash,previous_commit,created_at) VALUES(?,?,?,'merge',?,?,?) RETURNING *",
          )
          .get(r.id, b.id, req.user.id, sha, target, now()),
      );
      try {
        await git(
          repoPath(dataDir, r.id),
          [
            "push",
            `--force-with-lease=refs/heads/${r.main_branch}:${target}`,
            r.url,
            `${sha}:refs/heads/${r.main_branch}`,
          ],
          upstreamEnv(r, env),
        );
      } catch (error) {
        // Leave uncertain intents pending; the next operation reconciles against upstream.
        throw Object.assign(
          new Error(
            "Merge push failed or its outcome is uncertain. The server will reconcile upstream before the next operation.",
          ),
          { status: 409 },
        );
      }
      await git(repoPath(dataDir, r.id), [
        "update-ref",
        `refs/heads/${r.main_branch}`,
        sha,
      ]);
      res.json(
        atomic(() => {
          db.prepare(
            "UPDATE managed_branches SET state='merged',merged_at=? WHERE id=?",
          ).run(now(), b.id);
          db.prepare(
            "UPDATE git_operations SET state='complete' WHERE id=?",
          ).run(operation.id);
          workQueue.branchMerged(b, req.user.id);
          notify(b, req.user.id, "branch.merged", { commit: sha });
          return detail(b.id);
        }),
      );
    });
  });
  app.all(/^\/api\/git\/(\d+)\.git\/(.*)$/, async (req, res) => {
    const r = repo(req.params[0]);
    const endpoint = req.params[1];
    if (endpoint === "info/refs" && req.method !== "GET")
      fail(405, "Git advertisement requires GET");
    if (
      ["git-upload-pack", "git-receive-pack"].includes(endpoint) &&
      (req.method !== "POST" ||
        req.headers["content-type"] !== `application/x-${endpoint}-request`)
    )
      fail(400, "Invalid Git protocol request");
    await locked(r.id, async () => {
      await ensureReady(repo(r.id));
      await recover(r);
      await reconcile(r, req.user.id);
      if (!existsSync(repoPath(dataDir, r.id)))
        fail(503, "Repository storage is unavailable");
      const service = req.query.service;
      const suffix = req.params[1];
      if (suffix === "info/refs" && service === "git-upload-pack")
        await fetchMain(repo(r.id));
      if (
        !["info/refs", "git-upload-pack", "git-receive-pack"].includes(suffix)
      )
        fail(404, "Git endpoint not found");
      if (suffix === "git-receive-pack" || service === "git-receive-pack")
        capable(req.user, "can_work");
      if (suffix === "git-receive-pack")
        db.prepare("INSERT OR REPLACE INTO git_push_journal VALUES(?,?)").run(
          r.id,
          req.user.id,
        );
      const child = spawn("git", ["http-backend"], {
        env: gitEnv({
          GIT_PROJECT_ROOT: join(dataDir, "repositories"),
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: `/${r.id}.git/${suffix}`,
          REQUEST_METHOD: req.method,
          QUERY_STRING: new URL(
            req.originalUrl,
            "http://localhost",
          ).search.slice(1),
          CONTENT_TYPE: req.headers["content-type"] || "",
          CONTENT_LENGTH: req.headers["content-length"] || "",
          REMOTE_USER: String(req.user.id),
          THREADWORK_GIT_USER: String(req.user.id),
          THREADWORK_GIT_REPO: String(r.id),
          THREADWORK_GIT_DB: join(dataDir, "threadwork.sqlite"),
        }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let chunks = [],
        length = 0;
      child.stdout.on("data", (b) => {
        length += b.length;
        if (length > 100 * 1024 * 1024) child.kill();
        else chunks.push(b);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      req.pipe(child.stdin);
      const timeout = setTimeout(() => child.kill("SIGKILL"), 120000);
      try {
        await new Promise((resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code) =>
            code === 0
              ? resolve()
              : reject(
                  Object.assign(new Error("Git gateway failed"), {
                    status: 502,
                  }),
                ),
          );
        });
      } finally {
        clearTimeout(timeout);
        await reconcile(r, req.user.id);
      }
      const output = Buffer.concat(chunks);
      let split = output.indexOf("\r\n\r\n"),
        separator = 4;
      if (split < 0) {
        split = output.indexOf("\n\n");
        separator = 2;
      }
      if (split < 0) fail(502, "Invalid Git backend response");
      for (const line of output.subarray(0, split).toString().split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at < 0) continue;
        const name = line.slice(0, at),
          value = line.slice(at + 1).trim();
        if (name.toLowerCase() === "status")
          res.status(Number(value.split(" ")[0]));
        else res.setHeader(name, value);
      }
      res.end(output.subarray(split + separator));
    });
  });
}
