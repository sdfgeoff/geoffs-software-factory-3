import React, { useEffect, useState } from "react";
import {
  GitBranch,
  RefreshCw,
  Plus,
  ExternalLink,
  ChevronDown,
} from "lucide-react";
import { QueueAction, useWorkQueue } from "./WorkQueue.jsx";
import {
  useRepositoryCredentials,
  RepositoryCredentialField,
  RepositoryCredentialsPanel,
  credentialSelectionFields,
} from "./RepositoryCredentials.jsx";

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
function mergePolicyFields(fields) {
  const mode = fields.get("merge_mode") || "direct";
  return {
    merge_mode: mode,
    ...credentialSelectionFields(fields, "github"),
    ...(mode === "pull_request"
      ? {
          pr_provider: "github",
          github_owner: fields.get("github_owner"),
          github_repo: fields.get("github_repo"),
        }
      : {}),
  };
}
function MergeModeFields({
  repository,
  api,
  credentials,
  onCredentialCreated,
}) {
  const [mode, setMode] = useState(repository?.merge_mode || "direct");
  return (
    <>
      <label>
        Merge mode
        <select
          name="merge_mode"
          aria-label="Merge mode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="direct">Direct merge by the board</option>
          <option value="pull_request">GitHub pull request</option>
        </select>
      </label>
      {mode === "direct" &&
        (repository?.github_credential_id ||
          repository?.github_token_configured) && (
          <details className="context-help">
            <summary>GitHub access retained from pull request mode</summary>
            <RepositoryCredentialField
              api={api}
              kind="github"
              repository={repository}
              credentials={credentials}
              onCreated={onCredentialCreated}
            />
          </details>
        )}
      {mode === "pull_request" && (
        <>
          <label>
            GitHub owner
            <input
              name="github_owner"
              defaultValue={repository?.github_owner || ""}
              required
              maxLength={100}
              placeholder="team-or-user"
            />
          </label>
          <label>
            GitHub repository
            <input
              name="github_repo"
              defaultValue={repository?.github_repo || ""}
              required
              maxLength={100}
              placeholder="project"
            />
          </label>
          <RepositoryCredentialField
            api={api}
            kind="github"
            repository={repository}
            credentials={credentials}
            onCreated={onCredentialCreated}
            required
          />
          <p className="muted">
            Board approval permits opening or updating a pull request. A human
            merges it on GitHub.
          </p>
        </>
      )}
    </>
  );
}
function mergeModeDescription(repository) {
  return repository?.merge_mode === "pull_request"
    ? `GitHub pull request${repository.github_owner && repository.github_repo ? ` · ${repository.github_owner}/${repository.github_repo}` : ""}`
    : "Direct merge by the board";
}
export function RepositoriesPage({ api, data, refreshKey, notify }) {
  const { state, error, refresh } = useOrchestration(api, refreshKey);
  const [view, setView] = useState("overview");
  const [filter, setFilter] = useState("");
  const [registering, setRegistering] = useState(false);
  const [credential, setCredential] = useState(null);
  const savedCredentials = useRepositoryCredentials(api, !!data.user.admin);
  const done = () => {
    refresh();
    notify("Repository registered");
    setRegistering(false);
  };
  const repositories = state?.repositories || [];
  const matches = repositories.filter((repo) =>
    `${repo.name} ${repo.url}`
      .toLowerCase()
      .includes(filter.trim().toLowerCase()),
  );
  return (
    <>
      <section className="page-heading">
        <div>
          <h1>Repositories</h1>
          <p className="muted">
            Browse code and branches. Open a repository to see its details.
          </p>
        </div>
        <div className="heading-actions">
          <button className="button subtle" onClick={refresh}>
            <RefreshCw size={15} />
            Refresh
          </button>
          {data.user.admin && view === "overview" && (
            <button
              className="button primary"
              aria-expanded={registering}
              aria-controls="repository-registration"
              onClick={() => setRegistering((v) => !v)}
            >
              <Plus size={16} />
              {registering ? "Cancel registration" : "Register repository"}
            </button>
          )}
        </div>
      </section>
      <div className="orchestration-content repository-workspace">
        <div
          className="repository-navigation"
          role="group"
          aria-label="Repository sections"
        >
          {[
            ["overview", "Overview"],
            ["access", "Git access"],
            ...(data.user.admin ? [["permissions", "Permissions"]] : []),
          ].map(([key, label]) => (
            <button
              key={key}
              className="button subtle"
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <ErrorMessage>{error}</ErrorMessage>
        <div className="repository-view" hidden={view !== "overview"}>
          <div id="repository-registration" hidden={!registering}>
            {" "}
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
                    ...credentialSelectionFields(f, "git"),
                    require_human: f.get("require_human") === "on",
                    ...mergePolicyFields(f),
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
                      placeholder="git@git.example.com:team/project.git"
                    />
                  </label>
                  <label>
                    Main branch
                    <input name="main_branch" required defaultValue="main" />
                  </label>
                  <RepositoryCredentialField
                    api={api}
                    kind="git"
                    credentials={savedCredentials.credentials}
                    onCreated={savedCredentials.upsert}
                  />
                  <MergeModeFields
                    api={api}
                    credentials={savedCredentials.credentials}
                    onCredentialCreated={savedCredentials.upsert}
                  />
                  <label className="orchestration-checkbox">
                    <input name="require_human" type="checkbox" />
                    Require human review before merging
                  </label>
                </ActionForm>
              </section>
            )}
          </div>
          {!state && !error && <p className="muted">Loading repositories…</p>}
          {repositories.length > 0 && (
            <div className="repository-list-heading">
              <h2>
                Connected repositories{" "}
                <span className="muted">{repositories.length}</span>
              </h2>
              <label className="repository-filter">
                Find a repository
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Name or Git URL"
                />
              </label>
            </div>
          )}
          {state && repositories.length === 0 && (
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
          {repositories.length > 0 && matches.length === 0 && (
            <p role="status">
              No repositories match.{" "}
              <button className="button subtle" onClick={() => setFilter("")}>
                Clear search
              </button>
            </p>
          )}
          <div className="repository-list">
            {repositories.map((repo) => (
              <RepositoryCard
                key={repo.id}
                repository={repo}
                hidden={!matches.includes(repo)}
                branches={
                  state.branches?.filter((b) => b.repository_id === repo.id) ||
                  []
                }
                api={api}
                admin={data.user.admin}
                savedCredentials={savedCredentials}
                refresh={refresh}
                notify={notify}
              />
            ))}
          </div>
        </div>
        <div className="repository-view" hidden={view !== "access"}>
          <div className="repository-view-heading">
            <h2>Git access</h2>
            <p className="muted">
              {data.user.admin
                ? "Your gateway credentials and the team's saved repository tokens."
                : "Create and revoke your own gateway credentials."}
            </p>
          </div>
          <section className="orchestration-card">
            <h2>Your Git access</h2>
            <details className="context-help">
              <summary>Using Git access</summary>
              <p>
                Use a board Git credential to clone, fetch, and push through the
                gateway. Your upstream repository credentials stay on the
                server.
              </p>
            </details>
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
          {data.user.admin && (
            <RepositoryCredentialsPanel
              api={api}
              credentials={savedCredentials.credentials}
              error={savedCredentials.error}
              onSaved={savedCredentials.upsert}
              onRemoved={savedCredentials.remove}
            />
          )}
        </div>
        {data.user.admin && (
          <div className="repository-view" hidden={view !== "permissions"}>
            {data.user.admin && state && (
              <section className="orchestration-card">
                <h2>Work and review permissions</h2>
                <details className="context-help">
                  <summary>Permission rules</summary>
                  <p>
                    Reviewers cannot approve their own work. Roles and prompts
                    do not grant these permissions.
                  </p>
                </details>
                <div className="orchestration-capabilities">
                  {data.users.map((user) => (
                    <CapabilityRow
                      key={user.id}
                      user={user}
                      value={state.capabilities?.find(
                        (c) => c.user_id === user.id,
                      )}
                      api={api}
                      refresh={refresh}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </>
  );
}
function RepositoryCard({
  repository: repo,
  branches,
  api,
  admin,
  savedCredentials,
  refresh,
  notify,
  hidden,
}) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const active = branches.filter((branch) => branch.state !== "merged");
  const merged = branches.filter((branch) => branch.state === "merged");
  const branchList = (rows) => (
    <ul className="repository-branches">
      {rows.map((branch) => (
        <li key={branch.id}>
          <div>
            <strong>{branch.name}</strong>
            <span className="muted">{branch.owner_name || ""}</span>
          </div>
          <span>
            {branch.pull_request?.state === "open"
              ? "PR open"
              : branch.state || "active"}
          </span>
        </li>
      ))}
    </ul>
  );
  return (
    <details className="orchestration-card repository-card" hidden={hidden}>
      <summary className="repository-summary">
        <GitBranch size={20} aria-hidden="true" />
        <div className="repository-summary-name">
          <h2>{repo.name}</h2>
          <span>
            {repo.merge_mode === "pull_request"
              ? "GitHub pull request"
              : "Direct merge"}{" "}
            · {repo.main_branch}
          </span>
        </div>
        <div className="repository-summary-status">
          <span>
            {active.length} active {active.length === 1 ? "branch" : "branches"}
          </span>
          {!!repo.require_human && <span>Human review required</span>}
        </div>
        <ChevronDown
          className="repository-chevron"
          size={18}
          aria-hidden="true"
        />
      </summary>
      <div className="repository-detail">
        <div className="repository-detail-heading">
          <h3>Repository details</h3>
          {!!admin && (
            <button
              className="button subtle"
              aria-expanded={editing}
              aria-controls={`repository-settings-${repo.id}`}
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Cancel settings" : "Edit settings"}
            </button>
          )}
        </div>
        <dl className="repository-facts">
          <div>
            <dt>Git URL</dt>
            <dd className="orchestration-code">{repo.url}</dd>
          </div>
          <div>
            <dt>Integration</dt>
            <dd>{mergeModeDescription(repo)}</dd>
          </div>
          <div>
            <dt>Review policy</dt>
            <dd>
              {repo.require_human
                ? "Human review required"
                : "Eligible reviewer approval required"}
            </dd>
          </div>
          <div>
            <dt>Git gateway URL</dt>
            <dd className="orchestration-code">
              {location.origin}/api/git/{repo.id}.git
            </dd>
          </div>
        </dl>
        <div id={`repository-settings-${repo.id}`}>
          {editing && (
            <ActionForm
              key={`policy:${repo.id}:${repo.require_human}:${repo.merge_mode}:${repo.github_owner}:${repo.github_repo}:${repo.github_token_configured}:${repo.git_credential_id}:${repo.github_credential_id}`}
              api={api}
              path={`/repositories/${repo.id}`}
              method="PATCH"
              body={(f) => ({
                require_human: f.get("require_human") === "on",
                ...credentialSelectionFields(f, "git"),
                ...mergePolicyFields(f),
              })}
              label="Save settings"
              onDone={() => {
                refresh();
                notify("Repository policy updated");
                setEditing(false);
              }}
            >
              <input type="hidden" name="existing_repository" value="true" />
              <RepositoryCredentialField
                api={api}
                kind="git"
                repository={repo}
                credentials={savedCredentials.credentials}
                onCreated={savedCredentials.upsert}
              />
              <MergeModeFields
                api={api}
                repository={repo}
                credentials={savedCredentials.credentials}
                onCredentialCreated={savedCredentials.upsert}
              />
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
        </div>
        <h3>Active branches</h3>
        {active.length ? (
          branchList(active)
        ) : (
          <p className="muted">No active branches.</p>
        )}
        <p className="muted">
          Create and manage branches from a thread’s Branches tab.
        </p>
        {merged.length > 0 && (
          <>
            <button
              className="button subtle repository-history"
              aria-expanded={history}
              aria-controls={`repository-history-${repo.id}`}
              onClick={() => setHistory((v) => !v)}
            >
              {history ? "Hide" : "Show"} merged branches ({merged.length})
            </button>
            <div id={`repository-history-${repo.id}`} hidden={!history}>
              {branchList(merged)}
            </div>
          </>
        )}
      </div>
    </details>
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

export function ThreadBranches({
  api,
  data,
  threadId,
  refreshKey,
  initialBranchId,
}) {
  const { state, error, refresh } = useOrchestration(api, refreshKey);
  const [branches, setBranches] = useState([]);
  const [selected, setSelected] = useState(
    initialBranchId ? String(initialBranchId) : "",
  );
  const [detail, setDetail] = useState(null);
  const [inspection, setInspection] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [creating, setCreating] = useState(false);
  const [repoId, setRepoId] = useState("");
  const { queue, refresh: refreshQueue } = useWorkQueue(api, state);
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
    refreshQueue();
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
          <p className="repository-merge-mode">
            Integration: <strong>{mergeModeDescription(repository)}</strong>
          </p>
          {(repository?.merge_mode === "pull_request" ||
            detail.pull_request) && (
            <PullRequestStatus
              api={api}
              branch={detail}
              canSync={
                detail.owner_id === data.user.id || data.user.kind === "human"
              }
              onDone={finished}
            />
          )}
          {detail.state === "active" &&
            detail.owner_id === data.user.id &&
            canWork && (
              <QueueAction
                api={api}
                path={`/branches/${detail.id}/submit-review`}
                body={{ commit: detail.head_commit }}
                label={
                  detail.submitted_commit === detail.head_commit
                    ? "Resubmit current commit for review"
                    : "Submit branch for review"
                }
                onDone={finished}
              >
                <p className="muted">
                  Submission notifies subscribed reviewers and frees your active
                  work capacity. Approval does not merge the branch.
                </p>
              </QueueAction>
            )}
          {detail.submitted_commit && (
            <p className="muted">
              Submitted revision:{" "}
              <code>{detail.submitted_commit.slice(0, 12)}</code>
              {detail.submitted_commit !== detail.head_commit
                ? " · Branch has newer commits; submit again for review."
                : ""}
            </p>
          )}
          {detail.review_claim_user_id ? (
            <p className="muted">
              Review claimed by{" "}
              {data.users.find((u) => u.id === detail.review_claim_user_id)
                ?.name || "another reviewer"}
              .
            </p>
          ) : null}
          {detail.state === "active" &&
            detail.submitted_commit === detail.head_commit &&
            canReview &&
            detail.owner_id !== data.user.id &&
            !detail.review_claim_user_id && (
              <QueueAction
                api={api}
                path={`/branches/${detail.id}/claim-review`}
                body={{ commit: detail.head_commit }}
                label="Claim branch review"
                disabled={!!queue?.active_claim}
                onDone={finished}
              />
            )}
          {detail.review_claim_user_id === data.user.id && (
            <QueueAction
              api={api}
              path={`/branches/${detail.id}/release-review`}
              body={{ commit: detail.head_commit }}
              label="Release branch review"
              onDone={finished}
            />
          )}
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
                  (detail.review_claim_user_id &&
                    detail.review_claim_user_id !== data.user.id) ||
                  (inspection?.branch_id === detail.id &&
                    inspection.commit !== detail.head_commit)
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
                label={
                  repository?.merge_mode === "pull_request"
                    ? "Open/update pull request"
                    : "Request merge into main"
                }
                onDone={finished}
              >
                <p>
                  {repository?.merge_mode === "pull_request" ? (
                    <>
                      Publish commit{" "}
                      <code>{detail.head_commit?.slice(0, 12)}</code> to a
                      GitHub pull request after board approvals and dependencies
                      pass. A human performs the merge on GitHub; its branch
                      rules still apply.
                    </>
                  ) : (
                    <>
                      Request integration of{" "}
                      <code>{detail.head_commit?.slice(0, 12)}</code>. The
                      server verifies approvals and dependencies before merging.
                      Merges must fast-forward: if main has moved, merge main
                      into this branch, push, and request a new review.
                    </>
                  )}
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

function PullRequestStatus({ api, branch, canSync, onDone }) {
  const pr = branch.pull_request;
  return (
    <section className="branch-pull-request" aria-label="Pull request status">
      <h4>GitHub pull request{pr?.number ? ` #${pr.number}` : ""}</h4>
      {pr ? (
        <>
          <p>
            <strong>
              {!pr.number || !pr.url
                ? "Publication pending"
                : { open: "Open", closed: "Closed", merged: "Merged" }[
                    pr.state
                  ] || "Publication pending"}
            </strong>
            {pr.url && (
              <>
                {" "}
                ·{" "}
                <a href={pr.url} target="_blank" rel="noreferrer">
                  View on GitHub <ExternalLink size={12} />
                </a>
              </>
            )}
          </p>
          {pr.synced_at && (
            <p className="muted">
              Last synced {new Date(pr.synced_at).toLocaleString()}
            </p>
          )}
          {pr.head_commit && (
            <p className="muted">
              Pull request head: <code>{pr.head_commit.slice(0, 12)}</code>
              {pr.head_commit !== branch.head_commit
                ? " · PR revision differs from managed branch; board reviews apply only to their recorded commit."
                : ""}
            </p>
          )}
          {pr.base_commit && (
            <p className="muted">
              Pull request base: <code>{pr.base_commit.slice(0, 12)}</code>
            </p>
          )}
          {pr.merge_commit && (
            <p className="muted">
              Merge commit: <code>{pr.merge_commit.slice(0, 12)}</code>
            </p>
          )}
          {pr.error && (
            <p className="form-error" role="alert">
              {pr.error}
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          No pull request published yet. Board approval is required before
          opening one.
        </p>
      )}
      {canSync && pr && (
        <ActionForm
          api={api}
          path={`/branches/${branch.id}/pull-request/sync`}
          body={() => ({})}
          label="Refresh pull request status"
          onDone={onDone}
        />
      )}
    </section>
  );
}
