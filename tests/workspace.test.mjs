import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  symlink,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { prepareBranchWorkspace } from "../agent/git-workspace.mjs";
import { createApp } from "../server/app.mjs";
const exec = promisify(execFile);
async function credentials(fields, operation = "get") {
  const child = spawn(
    process.execPath,
    [resolve("agent/git-credential.mjs"), operation],
    {
      env: {
        ...process.env,
        THREADWORK_URL: "https://board.example",
        AGENT_TOKEN: "isolated-secret",
      },
    },
  );
  let result = "";
  child.stdout.on("data", (b) => (result += b));
  child.stdin.end(fields + "\n\n");
  await new Promise((r, j) => {
    child.on("error", j);
    child.on("close", r);
  });
  return result;
}
test("Git credential helper only supplies board credentials to the gateway", async () => {
  assert.match(
    await credentials("protocol=https\nhost=board.example\npath=api/git/1.git"),
    /password=isolated-secret/,
  );
  for (const fields of [
    "protocol=https\nhost=github.com\npath=api/git/1.git",
    "protocol=http\nhost=board.example\npath=api/git/1.git",
    "protocol=https\nhost=board.example\npath=api/other",
    "protocol=https\nhost=board.example.evil\npath=api/git/1.git",
  ])
    assert.equal(await credentials(fields), "");
  assert.equal(
    await credentials(
      "protocol=https\nhost=board.example\npath=api/git/1.git",
      "store",
    ),
    "",
  );
});
test("Managed workspace rejects symlink escape before running Git", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tw-path-"));
  try {
    await symlink(tmpdir(), join(dir, "repositories"));
    await assert.rejects(
      prepareBranchWorkspace({
        workspace: dir,
        repository: { id: 1 },
        branch: { id: 1, name: "work" },
      }),
      /real directories/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test(
  "Managed workspace clones through authenticated gateway, preserves edits and supports a handoff checkout",
  { timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tw-workspace-"));
    let app, server;
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = async (args, cwd) =>
      (await exec("git", args, { cwd, env: gitEnv })).stdout.trim();
    try {
      const upstream = join(dir, "upstream.git"),
        seed = join(dir, "seed");
      await git(["init", "--bare", "--initial-branch=main", upstream], dir);
      await git(["init", "--initial-branch=main", seed], dir);
      await writeFile(join(seed, "readme.txt"), "seed");
      await git(["add", "."], seed);
      await git(
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "seed",
        ],
        seed,
      );
      await git(["push", upstream, "main"], seed);
      app = createApp({
        dataDir: join(dir, "data"),
        env: {
          ADMIN_PASSWORD: "workspace-test-pass",
          AGENT_SPARK_TOKEN: "workspace-spark",
          AGENT_SAGE_TOKEN: "workspace-sage",
        },
      });
      server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const url = `http://127.0.0.1:${server.address().port}`;
      const login = await fetch(url + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "admin",
          password: "workspace-test-pass",
        }),
      });
      const cookie = login.headers.get("set-cookie").split(";")[0];
      async function api(path, body, agent) {
        const r = await fetch(url + "/api" + path, {
          method: body ? "POST" : "GET",
          headers: {
            "Content-Type": "application/json",
            ...(agent
              ? { Authorization: "Bearer " + agent }
              : { Cookie: cookie }),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
        const value = await r.json();
        assert.equal(r.status, 200, JSON.stringify(value));
        return value;
      }
      const repository = await api("/repositories", {
        name: "Workspace test",
        url: upstream,
        main_branch: "main",
      });
      const branch = await api(
        `/repositories/${repository.id}/branches`,
        { name: "work/first", thread_ids: [] },
        "workspace-spark",
      );
      const overview = await api("/bootstrap");
      const spark = overview.users.find((u) => u.username === "spark"),
        sage = overview.users.find((u) => u.username === "sage");
      const workspace = join(dir, "spark");
      await mkdir(workspace);
      const env = {
        ...gitEnv,
        AGENT_TOKEN: "workspace-spark",
        THREADWORK_URL: url,
      };
      const checkout = await prepareBranchWorkspace({
        workspace,
        branch,
        repository,
        url,
        env,
        identity: spark,
      });
      assert.equal(
        await readFile(join(checkout.path, "readme.txt"), "utf8"),
        "seed",
      );
      const config = await readFile(join(checkout.path, ".git/config"), "utf8");
      assert.ok(!config.includes("workspace-spark"));
      assert.ok(!config.includes(upstream));
      await writeFile(join(checkout.path, "change.txt"), "work");
      await exec("git", ["add", "."], { cwd: checkout.path, env });
      await exec("git", ["commit", "-m", "worker change"], {
        cwd: checkout.path,
        env,
      });
      await exec("git", ["push", "origin", branch.name], {
        cwd: checkout.path,
        env,
      });
      await writeFile(join(checkout.path, "scratch.txt"), "unfinished");
      const reopened = await prepareBranchWorkspace({
        workspace,
        branch,
        repository,
        url,
        env,
        identity: spark,
      });
      assert.equal(reopened.preserved, true);
      assert.equal(
        await readFile(join(checkout.path, "scratch.txt"), "utf8"),
        "unfinished",
      );
      await api(
        `/branches/${branch.id}/handoff`,
        { owner_id: sage.id },
        "workspace-spark",
      );
      const second = join(dir, "sage");
      await mkdir(second);
      const handed = await prepareBranchWorkspace({
        workspace: second,
        branch,
        repository,
        url,
        env: { ...gitEnv, AGENT_TOKEN: "workspace-sage" },
        identity: sage,
      });
      assert.equal(
        await readFile(join(handed.path, "change.txt"), "utf8"),
        "work",
      );
    } finally {
      if (server) await new Promise((r) => server.close(r));
      if (app) app.locals.shutdown();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
