import { test } from "node:test";
import assert from "node:assert/strict";
import { httpRequests, mcpRequests } from "../shared/requests.mjs";
import {
  repositoryResult,
  branchResult,
  publicResult,
  httpResultContract,
} from "../shared/results.mjs";
const sha = "a".repeat(40);
const branch = {
  id: 1,
  repository_id: 1,
  name: "feature/example",
  owner_id: 2,
  state: "active",
  head_commit: sha,
  created_at: "2026-10-21T00:00:00Z",
  merged_at: null,
  merge_mode: "pull_request",
  pull_request: {
    number: 7,
    url: "https://github.com/team/project/pull/7",
    state: "open",
    head_commit: sha,
    base_commit: "b".repeat(40),
    merge_commit: null,
    synced_at: "2026-10-21T00:00:00Z",
    error: null,
  },
};

test("repository policy requests preserve existing direct defaults and validate provider configuration consistently", () => {
  const direct = httpRequests.repositoryCreate.parse({
    name: "Example",
    url: "git@github.com:team/project.git",
  });
  assert.equal(direct.merge_mode, "direct");
  assert.equal(direct.main_branch, "main");
  assert.equal(direct.require_human, false);
  assert.equal(
    httpRequests.repositoryUpdate.parse({ github_repo: ".github" }).github_repo,
    ".github",
  );
  const policy = {
    merge_mode: "pull_request",
    pr_provider: "github",
    github_owner: "team",
    github_repo: "project",
    github_token_env: "GITHUB_PR_TOKEN",
  };
  assert.deepEqual(
    httpRequests.repositoryUpdate.parse(policy),
    mcpRequests.repositoryUpdate.parse(policy),
  );
  for (const input of [
    {},
    { merge_mode: "automatic" },
    { pr_provider: "untrusted" },
    { github_owner: "../team" },
    { github_repo: "project/../../other" },
    { github_token_env: "paste-a-secret" },
    { credential_env: "not-an-environment-reference" },
    { git_credential_id: 0 },
    { github_credential_id: -1 },
  ])
    assert.equal(httpRequests.repositoryUpdate.safeParse(input).success, false);
  const storedCredentials = {
    git_credential_id: 1,
    github_credential_id: 2,
    credential_env: null,
    github_token_env: null,
  };
  assert.deepEqual(
    httpRequests.repositoryUpdate.parse(storedCredentials),
    storedCredentials,
  );
  assert.deepEqual(
    mcpRequests.repositoryUpdate.parse(storedCredentials),
    storedCredentials,
  );
  assert.equal(
    httpRequests.repositoryUpdate.parse({ credential_env: "OTHER" })
      .credential_env,
    "OTHER",
  );
  assert.deepEqual(
    httpRequests.repositoryUpdate.parse({ github_token_env: null }),
    { github_token_env: null },
  );
});

test("PR branch results preserve exact revisions and external lifecycle without exposing private configuration", () => {
  assert.deepEqual(publicResult("request_branch_merge", branch), branch);
  assert.deepEqual(publicResult("sync_branch_pull_request", branch), branch);
  assert.equal(
    httpResultContract("POST", "/api/branches/1/pull-request/sync"),
    branchResult,
  );
  const closed = structuredClone(branch);
  closed.pull_request.state = "closed";
  assert.equal(
    branchResult.parse(closed).state,
    "active",
    "Closed without merge is not branch completion",
  );
  const pending = structuredClone(branch);
  pending.pull_request.number = null;
  pending.pull_request.url = null;
  pending.pull_request.synced_at = null;
  assert.ok(branchResult.safeParse(pending).success);
  assert.equal(
    branchResult.safeParse({ ...branch, github_token_env: "SECRET_VARIABLE" })
      .success,
    false,
  );
  assert.equal(
    branchResult.safeParse({
      ...branch,
      pull_request: { ...branch.pull_request, token: "private" },
    }).success,
    false,
  );
  const repo = {
    id: 1,
    name: "Project",
    url: "git@github.com:team/project.git",
    main_branch: "main",
    require_human: 0,
    created_by: 1,
    created_at: "stamp",
    credential_configured: false,
    merge_mode: "pull_request",
    pr_provider: "github",
    github_owner: "team",
    github_repo: "project",
    github_token_configured: true,
  };
  assert.ok(repositoryResult.safeParse(repo).success);
  assert.equal(
    repositoryResult.safeParse({ ...repo, github_token_env: "SECRET_VARIABLE" })
      .success,
    false,
  );
  assert.equal(
    httpResultContract("POST", "/api/repositories"),
    repositoryResult,
  );
  assert.equal(
    httpResultContract("PATCH", "/api/repositories/1"),
    repositoryResult,
  );
});
