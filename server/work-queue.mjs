import { httpRequests as requests, requestId } from "../shared/requests.mjs";
import { now } from "./db.mjs";
const id = requestId();
const prefsInput = requests.workPreferences;
export function installWorkQueue({
  app,
  db,
  admin,
  event,
  participate,
  mutate,
  fail,
}) {
  const user = (value) =>
    db.prepare("SELECT * FROM users WHERE id=?").get(value) ||
    fail(404, "User not found");
  const capabilities = (u) =>
    db
      .prepare(
        "SELECT can_work,can_review FROM work_capabilities WHERE user_id=?",
      )
      .get(u.id) || { can_work: 1, can_review: u.kind === "human" ? 1 : 0 };
  const preferences = (value) => {
    const p =
      db
        .prepare(
          "SELECT notify_ready_work,notify_ready_reviews FROM work_preferences WHERE user_id=?",
        )
        .get(value) || {};
    return {
      notify_ready_work: !!p.notify_ready_work,
      notify_ready_reviews: !!p.notify_ready_reviews,
    };
  };
  const active = (value) => {
    const c = db
      .prepare("SELECT * FROM active_work_claims WHERE user_id=?")
      .get(value);
    return c ? { ...c, commit: c.commit_hash } : null;
  };
  const status = (name) =>
    db.prepare("SELECT id FROM statuses WHERE name=?").get(name)?.id ||
    fail(409, `The ${name} status is required`);
  const thread = (value) =>
    db
      .prepare(
        "SELECT t.*,s.name AS status_name,c.name AS channel_name,c.archived,u.name AS assignee_name FROM threads t JOIN statuses s ON s.id=t.status_id JOIN channels c ON c.id=t.channel_id LEFT JOIN users u ON u.id=t.assignee_id WHERE t.id=?",
      )
      .get(id.parse(value)) || fail(404, "Thread not found");
  const stamp = (t) =>
    new Date(Math.max(Date.now(), Date.parse(t.updated_at) + 1)).toISOString();
  const subscribed = (u, channel) =>
    !!db
      .prepare(
        "SELECT 1 FROM channel_subscriptions WHERE user_id=? AND channel_id=?",
      )
      .get(u.id, channel);
  function assertCapacity(u, match = {}) {
    const c = active(u.id);
    if (
      c &&
      !(
        c.kind === match.kind &&
        (match.thread_id
          ? c.thread_id === match.thread_id
          : c.branch_id === match.branch_id) &&
        (!match.submission_id || c.submission_id === match.submission_id)
      )
    )
      fail(
        409,
        "Finish or release your active work block before claiming another",
      );
    return c;
  }
  const claimForThread = (threadId) =>
    db
      .prepare("SELECT * FROM active_work_claims WHERE thread_id=?")
      .get(threadId) || null;
  const latestSubmission = (threadId) => {
    const s = db
      .prepare(
        "SELECT * FROM work_submissions WHERE thread_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(threadId);
    if (!s) return null;
    return {
      ...s,
      review_claim_user_id:
        db
          .prepare(
            "SELECT user_id FROM active_work_claims WHERE submission_id=? AND kind='review'",
          )
          .get(s.id)?.user_id || null,
    };
  };
  const threadState = (threadId) => ({
    current_submission: latestSubmission(threadId),
    active_claim: claimForThread(threadId),
  });
  function work(u) {
    if (!capabilities(u).can_work) return [];
    return db
      .prepare(
        `SELECT t.*,s.name AS status_name,c.name AS channel_name,a.name AS assignee_name FROM threads t JOIN statuses s ON s.id=t.status_id JOIN channels c ON c.id=t.channel_id LEFT JOIN users a ON a.id=t.assignee_id JOIN channel_subscriptions sub ON sub.channel_id=c.id AND sub.user_id=? WHERE c.archived=0 AND ((s.name='Ready' AND t.assignee_id IS NULL) OR (s.name='In progress' AND t.assignee_id=? AND NOT EXISTS(SELECT 1 FROM active_work_claims w WHERE w.thread_id=t.id))) ORDER BY t.updated_at,t.id`,
      )
      .all(u.id, u.id);
  }
  function reviews(u) {
    if (!capabilities(u).can_review) return [];
    const tickets = db
      .prepare(
        `SELECT 'ticket' AS kind,w.id,w.id AS submission_id,w.thread_id,w.summary,w.worker_id AS owner_id,a.name AS owner_name,w.created_at,t.title,t.channel_id,c.name AS channel_name,(SELECT user_id FROM active_work_claims ac WHERE ac.submission_id=w.id AND ac.kind='review') AS review_claim_user_id FROM work_submissions w JOIN threads t ON t.id=w.thread_id JOIN channels c ON c.id=t.channel_id JOIN users a ON a.id=w.worker_id JOIN channel_subscriptions sub ON sub.channel_id=c.id AND sub.user_id=? WHERE w.state='pending' AND c.archived=0 AND w.worker_id!=? AND w.submitted_by!=? AND NOT EXISTS(SELECT 1 FROM active_work_claims ac WHERE ac.submission_id=w.id AND ac.user_id!=?) ORDER BY w.id`,
      )
      .all(u.id, u.id, u.id, u.id);
    const branches = db
      .prepare(
        `SELECT 'branch' AS kind,b.*,b.id AS branch_id,r.name AS repository_name,u.name AS owner_name,s.commit_hash AS submitted_commit,s.created_at AS submitted_at,(SELECT user_id FROM active_work_claims ac WHERE ac.branch_id=b.id AND ac.kind='review') AS review_claim_user_id FROM branch_submissions s JOIN managed_branches b ON b.id=s.branch_id JOIN repositories r ON r.id=b.repository_id JOIN users u ON u.id=b.owner_id WHERE s.state='pending' AND s.commit_hash=b.head_commit AND b.state='active' AND b.owner_id!=? AND NOT EXISTS(SELECT 1 FROM branch_contributors bc WHERE bc.branch_id=b.id AND bc.user_id=?) AND NOT EXISTS(SELECT 1 FROM active_work_claims ac WHERE ac.branch_id=b.id AND ac.user_id!=?) AND EXISTS(SELECT 1 FROM branch_threads bt JOIN threads t ON t.id=bt.thread_id JOIN channels c ON c.id=t.channel_id JOIN channel_subscriptions cs ON cs.channel_id=c.id WHERE bt.branch_id=b.id AND c.archived=0 AND cs.user_id=?) ORDER BY s.created_at,b.id`,
      )
      .all(u.id, u.id, u.id, u.id)
      .map((b) => ({
        ...b,
        thread_ids: db
          .prepare("SELECT thread_id FROM branch_threads WHERE branch_id=?")
          .all(b.id)
          .map((t) => t.thread_id),
      }));
    return [...tickets, ...branches];
  }
  function targetWake(u, kind, entity, revision, actor, threadValue, payload) {
    const previous = db
      .prepare("INSERT OR IGNORE INTO queue_wakes VALUES(?,?,?,?)")
      .run(u.id, kind, entity, String(revision));
    if (!previous.changes) return;
    const e = db
      .prepare(
        "INSERT INTO events(type,actor_id,thread_id,channel_id,payload,created_at) VALUES(?,?,?,?,?,?) RETURNING id",
      )
      .get(
        kind === "work" ? "work.ready" : "review.ready",
        actor || u.id,
        threadValue?.id || null,
        threadValue?.channel_id || null,
        JSON.stringify(payload),
        now(),
      );
    db.prepare("INSERT INTO notifications(event_id,user_id) VALUES(?,?)").run(
      e.id,
      u.id,
    );
  }
  function wakeEligible(actor, onlyUser) {
    const users = onlyUser
      ? [user(onlyUser)]
      : db.prepare("SELECT * FROM users").all();
    for (const u of users) {
      const p = preferences(u.id);
      if (p.notify_ready_work)
        for (const t of work(u)) {
          db.prepare(
            "INSERT OR IGNORE INTO queue_signals(kind,entity_id) VALUES('work',?)",
          ).run(t.id);
          const revision = db
            .prepare(
              "SELECT revision FROM queue_signals WHERE kind='work' AND entity_id=?",
            )
            .get(t.id).revision;
          targetWake(u, "work", t.id, revision, actor, t, {
            thread_id: t.id,
            title: t.title,
            reserved_for: u.id === t.assignee_id ? u.id : null,
          });
        }
      if (p.notify_ready_reviews)
        for (const r of reviews(u)) {
          const t =
            r.kind === "ticket"
              ? thread(r.thread_id)
              : r.thread_ids.length
                ? thread(r.thread_ids[0])
                : null;
          targetWake(
            u,
            "review",
            r.kind === "ticket" ? -r.submission_id : r.id,
            r.kind === "ticket" ? r.submission_id : r.submitted_commit,
            actor,
            t,
            {
              kind: r.kind,
              thread_id: r.thread_id || null,
              branch_id: r.branch_id || null,
              submission_id: r.submission_id || null,
              commit: r.submitted_commit || null,
            },
          );
        }
    }
  }
  const resetWake = (value) => {
    if (value) db.prepare("DELETE FROM queue_wakes WHERE user_id=?").run(value);
  };
  const eligibilityChanged = (actor, value) => {
    resetWake(value);
    wakeEligible(actor, value);
  };
  function reviewReleased(actor, kind, entity, reviewer) {
    db.prepare(
      "DELETE FROM queue_wakes WHERE kind='review' AND entity_id=?",
    ).run(kind === "ticket" ? -entity : entity);
    resetWake(reviewer);
    wakeEligible(actor);
  }
  function onThreadChange(old, next, actor) {
    const previousClaim = claimForThread(next.id);
    if (
      old &&
      (old.assignee_id !== next.assignee_id ||
        next.status_id !==
          db.prepare("SELECT id FROM statuses WHERE name=?").get("In progress")
            ?.id)
    )
      db.prepare(
        "DELETE FROM active_work_claims WHERE thread_id=? AND kind='work'",
      ).run(next.id);
    if (
      old &&
      (next.status_id !==
        db.prepare("SELECT id FROM statuses WHERE name=?").get("In review")
          ?.id ||
        old.assignee_id !== next.assignee_id)
    ) {
      db.prepare(
        "UPDATE work_submissions SET state='superseded' WHERE thread_id=? AND state='pending'",
      ).run(next.id);
      db.prepare(
        "DELETE FROM active_work_claims WHERE thread_id=? AND kind='review'",
      ).run(next.id);
    }
    const isReady =
      next.status_id ===
        db.prepare("SELECT id FROM statuses WHERE name=?").get("Ready")?.id &&
      !next.assignee_id;
    const wasReady =
      old &&
      old.status_id ===
        db.prepare("SELECT id FROM statuses WHERE name=?").get("Ready")?.id &&
      !old.assignee_id;
    if (isReady && !wasReady)
      db.prepare(
        "INSERT INTO queue_signals(kind,entity_id) VALUES('work',?) ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1",
      ).run(next.id);
    if (previousClaim && !claimForThread(next.id))
      resetWake(previousClaim.user_id);
    wakeEligible(actor);
  }
  function setPreferences(value, input, actor) {
    user(value);
    const previous = preferences(value);
    if (input.notify_ready_work && !previous.notify_ready_work)
      db.prepare("DELETE FROM queue_wakes WHERE user_id=? AND kind='work'").run(
        value,
      );
    if (input.notify_ready_reviews && !previous.notify_ready_reviews)
      db.prepare(
        "DELETE FROM queue_wakes WHERE user_id=? AND kind='review'",
      ).run(value);
    db.prepare(
      "INSERT INTO work_preferences VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET notify_ready_work=excluded.notify_ready_work,notify_ready_reviews=excluded.notify_ready_reviews",
    ).run(value, +input.notify_ready_work, +input.notify_ready_reviews);
    wakeEligible(actor, value);
    return preferences(value);
  }
  app.get("/api/work-preferences", (req, res) =>
    res.json(preferences(req.user.id)),
  );
  app.put("/api/work-preferences", (req, res) => {
    const input = prefsInput.parse(req.body);
    mutate(req, res, () => setPreferences(req.user.id, input, req.user.id));
  });
  app.put("/api/admin/agents/:id/work-preferences", admin, (req, res) => {
    const input = prefsInput.parse(req.body);
    mutate(req, res, () => {
      const value = id.parse(req.params.id);
      if (!db.prepare("SELECT 1 FROM agents WHERE user_id=?").get(value))
        fail(404, "Agent not found");
      return setPreferences(value, input, req.user.id);
    });
  });
  app.get("/api/work-queue", (req, res) =>
    res.json({
      work: work(req.user),
      reviews: reviews(req.user),
      active_claim: active(req.user.id),
    }),
  );
  app.post("/api/threads/:id/claim", (req, res) => {
    const input = requests.claimTicket.parse(req.body || {});
    mutate(req, res, () => {
      const t = thread(req.params.id);
      if (!capabilities(req.user).can_work)
        fail(403, "Implementation permission required");
      if (t.archived || !subscribed(req.user, t.channel_id))
        fail(403, "Subscribe to this active channel before claiming work");
      if (
        input.expected_updated_at &&
        input.expected_updated_at !== t.updated_at
      )
        fail(409, "Thread changed; refresh before claiming");
      const existing = assertCapacity(req.user, {
        kind: "work",
        thread_id: t.id,
      });
      if (existing) return { ...t, ...threadState(t.id) };
      if (!(
        (t.status_name === "Ready" && !t.assignee_id) ||
        (t.status_name === "In progress" && t.assignee_id === req.user.id)
      ))
        fail(409, "This ticket is no longer eligible for you to claim");
      db.prepare(
        "INSERT INTO active_work_claims(user_id,kind,thread_id,created_at) VALUES(?,'work',?,?)",
      ).run(req.user.id, t.id, now());
      const next = db
        .prepare(
          "UPDATE threads SET assignee_id=?,status_id=?,updated_at=? WHERE id=? RETURNING *",
        )
        .get(req.user.id, status("In progress"), stamp(t), t.id);
      participate(t.id, req.user.id);
      event("work.claimed", req.user.id, next, { title: t.title });
      return { ...thread(t.id), ...threadState(t.id) };
    });
  });
  app.post("/api/threads/:id/release-claim", (req, res) =>
    mutate(req, res, () => {
      const t = thread(req.params.id),
        c = claimForThread(t.id);
      if ((c?.user_id || t.assignee_id) !== req.user.id && !req.user.admin)
        fail(403, "Only the worker or an admin may release this claim");
      if (c?.kind === "review")
        fail(409, "Release the review through its review action");
      if (
        db
          .prepare(
            "SELECT 1 FROM branch_threads bt JOIN managed_branches b ON b.id=bt.branch_id WHERE bt.thread_id=? AND b.state='active'",
          )
          .get(t.id)
      )
        fail(
          409,
          "Hand off or complete linked active branches before releasing this ticket",
        );
      db.prepare("DELETE FROM active_work_claims WHERE thread_id=?").run(t.id);
      const next = db
        .prepare(
          "UPDATE threads SET assignee_id=NULL,status_id=?,updated_at=? WHERE id=? RETURNING *",
        )
        .get(status("Ready"), stamp(t), t.id);
      resetWake(c?.user_id || t.assignee_id);
      event("work.released", req.user.id, next, { title: t.title });
      onThreadChange(t, next, req.user.id);
      return { ...thread(t.id), ...threadState(t.id) };
    }),
  );
  app.post("/api/threads/:id/submit-work", (req, res) => {
    const input = requests.submitWork.parse(req.body || {});
    mutate(req, res, () => {
      const t = thread(req.params.id);
      if (t.assignee_id !== req.user.id && !req.user.admin)
        fail(403, "Only the assigned worker or an admin may submit work");
      if (!capabilities(req.user).can_work)
        fail(403, "Implementation permission required");
      if (!t.assignee_id) fail(409, "Claim this ticket before submitting work");
      if (
        db
          .prepare(
            "SELECT 1 FROM branch_threads bt JOIN managed_branches b ON b.id=bt.branch_id WHERE bt.thread_id=? AND b.state='active'",
          )
          .get(t.id)
      )
        fail(
          409,
          "Submit linked code branches for review instead of submitting this as non-code work",
        );
      const previousClaim = claimForThread(t.id);
      if (previousClaim?.kind === "review")
        fail(
          409,
          "A reviewer is working on this submission; ask them to release it before resubmitting",
        );
      if (!["In progress", "In review"].includes(t.status_name))
        fail(409, "Only active work may be submitted");
      db.prepare(
        "UPDATE work_submissions SET state='superseded' WHERE thread_id=? AND state='pending'",
      ).run(t.id);
      db.prepare("DELETE FROM active_work_claims WHERE thread_id=?").run(t.id);
      db.prepare(
        "INSERT INTO work_submissions(thread_id,worker_id,submitted_by,summary,created_at) VALUES(?,?,?,?,?)",
      ).run(t.id, t.assignee_id, req.user.id, input.summary, now());
      const next = db
        .prepare(
          "UPDATE threads SET status_id=?,updated_at=? WHERE id=? RETURNING *",
        )
        .get(status("In review"), stamp(t), t.id);
      participate(t.id, req.user.id);
      event("work.submitted", req.user.id, next, { summary: input.summary }, [
        t.assignee_id,
      ]);
      if (previousClaim) resetWake(previousClaim.user_id);
      wakeEligible(req.user.id);
      return { ...thread(t.id), ...threadState(t.id) };
    });
  });
  function ticketSubmission(req) {
    const { submission_id: value } = requests.ticketSubmission.parse(
      req.body || {},
    );
    const s =
      db
        .prepare(
          "SELECT * FROM work_submissions WHERE id=? AND thread_id=? AND state='pending'",
        )
        .get(value, id.parse(req.params.id)) ||
      fail(409, "Submission is no longer awaiting review");
    if (!capabilities(req.user).can_review)
      fail(403, "Review permission required");
    if (s.worker_id === req.user.id || s.submitted_by === req.user.id)
      fail(403, "You cannot review your own work");
    return s;
  }
  function claimTicketReview(u, s) {
    const t = thread(s.thread_id);
    if (t.archived || !subscribed(u, t.channel_id))
      fail(403, "Subscribe to this active channel before claiming review");
    assertCapacity(u, { kind: "review", thread_id: t.id, submission_id: s.id });
    const occupied = claimForThread(t.id);
    if (occupied && occupied.user_id !== u.id)
      fail(409, "Another reviewer has claimed this submission");
    db.prepare(
      "INSERT OR IGNORE INTO active_work_claims(user_id,kind,thread_id,submission_id,created_at) VALUES(?,'review',?,?,?)",
    ).run(u.id, t.id, s.id, now());
    participate(t.id, u.id);
    return active(u.id);
  }
  app.post("/api/threads/:id/claim-review", (req, res) =>
    mutate(req, res, () => {
      const s = ticketSubmission(req);
      const claim = claimTicketReview(req.user, s);
      event(
        "review.claimed",
        req.user.id,
        thread(s.thread_id),
        { submission_id: s.id },
        [s.worker_id],
      );
      return { ...threadState(s.thread_id), active_claim: claim };
    }),
  );
  app.post("/api/threads/:id/release-review", (req, res) =>
    mutate(req, res, () => {
      const t = thread(req.params.id),
        c = claimForThread(t.id);
      if (!c || c.kind !== "review") fail(409, "No review claim to release");
      if (
        req.body?.submission_id !== undefined &&
        requests.releaseTicketReview.parse(req.body).submission_id !==
          c.submission_id
      )
        fail(409, "Submission changed; refresh before releasing review");
      if (c.user_id !== req.user.id && !req.user.admin)
        fail(403, "Only the reviewer or an admin may release review");
      db.prepare("DELETE FROM active_work_claims WHERE thread_id=?").run(t.id);
      event("review.released", req.user.id, t, {
        submission_id: c.submission_id,
      });
      reviewReleased(req.user.id, "ticket", c.submission_id, c.user_id);
      return threadState(t.id);
    }),
  );
  app.post("/api/threads/:id/reviews", (req, res) => {
    const input = requests.reviewTicket.parse(req.body);
    mutate(req, res, () => {
      const s = ticketSubmission(req);
      claimTicketReview(req.user, s);
      const t = thread(s.thread_id);
      db.prepare(
        "INSERT INTO work_reviews(submission_id,reviewer_id,decision,body,created_at) VALUES(?,?,?,?,?)",
      ).run(s.id, req.user.id, input.decision, input.body, now());
      db.prepare("UPDATE work_submissions SET state=? WHERE id=?").run(
        input.decision,
        s.id,
      );
      db.prepare("DELETE FROM active_work_claims WHERE submission_id=?").run(
        s.id,
      );
      const next = db
        .prepare(
          "UPDATE threads SET status_id=?,assignee_id=?,updated_at=? WHERE id=? RETURNING *",
        )
        .get(
          status(input.decision === "approved" ? "Done" : "In progress"),
          s.worker_id,
          stamp(t),
          t.id,
        );
      event(
        "work.reviewed",
        req.user.id,
        next,
        { submission_id: s.id, decision: input.decision, body: input.body },
        [s.worker_id],
      );
      resetWake(req.user.id);
      wakeEligible(req.user.id, req.user.id);
      if (input.decision === "changes_requested") {
        db.prepare(
          "INSERT INTO queue_signals(kind,entity_id) VALUES('work',?) ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1",
        ).run(t.id);
        wakeEligible(req.user.id, s.worker_id);
      }
      return { ...thread(t.id), ...threadState(t.id) };
    });
  });
  function branchState(branchId) {
    const s = db
      .prepare("SELECT * FROM branch_submissions WHERE branch_id=?")
      .get(branchId);
    const c = db
      .prepare(
        "SELECT * FROM active_work_claims WHERE branch_id=? AND kind='review'",
      )
      .get(branchId);
    return {
      submitted_commit: s?.state === "pending" ? s.commit_hash : null,
      submission: s || null,
      review_claim_user_id: c?.user_id || null,
      review_claim: c || null,
    };
  }
  function branchChanged(b, actor) {
    const previous = branchState(b.id).review_claim;
    db.prepare(
      "UPDATE branch_submissions SET state='stale' WHERE branch_id=?",
    ).run(b.id);
    db.prepare("DELETE FROM active_work_claims WHERE branch_id=?").run(b.id);
    if (previous) eligibilityChanged(actor, previous.user_id);
  }
  function branchMerged(b, actor) {
    const previous = branchState(b.id).review_claim;
    db.prepare("DELETE FROM active_work_claims WHERE branch_id=?").run(b.id);
    db.prepare(
      "UPDATE branch_submissions SET state='merged' WHERE branch_id=?",
    ).run(b.id);
    if (previous) eligibilityChanged(actor, previous.user_id);
  }
  function branchSubmit(b, u, sha) {
    if (b.owner_id !== u.id)
      fail(403, "Only the branch owner may submit it for review");
    if (!capabilities(u).can_work)
      fail(403, "Implementation permission required");
    if (b.state !== "active" || b.head_commit !== sha)
      fail(409, "Submit the current commit of an active branch");
    const existing = branchState(b.id);
    if (
      existing.submission?.state === "pending" &&
      existing.submitted_commit === sha
    )
      return existing;
    db.prepare(
      "INSERT INTO branch_submissions(branch_id,commit_hash,submitted_by,created_at) VALUES(?,?,?,?) ON CONFLICT(branch_id) DO UPDATE SET commit_hash=excluded.commit_hash,submitted_by=excluded.submitted_by,state='pending',created_at=excluded.created_at",
    ).run(b.id, sha, u.id, now());
    db.prepare("DELETE FROM active_work_claims WHERE branch_id=?").run(b.id);
    for (const t of db
      .prepare(
        "SELECT t.* FROM branch_threads bt JOIN threads t ON t.id=bt.thread_id WHERE bt.branch_id=? AND t.assignee_id=?",
      )
      .all(b.id, u.id)) {
      const released = db
        .prepare(
          "DELETE FROM active_work_claims WHERE thread_id=? AND user_id=? AND kind='work'",
        )
        .run(t.id, u.id);
      if (released.changes) resetWake(u.id);
      db.prepare("UPDATE threads SET status_id=?,updated_at=? WHERE id=?").run(
        status("In review"),
        stamp(t),
        t.id,
      );
    }
    wakeEligible(u.id);
    return branchState(b.id);
  }
  function branchClaim(b, u, sha, manual = false) {
    if (!capabilities(u).can_review) fail(403, "Review permission required");
    if (
      b.owner_id === u.id ||
      db
        .prepare(
          "SELECT 1 FROM branch_contributors WHERE branch_id=? AND user_id=?",
        )
        .get(b.id, u.id)
    )
      fail(403, "Owners and contributors cannot review their own work");
    if (b.state !== "active" || b.head_commit !== sha)
      fail(409, "Branch changed; claim its current commit");
    if (
      !manual &&
      !reviews(u).some(
        (r) =>
          r.kind === "branch" && r.id === b.id && r.submitted_commit === sha,
      )
    )
      fail(409, "This revision is not available in your review queue");
    assertCapacity(u, { kind: "review", branch_id: b.id });
    const c = db
      .prepare("SELECT * FROM active_work_claims WHERE branch_id=?")
      .get(b.id);
    if (c && c.user_id !== u.id)
      fail(409, "Another reviewer has claimed this branch");
    db.prepare(
      "INSERT OR IGNORE INTO active_work_claims(user_id,kind,branch_id,commit_hash,created_at) VALUES(?,'review',?,?,?)",
    ).run(u.id, b.id, sha, now());
    for (const t of db
      .prepare("SELECT thread_id FROM branch_threads WHERE branch_id=?")
      .all(b.id))
      participate(t.thread_id, u.id);
    return active(u.id);
  }
  function branchReviewed(b, u, decision) {
    branchClaim(b, u, b.head_commit, true);
    db.prepare(
      "DELETE FROM active_work_claims WHERE branch_id=? AND user_id=?",
    ).run(b.id, u.id);
    db.prepare(
      "UPDATE branch_submissions SET state=? WHERE branch_id=? AND commit_hash=?",
    ).run(decision, b.id, b.head_commit);
    resetWake(u.id);
    wakeEligible(u.id, u.id);
    if (decision === "changes_requested") {
      for (const t of db
        .prepare(
          "SELECT t.* FROM branch_threads bt JOIN threads t ON t.id=bt.thread_id WHERE bt.branch_id=? AND t.assignee_id=?",
        )
        .all(b.id, b.owner_id)) {
        db.prepare(
          "UPDATE threads SET status_id=?,updated_at=? WHERE id=?",
        ).run(status("In progress"), stamp(t), t.id);
        db.prepare(
          "INSERT INTO queue_signals(kind,entity_id) VALUES('work',?) ON CONFLICT(kind,entity_id) DO UPDATE SET revision=revision+1",
        ).run(t.id);
      }
      wakeEligible(u.id, b.owner_id);
    }
  }
  return {
    preferences,
    capabilities,
    threadState,
    work,
    reviews,
    active,
    wakeEligible,
    onThreadChange,
    branchState,
    branchChanged,
    branchSubmit,
    branchMerged,
    branchClaim,
    branchReviewed,
    assertCapacity,
    eligibilityChanged,
    reviewReleased,
  };
}
