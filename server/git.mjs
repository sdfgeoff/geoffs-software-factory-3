import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function gitEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: "/nonexistent",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
    ...extra,
  };
  return env;
}
export function git(cwd, args, extra = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "http.followRedirects=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd, env: gitEnv(extra), stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.stdout.on("data", (b) => {
      out += b;
      if (out.length > 4_000_000) child.kill();
    });
    child.stderr.on("data", (b) => {
      err += b;
      if (err.length > 1_000_000) child.kill();
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      code === 0
        ? resolvePromise(out.trim())
        : reject(
            Object.assign(
              new Error(
                "Git operation failed. Check repository access, branch history, and server configuration.",
              ),
              { gitError: err, status: 409 },
            ),
          );
    });
  });
}
export const repoPath = (dataDir, id) =>
  join(dataDir, "repositories", `${id}.git`);
export function upstreamEnv(repo, env) {
  if (!repo.credential_env) return {};
  const secret = env[repo.credential_env];
  if (!secret)
    throw Object.assign(
      new Error("Repository credential is not configured on the server"),
      { status: 503 },
    );
  if (!repo.url.startsWith("https://"))
    throw Object.assign(
      new Error("Token credentials require an HTTPS repository URL"),
      { status: 400 },
    );
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${repo.url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`,
  };
}
export async function initializeRepo(dataDir, repo, env) {
  const path = repoPath(dataDir, repo.id);
  mkdirSync(path, { recursive: true });
  await git(path, ["init", "--bare"]);
  await git(path, ["config", "http.receivepack", "true"]);
  await git(path, ["symbolic-ref", "HEAD", `refs/heads/${repo.main_branch}`]);
  await git(
    path,
    [
      "fetch",
      "--no-tags",
      repo.url,
      `+refs/heads/${repo.main_branch}:refs/heads/${repo.main_branch}`,
    ],
    upstreamEnv(repo, env),
  );
  const hook = join(path, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fileURLToPath(new URL("./git-hook.mjs", import.meta.url)).replaceAll("'", "'\\''")}'\n`,
    { mode: 0o700 },
  );
  writeFileSync(join(path, ".threadwork-ready"), "ready\n", { mode: 0o600 });
}
