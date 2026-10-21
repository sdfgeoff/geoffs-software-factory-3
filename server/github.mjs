// Provider requests never follow redirects and never expose provider response
// bodies in errors. Credentials are read afresh for every request to allow rotation.
const sha = /^[a-f0-9]{40}$/;
const ownerSegment = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const repoSegment = /^[A-Za-z0-9_.-]{1,100}$/;
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function validateGithubRepository(repo, env) {
  if (repo.merge_mode !== "pull_request") return;
  if (
    repo.pr_provider !== "github" ||
    !ownerSegment.test(repo.github_owner || "") ||
    !repoSegment.test(repo.github_repo || "") ||
    [".", ".."].includes(repo.github_repo)
  )
    fail(
      400,
      "Pull request mode requires GitHub owner, repository, and provider",
    );
  let owner, name;
  const scp = repo.url.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (scp) [, owner, name] = scp;
  else {
    let u;
    try {
      u = new URL(repo.url);
    } catch {
      fail(400, "GitHub mode requires a github.com repository URL");
    }
    if (
      u.hostname.toLowerCase() !== "github.com" ||
      !["https:", "ssh:"].includes(u.protocol) ||
      u.port ||
      u.search ||
      u.hash ||
      u.password ||
      (u.protocol === "https:" && u.username) ||
      (u.protocol === "ssh:" && u.username !== "git")
    )
      fail(400, "GitHub mode requires an HTTPS or git SSH github.com URL");
    const parts = u.pathname.replace(/^\//, "").split("/");
    if (parts.length !== 2)
      fail(400, "GitHub repository URL must identify owner and repository");
    [owner, name] = parts;
  }
  name = name.replace(/\.git$/i, "");
  if (
    owner.toLowerCase() !== repo.github_owner.toLowerCase() ||
    name.toLowerCase() !== repo.github_repo.toLowerCase()
  )
    fail(400, "GitHub configuration must match the Git repository URL");
  if (!repo.github_token_env || !env[repo.github_token_env])
    fail(503, "GitHub API credential is not configured on the server");
}
export function githubClient(repo, env, fetchImpl = fetch, shutdownSignal) {
  const path = `/repos/${encodeURIComponent(repo.github_owner)}/${encodeURIComponent(repo.github_repo)}`;
  async function request(suffix, { method = "GET", body } = {}) {
    const credential = env[repo.github_token_env];
    if (!credential)
      fail(503, "GitHub API credential is not configured on the server");
    let response;
    try {
      response = await fetchImpl(`https://api.github.com${path}${suffix}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${credential}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "Threadwork",
        },
        redirect: "error",
        signal: shutdownSignal
          ? AbortSignal.any([AbortSignal.timeout(10000), shutdownSignal])
          : AbortSignal.timeout(10000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail(
        502,
        "GitHub request failed or timed out; sync to reconcile its outcome",
      );
    }
    if (!response.ok)
      fail(
        response.status === 401 || response.status === 403 ? 503 : 409,
        `GitHub request failed (HTTP ${response.status}); check API access and repository settings`,
      );
    try {
      return await response.json();
    } catch {
      fail(502, "GitHub returned an invalid response");
    }
  }
  function validate(pr, branch) {
    const full = `${repo.github_owner}/${repo.github_repo}`.toLowerCase();
    if (
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      !["open", "closed"].includes(pr.state) ||
      pr.head?.repo?.full_name?.toLowerCase() !== full ||
      pr.base?.repo?.full_name?.toLowerCase() !== full ||
      pr.head.ref !== branch.name ||
      pr.base.ref !== repo.main_branch ||
      !sha.test(pr.head.sha) ||
      !sha.test(pr.base.sha) ||
      (pr.merge_commit_sha && !sha.test(pr.merge_commit_sha))
    )
      fail(
        502,
        "GitHub pull request identity or revision does not match this managed branch",
      );
    let url;
    try {
      url = new URL(pr.html_url);
    } catch {
      fail(502, "GitHub pull request URL is invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.toLowerCase() !== `/${full}/pull/${pr.number}`
    )
      fail(502, "GitHub pull request URL does not match this repository");
    return {
      number: pr.number,
      url: pr.html_url,
      state: pr.merged === true ? "merged" : pr.state,
      head_commit: pr.head.sha,
      base_commit: pr.base.sha,
      merge_commit: pr.merged === true ? pr.merge_commit_sha || null : null,
    };
  }
  async function get(number, branch) {
    if (!Number.isSafeInteger(number) || number < 1)
      fail(502, "GitHub pull request number is invalid");
    const value = await request(`/pulls/${number}`);
    if (value?.number !== number)
      fail(502, "GitHub returned a different pull request identity");
    return validate(value, branch);
  }
  async function find(branch, intent) {
    const list = await request(
      `/pulls?${new URLSearchParams({ state: "all", head: `${repo.github_owner}:${branch.name}`, base: repo.main_branch, per_page: "100" })}`,
    );
    if (!Array.isArray(list))
      fail(502, "GitHub returned an invalid pull request list");
    for (const candidate of list) {
      if (candidate.number === intent.previous_number) continue;
      if (
        candidate.head?.ref !== branch.name ||
        candidate.base?.ref !== repo.main_branch
      )
        continue;
      const marker = `<!-- threadwork-branch:${branch.id}:intent:${intent.intent_id} -->`;
      const matches =
        candidate.state === "open" ||
        (typeof candidate.body === "string" && candidate.body.includes(marker));
      if (matches) return get(candidate.number, branch);
    }
    return null;
  }
  return {
    get,
    find,
    create: async (branch, body) =>
      validate(await request("/pulls", { method: "POST", body }), branch),
  };
}
