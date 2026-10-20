import React, { useEffect, useState } from "react";
import { RefreshCw, ClipboardList } from "lucide-react";

export function useWorkQueue(api, refreshKey) {
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    api("/work-queue")
      .then((result) => {
        if (!stale) {
          setQueue(result);
          setError("");
        }
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [api, refreshKey, version]);
  return { queue, error, refresh: () => setVersion((v) => v + 1) };
}
export function QueueAction({
  api,
  path,
  body = {},
  onDone,
  label,
  children,
  disabled = false,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="queue-action"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled) return;
        const fields = new FormData(event.currentTarget);
        setBusy(true);
        setError("");
        try {
          const result = await api(path, {
            method: "POST",
            body: typeof body === "function" ? body(fields) : body,
          });
          onDone?.(result);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <button className="button subtle" disabled={busy || disabled}>
        {busy ? "Working…" : label}
      </button>
    </form>
  );
}
export function WorkPreferences({
  api,
  path = "/work-preferences",
  initial,
  onDone,
  agent = false,
}) {
  const [preferences, setPreferences] = useState(initial || null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initial) {
      setPreferences(initial);
      return;
    }
    let stale = false;
    api(path)
      .then((value) => {
        if (!stale) setPreferences(value);
      })
      .catch((e) => {
        if (!stale) setError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [api, path, initial?.notify_ready_work, initial?.notify_ready_reviews]);
  return (
    <section className="work-preferences">
      <h3>
        {agent ? "Voluntary work notifications" : "Your work notifications"}
      </h3>
      <p className="muted">
        Notifications offer work; claiming is voluntary. Only subscribed
        channels are eligible. Work and review permissions are configured in
        Repositories.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {preferences && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await api(path, { method: "PUT", body: preferences });
              onDone?.();
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!preferences.notify_ready_work}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  notify_ready_work: e.target.checked,
                })
              }
            />
            Notify about Ready work in subscribed channels
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={!!preferences.notify_ready_reviews}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  notify_ready_reviews: e.target.checked,
                })
              }
            />
            Notify about reviews in subscribed channels
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? "Saving…" : "Save work preferences"}
          </button>
        </form>
      )}
    </section>
  );
}
export function WorkQueuePage({ api, data, refreshKey, openThread }) {
  const { queue, error, refresh } = useWorkQueue(api, refreshKey);
  const active = queue?.active_claim;
  const activeThreadId =
    active?.thread_id ||
    queue?.reviews?.find(
      (item) => item.kind === "branch" && item.id === active?.branch_id,
    )?.thread_ids?.[0];
  const done = () => refresh();
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">PICK UP THE NEXT PIECE</div>
          <h1>Work queue</h1>
          <p>
            Eligible work from your subscribed channels. Claim one block at a
            time; submitted work frees your capacity.
          </p>
        </div>
        <button className="button subtle" onClick={refresh}>
          <RefreshCw size={15} />
          Refresh queue
        </button>
      </section>
      <div className="orchestration-content work-queue-content">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {active ? (
          <section className="orchestration-card">
            <h2>
              Your active {active.kind === "review" ? "review" : "work block"}
            </h2>
            <p>
              {active.thread_id
                ? `TW-${active.thread_id}`
                : `Branch ${active.branch_id}`}{" "}
              · Release or submit it before claiming another block.
            </p>
            {activeThreadId && (
              <button
                className="button subtle"
                onClick={() =>
                  openThread(
                    activeThreadId,
                    active.branch_id ? "branches" : "discussion",
                    active.branch_id,
                  )
                }
              >
                Open active work
              </button>
            )}
            <QueueAction
              api={api}
              path={
                active.kind === "review"
                  ? active.branch_id
                    ? `/branches/${active.branch_id}/release-review`
                    : `/threads/${active.thread_id}/release-review`
                  : `/threads/${active.thread_id}/release-claim`
              }
              body={active.commit ? { commit: active.commit } : {}}
              label="Release active claim"
              onDone={done}
            />
          </section>
        ) : (
          queue && (
            <p className="queue-available">
              <ClipboardList size={17} />
              You have capacity to claim work or a review.
            </p>
          )
        )}
        <section className="orchestration-card">
          <h2>Implementation work</h2>
          {queue?.work?.length ? (
            queue.work.map((item) => (
              <article className="queue-item" key={item.id}>
                <div>
                  <button
                    className="queue-link"
                    onClick={() => openThread(item.id)}
                  >
                    TW-{item.id} · {item.title}
                  </button>
                  <p>
                    #{item.channel_name} · {item.status_name}
                    {item.assignee_id ? " · Reserved for you" : ""}
                  </p>
                </div>
                <QueueAction
                  api={api}
                  path={`/threads/${item.id}/claim`}
                  body={{ expected_updated_at: item.updated_at }}
                  label="Claim work"
                  disabled={!!active}
                  onDone={done}
                />
              </article>
            ))
          ) : (
            <p className="muted">
              No eligible work right now. Subscribe to a channel and move an
              unassigned ticket to Ready; implementation permission is required.
            </p>
          )}
        </section>
        <section className="orchestration-card">
          <h2>Reviews</h2>
          {queue?.reviews?.length ? (
            queue.reviews.map((item) => {
              const ticket = item.kind === "ticket";
              const threadId = ticket ? item.thread_id : item.thread_ids?.[0];
              return (
                <article
                  className="queue-item"
                  key={`${item.kind || "branch"}:${ticket ? item.submission_id : item.id}`}
                >
                  <div>
                    {threadId ? (
                      <button
                        className="queue-link"
                        onClick={() =>
                          openThread(
                            threadId,
                            ticket ? "discussion" : "branches",
                            ticket ? null : item.id,
                          )
                        }
                      >
                        {ticket
                          ? `TW-${item.thread_id} · ${item.title || "Submitted work"}`
                          : `${item.repository_name} / ${item.name}`}
                      </button>
                    ) : (
                      <strong>
                        {item.repository_name} / {item.name}
                      </strong>
                    )}
                    <p>
                      {ticket
                        ? item.summary
                        : `${item.owner_name} · ${item.submitted_commit?.slice(0, 12)}`}
                    </p>
                  </div>
                  <QueueAction
                    api={api}
                    path={
                      ticket
                        ? `/threads/${item.thread_id}/claim-review`
                        : `/branches/${item.id}/claim-review`
                    }
                    body={
                      ticket
                        ? { submission_id: item.submission_id }
                        : { commit: item.submitted_commit }
                    }
                    label="Claim review"
                    disabled={!!active}
                    onDone={done}
                  />
                </article>
              );
            })
          ) : (
            <p className="muted">
              No eligible reviews right now. Submitted work appears here for
              subscribed reviewers who did not produce it.
            </p>
          )}
        </section>
        <section className="orchestration-card">
          <WorkPreferences api={api} />
        </section>
      </div>
    </>
  );
}
export function ThreadWorkControl({ api, thread, data, refreshKey, onDone }) {
  const { queue, error, refresh } = useWorkQueue(api, refreshKey);
  const active = queue?.active_claim;
  const mine = active?.kind === "work" && active.thread_id === thread.id;
  const eligible = queue?.work?.find((item) => item.id === thread.id);
  const done = () => {
    refresh();
    onDone?.();
  };
  const submission = thread.current_submission;
  const reviewMine =
    active?.kind === "review" && active.submission_id === submission?.id;
  const reviewEligible = queue?.reviews?.some(
    (item) => item.kind === "ticket" && item.submission_id === submission?.id,
  );
  if (!mine && !eligible && !submission) return null;
  return (
    <section className="thread-work-control">
      <div>
        <strong>
          {mine
            ? "Your active work block"
            : eligible
              ? thread.assignee_id
                ? "Work reserved for you"
                : "Ready for pickup"
              : "Work outcome"}
        </strong>
        <p className="muted">
          {mine
            ? "Submit an outcome for review, or release your claim."
            : eligible
              ? "Claiming reserves this ticket and uses your active work capacity."
              : "Review records the outcome; requested fixes stay reserved for the original worker."}
        </p>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {submission && (
        <section className="ticket-submission">
          <h4>
            Submitted outcome ·{" "}
            {submission.state?.replaceAll("_", " ") || "Awaiting review"}
          </h4>
          <p className="queue-summary">{submission.summary}</p>
          {reviewMine ? (
            <>
              <QueueAction
                api={api}
                path={`/threads/${thread.id}/reviews`}
                body={(f) => ({
                  submission_id: submission.id,
                  decision: f.get("decision"),
                  body: f.get("body"),
                })}
                label="Record outcome review"
                onDone={done}
              >
                <label>
                  Outcome review decision
                  <select name="decision" aria-label="Outcome review decision">
                    <option value="approved">Approve outcome</option>
                    <option value="changes_requested">Request changes</option>
                  </select>
                </label>
                <label>
                  Outcome review notes
                  <textarea name="body" maxLength={20000} />
                </label>
              </QueueAction>
              <QueueAction
                api={api}
                path={`/threads/${thread.id}/release-review`}
                label="Release review claim"
                onDone={done}
              />
            </>
          ) : reviewEligible ? (
            <QueueAction
              api={api}
              path={`/threads/${thread.id}/claim-review`}
              body={{ submission_id: submission.id }}
              label="Claim outcome review"
              disabled={!!active}
              onDone={done}
            />
          ) : submission.review_claim_user_id ? (
            <p className="muted">
              Review claimed by{" "}
              {data.users.find((u) => u.id === submission.review_claim_user_id)
                ?.name || "another reviewer"}
              .
            </p>
          ) : null}
        </section>
      )}
      {mine ? (
        <>
          <QueueAction
            api={api}
            path={`/threads/${thread.id}/submit-work`}
            body={(f) => ({ summary: f.get("summary") })}
            label="Submit work for review"
            onDone={done}
          >
            <label>
              Outcome / handoff summary
              <textarea
                name="summary"
                maxLength={20000}
                placeholder="What changed, links to outputs, and what the reviewer should check."
                required
              />
            </label>
            <p className="muted">
              For code, submit each branch from the Branches tab. Submitted work
              frees your capacity.
            </p>
          </QueueAction>
          <QueueAction
            api={api}
            path={`/threads/${thread.id}/release-claim`}
            label="Release work claim"
            onDone={done}
          />
        </>
      ) : eligible ? (
        <QueueAction
          api={api}
          path={`/threads/${thread.id}/claim`}
          body={{ expected_updated_at: eligible.updated_at }}
          label="Claim work"
          disabled={!!active}
          onDone={done}
        />
      ) : null}
    </section>
  );
}
