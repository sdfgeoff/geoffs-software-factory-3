import React, { useEffect, useState } from "react";
import { GitBranch, RefreshCw, Plus } from "lucide-react";

function useOrchestration(api, refreshKey) {
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let stale = false;
    api("/orchestration")
      .then((result) => {
        if (!stale) {
          setState(result);
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
  return { state, error, refresh: () => setVersion((v) => v + 1) };
}
function ErrorMessage({ children }) {
  return children ? (
    <p className="form-error orchestration-error" role="alert">
      {children}
    </p>
  ) : null;
}
function ActionForm({
  api,
  path,
  body,
  onDone,
  children,
  label = "Save",
  method = "POST",
  disabled = false,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="orchestration-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || disabled) return;
        const form = e.currentTarget;
        const fields = new FormData(form);
        setBusy(true);
        setError("");
        try {
          const result = await api(path, { method, body: body(fields) });
          onDone?.(result);
        } catch (e) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <ErrorMessage>{error}</ErrorMessage>
      <button className="button primary" disabled={busy || disabled}>
        {busy ? "Working…" : label}
      </button>
    </form>
  );
}
export function RepositoriesPage({ api, data, refreshKey, notify }) {
  const { state, error, refresh } = useOrchestration(api, refreshKey);
  const [registering, setRegistering] = useState(false);
  const [credential, setCredential] = useState(null);
  const done = () => {
    refresh();
    notify("Repository registered");
    setRegistering(false);
  };
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">SHARED CODE, EXPLICIT INTEGRATION</div>
          <h1>Repositories</h1>
          <p>
            Branches connect code to conversations. Review approves a commit;
            its owner requests the merge.
          </p>
        </div>
        <div className="heading-actions">
          <button className="button subtle" onClick={refresh}>
            <RefreshCw size={15} />
            Refresh
          </button>
          {data.user.admin && (
            <button
              className="button primary"
              onClick={() => setRegistering((v) => !v)}
            >
              <Plus size={16} />
              {registering ? "Cancel registration" : "Register repository"}
            </button>
          )}
        </div>
      </section>
      <div className="orchestration-content">
        <ErrorMessage>{error}</ErrorMessage>
        {registering && (
          <section className="orchestration-card">
            <h2>Register repository</h2>
            <ActionForm
              api={api}
              path="/repositories"
              onDone={done}
              label="Register repository"
              body={(f) => ({
                name: f.get("name"),
                url: f.get("url"),
                main_branch: f.get("main_branch"),
                ...(f.get("credential_env")
                  ? { credential_env: f.get("credential_env") }
                  : {}),
                require_human: f.get("require_human") === "on",
              })}
            >
              <label>
                Name
                <input name="name" required maxLength={100} />
              </label>
              <label>
                Git URL
                <input
                  name="url"
                  required
                  placeholder="https://github.com/team/project.git"
                />
              </label>
              <label>
                Main branch
                <input name="main_branch" required defaultValue="main" />
              </label>
              <label>
                Server credential environment variable
                <input name="credential_env" placeholder="PROJECT_GIT_TOKEN" />
                <small>
                  Enter the variable name only. Configure the secret on the
                  server.
                </small>
              </label>
              <label className="orchestration-checkbox">
                <input name="require_human" type="checkbox" />
                Require human review before merging
              </label>
            </ActionForm>
          </section>
        )}
        {!state && !error && <p className="muted">Loading repositories…</p>}
        {state?.repositories?.length === 0 && (
          <section className="orchestration-card">
            <GitBranch size={25} />
            <h2>No repositories yet</h2>
            <p>
              {data.user.admin
                ? "Register a repository to connect branches with tickets."
                : "An admin can register your team's repositories."}
            </p>
          </section>
        )}
        {state?.repositories?.map((repo) => (
          <section className="orchestration-card" key={repo.id}>
            <h2>
              <GitBranch size={18} />
              {repo.name}
            </h2>
            <p className="orchestration-code">{repo.url}</p>
            <p>
              Main: <strong>{repo.main_branch}</strong> ·{" "}
              {repo.require_human
                ? "Human review required"
                : "Eligible reviewer approval required"}
            </p>
            {data.user.admin && (
              <ActionForm
                key={`policy:${repo.id}:${repo.require_human}`}
                api={api}
                path={`/repositories/${repo.id}`}
                method="PATCH"
                body={(f) => ({
                  require_human: f.get("require_human") === "on",
                })}
                label="Save approval policy"
                onDone={refresh}
              >
                <label className="orchestration-checkbox">
                  <input
                    type="checkbox"
                    name="require_human"
                    defaultChecked={!!repo.require_human}
                  />
                  Require human review before merging
                </label>
              </ActionForm>
            )}
            <label>
              Git gateway URL
              <code className="orchestration-code">
                {location.origin}/api/git/{repo.id}.git
              </code>
            </label>
            <p className="muted">
              Create and manage branches from a thread’s Branches tab.
            </p>
            <div className="orchestration-branch-summary">
              {state.branches
                ?.filter((b) => b.repository_id === repo.id)
                .map((b) => (
                  <span className="pill" key={b.id}>
                    {b.name} · {b.state || b.status || "open"}
                  </span>
                ))}
            </div>
          </section>
        ))}
        <section className="orchestration-card">
          <h2>Your Git access</h2>
          <p>
            Use a board Git credential to clone, fetch, and push through the
            gateway. Your upstream repository credentials stay on the server.
          </p>
          <ActionForm
            api={api}
            path="/git-credentials"
            method="DELETE"
            body={() => ({})}
            label="Revoke all my Git credentials"
            onDone={() => {
              setCredential(null);
              notify("Git credentials revoked");
            }}
          />
          {credential ? (
            <div>
              <p>Copy this credential now; it is shown once.</p>
              <code className="orchestration-secret">
                {credential.token || credential.credential}
              </code>
              <p className="muted">
                Use your board username and this token when Git prompts for
                credentials. Use your Git credential manager rather than
                embedding it in a URL.
              </p>
              <p className="muted">
                Expires {new Date(credential.expires_at).toLocaleString()}.
              </p>
              <button
                className="button subtle"
                onClick={() => setCredential(null)}
              >
                Dismiss credential
              </button>
            </div>
          ) : (
            <ActionForm
              api={api}
              path="/git-credentials"
              body={() => ({ label: "Git command line" })}
              onDone={setCredential}
              label="Create Git credential"
            />
          )}
        </section>
        {data.user.admin && state && (
          <section className="orchestration-card">
            <h2>Work and review permissions</h2>
            <p>
              Reviewers cannot approve their own work. Roles and prompts do not
              grant these permissions.
            </p>
            <div className="orchestration-capabilities">
              {data.users.map((user) => (
                <CapabilityRow
                  key={user.id}
                  user={user}
                  value={state.capabilities?.find((c) => c.user_id === user.id)}
                  api={api}
                  refresh={refresh}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
function CapabilityRow({ user, value, api, refresh }) {
  return (
    <ActionForm
      key={`${value?.can_work}:${value?.can_review}`}
      api={api}
      path={`/users/${user.id}/capabilities`}
      body={(f) => ({
        can_work: f.get("can_work") === "on",
        can_review: f.get("can_review") === "on",
      })}
      onDone={refresh}
    >
      <strong>{user.name}</strong>
      <label className="orchestration-checkbox">
        <input
          name="can_work"
          type="checkbox"
          defaultChecked={!!value?.can_work}
        />
        Work
      </label>
      <label className="orchestration-checkbox">
        <input
          name="can_review"
          type="checkbox"
          defaultChecked={!!value?.can_review}
        />
        Review
      </label>
    </ActionForm>
  );
}

export function ThreadBranches({ api, data, threadId, refreshKey }) {
  const { state, error, refresh } = useOrchestration(api, refreshKey);
  const [branches, setBranches] = useState([]);
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [creating, setCreating] = useState(false);
  const [repoId, setRepoId] = useState("");
  useEffect(() => {
    let stale = false;
    api(`/branches?thread_id=${threadId}`)
      .then((b) => {
        if (!stale) setBranches(b);
      })
      .catch((e) => {
        if (!stale) setDetailError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [api, threadId, state]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
  }, [selected]);
  useEffect(() => {
    setDetailError("");
    if (!selected) return;
    let stale = false;
    api(`/branches/${selected}`)
      .then((b) => {
        if (!stale) setDetail(b);
      })
      .catch((e) => {
        if (!stale) setDetailError(e.message);
      });
    return () => {
      stale = true;
    };
  }, [api, selected, state]);
  const capabilities = state?.capabilities?.find(
    (c) => c.user_id === data.user.id,
  );
  const canWork = !!capabilities?.can_work;
  const canReview = !!capabilities?.can_review;
  const repository = state?.repositories?.find(
    (r) => r.id === detail?.repository_id,
  );
  const finished = () => {
    refresh();
  };
  return (
    <section className="thread-branches">
      <div className="orchestration-title">
        <div>
          <h3>Linked branches</h3>
          <p className="muted">
            Code is optional. Each branch is reviewed and merged independently.
          </p>
        </div>
        <button
          className="icon-button"
          onClick={refresh}
          aria-label="Refresh branches"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <ErrorMessage>{error || detailError}</ErrorMessage>
      <div className="orchestration-branch-list">
        {branches.map((b) => (
          <button
            className={`orchestration-branch-button ${String(b.id) === selected ? "selected" : ""}`}
            key={b.id}
            onClick={() => setSelected(String(b.id))}
          >
            <GitBranch size={16} />
            <span>
              <strong>{b.name}</strong>
              <small>
                {b.repository_name} · {b.owner_name} · {b.state}
              </small>
            </span>
          </button>
        ))}
      </div>
      {!branches.length && state && (
        <p className="muted">No branches linked to this conversation.</p>
      )}
      {canWork && (
        <>
          <button
            className="button subtle"
            onClick={() => setCreating((v) => !v)}
          >
            <Plus size={15} />
            {creating ? "Cancel" : "Create or register branch"}
          </button>
          {creating && (
            <ActionForm
              api={api}
              path={`/repositories/${repoId}/branches`}
              label="Create or register branch"
              body={(f) => ({
                name: f.get("name"),
                thread_ids: [threadId],
                ...(f.get("base") ? { base: f.get("base") } : {}),
              })}
              onDone={(b) => {
                setCreating(false);
                setSelected(String(b.id));
                finished();
              }}
            >
              <label>
                Repository
                <select
                  name="repository"
                  aria-label="Repository"
                  required
                  value={repoId}
                  onChange={(e) => setRepoId(e.target.value)}
                >
                  <option value="">Choose a repository</option>
                  {state?.repositories?.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Branch name
                <input name="name" required placeholder="work/your-change" />
              </label>
              <label>
                Base commit (optional)
                <input
                  name="base"
                  pattern="[0-9a-f]{40}"
                  placeholder="Defaults to repository main"
                />
                <small>
                  An existing upstream branch is registered with its current
                  commits.
                </small>
              </label>
            </ActionForm>
          )}
        </>
      )}
      {canWork &&
        state?.branches?.some(
          (b) =>
            (b.owner_id === data.user.id || data.user.admin) &&
            !branches.some((linked) => linked.id === b.id),
        ) && (
          <LinkBranch
            api={api}
            branches={state.branches.filter(
              (b) =>
                (b.owner_id === data.user.id || data.user.admin) &&
                !branches.some((linked) => linked.id === b.id),
            )}
            threadId={threadId}
            onDone={finished}
          />
        )}
      {detail && (
        <section className="orchestration-card branch-detail">
          <h3>
            {detail.repository_name} / {detail.name}
          </h3>
          <p>
            Owner: <strong>{detail.owner_name}</strong> · {detail.state}
          </p>
          <label>
            Current commit
            <code className="orchestration-code">
              {detail.head_commit || "No commits available"}
            </code>
          </label>
          <p>
            Main branch: {repository?.main_branch || "main"}
            {repository?.require_human ? " · Human approval required" : ""}
          </p>
          <BranchDiff
            key={`${detail.id}:${detail.head_commit}`}
            api={api}
            branch={detail}
            onInspect={(result) =>
              setInspection({ ...result, branch_id: detail.id })
            }
          />
          <h4>Review history</h4>
          {detail.reviews?.length ? (
            detail.reviews.map((r) => (
              <article className="branch-review" key={r.id}>
                <strong>
                  {r.reviewer_name} ·{" "}
                  {r.decision === "approved" ? "Approved" : "Changes requested"}
                </strong>
                <small>
                  {r.commit_hash?.slice(0, 12)}
                  {r.commit_hash !== detail.head_commit
                    ? " · Earlier revision"
                    : " · Current revision"}
                  {r.target_commit
                    ? ` · Main ${r.target_commit.slice(0, 12)}`
                    : ""}
                  {r.require_human ? " · Human approval required" : ""}
                </small>
                {r.body && <p>{r.body}</p>}
              </article>
            ))
          ) : (
            <p className="muted">No reviews recorded.</p>
          )}
          {detail.state === "active" &&
            canReview &&
            detail.owner_id !== data.user.id && (
              <ActionForm
                key={`review:${detail.id}:${detail.head_commit}`}
                api={api}
                path={`/branches/${detail.id}/reviews`}
                label="Record review"
                disabled={
                  inspection?.branch_id === detail.id &&
                  inspection.commit !== detail.head_commit
                }
                body={(f) => ({
                  commit: detail.head_commit,
                  ...(inspection?.branch_id === detail.id &&
                  inspection.commit === detail.head_commit
                    ? { target_commit: inspection.target_commit }
                    : {}),
                  decision: f.get("decision"),
                  body: f.get("body"),
                  require_human: f.get("require_human") === "on",
                })}
                onDone={finished}
              >
                <p>
                  Review applies to commit{" "}
                  <code>{detail.head_commit?.slice(0, 12)}</code>.
                </p>
                <label>
                  Decision
                  <select name="decision" aria-label="Review decision">
                    <option value="approved">Approve</option>
                    <option value="changes_requested">Request changes</option>
                  </select>
                </label>
                <label>
                  Review notes
                  <textarea name="body" maxLength={20000} />
                </label>
                <label className="orchestration-checkbox">
                  <input name="require_human" type="checkbox" />
                  Require additional human approval
                </label>
              </ActionForm>
            )}
          <h4>Dependencies</h4>
          {detail.dependencies?.length ? (
            detail.dependencies.map((d) => (
              <div key={d.id}>
                <p>
                  {d.repository_name} / {d.name} · {d.state}
                </p>
                {detail.state === "active" &&
                  (detail.owner_id === data.user.id || data.user.admin) && (
                    <ActionForm
                      api={api}
                      path={`/branches/${detail.id}/dependencies/${d.id}`}
                      method="DELETE"
                      label="Remove dependency"
                      body={() => ({})}
                      onDone={finished}
                    />
                  )}
              </div>
            ))
          ) : (
            <p className="muted">No dependencies.</p>
          )}
          {detail.state === "active" &&
            (detail.owner_id === data.user.id || data.user.admin) && (
              <>
                <AddDependency
                  api={api}
                  detail={detail}
                  branches={state?.branches || []}
                  onDone={finished}
                />
                <ActionForm
                  key={`handoff:${detail.id}:${detail.owner_id}`}
                  api={api}
                  path={`/branches/${detail.id}/handoff`}
                  label="Transfer ownership"
                  body={(f) => ({ owner_id: Number(f.get("owner_id")) })}
                  onDone={finished}
                >
                  <label>
                    Hand off to
                    <select
                      name="owner_id"
                      aria-label="Hand off to"
                      required
                      defaultValue=""
                    >
                      <option value="" disabled>
                        Choose a worker
                      </option>
                      {data.users
                        .filter(
                          (u) =>
                            u.id !== detail.owner_id &&
                            state?.capabilities?.some(
                              (c) => c.user_id === u.id && c.can_work,
                            ),
                        )
                        .map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <small>
                    Transfers branch write access. The previous owner can still
                    fetch and review.
                  </small>
                </ActionForm>
              </>
            )}
          {detail.state === "active" &&
            canWork &&
            (detail.owner_id === data.user.id ||
              data.user.kind === "human") && (
              <ActionForm
                api={api}
                path={`/branches/${detail.id}/merge`}
                body={() => ({})}
                label="Request merge into main"
                onDone={finished}
              >
                <p>
                  Request integration of{" "}
                  <code>{detail.head_commit?.slice(0, 12)}</code>. The server
                  verifies approvals and dependencies before merging. Merges
                  must fast-forward: if main has moved, merge main into this
                  branch, push, and request a new review.
                </p>
              </ActionForm>
            )}
        </section>
      )}
    </section>
  );
}
function LinkBranch({ api, branches, threadId, onDone }) {
  const [branch, setBranch] = useState("");
  return (
    <ActionForm
      api={api}
      path={`/branches/${branch}/link`}
      label="Link branch"
      body={() => ({ thread_id: threadId })}
      onDone={onDone}
    >
      <label>
        Link an existing managed branch
        <select
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        >
          <option value="">Choose branch</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.repository_name} / {b.name}
            </option>
          ))}
        </select>
      </label>
    </ActionForm>
  );
}
function AddDependency({ api, detail, branches, onDone }) {
  const options = branches.filter(
    (b) =>
      b.id !== detail.id && !detail.dependencies?.some((d) => d.id === b.id),
  );
  if (!options.length) return null;
  return (
    <ActionForm
      key={`dependency:${detail.id}:${detail.dependencies?.length}`}
      api={api}
      path={`/branches/${detail.id}/dependencies`}
      label="Add dependency"
      body={(f) => ({ depends_on_id: Number(f.get("depends_on_id")) })}
      onDone={onDone}
    >
      <label>
        Must merge first
        <select
          name="depends_on_id"
          aria-label="Must merge first"
          required
          defaultValue=""
        >
          <option value="" disabled>
            Choose branch
          </option>
          {options.map((b) => (
            <option key={b.id} value={b.id}>
              {b.repository_name} / {b.name}
            </option>
          ))}
        </select>
      </label>
    </ActionForm>
  );
}

function BranchDiff({ api, branch, onInspect }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="branch-diff">
      <button
        className="button subtle"
        disabled={busy}
        onClick={async () => {
          if (diff) {
            setDiff(null);
            return;
          }
          setBusy(true);
          setError("");
          try {
            const result = await api(`/branches/${branch.id}/diff`);
            setDiff(result);
            onInspect(result);
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? "Loading changes…"
          : diff
            ? "Hide changes"
            : "Inspect changes against main"}
      </button>
      <ErrorMessage>{error}</ErrorMessage>
      {diff && (
        <>
          <p>
            Commit <code>{diff.commit?.slice(0, 12)}</code> against main{" "}
            <code>{diff.target_commit?.slice(0, 12)}</code>.
          </p>
          {diff.commit !== branch.head_commit && (
            <p role="alert">
              The branch changed. Refresh branches before recording a review.
            </p>
          )}
          <pre tabIndex={0} aria-label="Branch diff">
            {diff.diff || "No changes against main."}
          </pre>
        </>
      )}
    </div>
  );
}
