import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath, lstat } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("./git-credential.mjs", import.meta.url));
const locks = new Map();
const quoted = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const within = (root, path) => {
  const r = relative(root, path);
  return r !== ".." && !r.startsWith("../") && !isAbsolute(r);
};
async function directory(root, path) {
  if (!within(root, path))
    throw new Error("Workspace path escapes agent workspace");
  const parts = relative(root, path).split("/").filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    await mkdir(current).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Managed workspace directories must be real directories");
  }
  return realpath(path);
}
export async function prepareBranchWorkspace({
  workspace,
  branch,
  repository,
  identity,
  url = process.env.THREADWORK_URL || "http://localhost:3001",
  env = process.env,
}) {
  for (const id of [branch.id, repository.id])
    if (!Number.isSafeInteger(id) || id < 1)
      throw new Error("Invalid managed branch or repository ID");
  if (
    !branch.name ||
    !/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(branch.name) ||
    branch.name.includes("..")
  )
    throw new Error("Invalid managed branch name");
  const root = await realpath(workspace);
  const path = resolve(
    root,
    "repositories",
    String(repository.id),
    "branches",
    String(branch.id),
  );
  if (locks.has(path)) return locks.get(path);
  const operation = (async () => {
    await directory(root, dirname(path));
    const base = new URL(url);
    if (
      base.username ||
      base.password ||
      !["http:", "https:"].includes(base.protocol)
    )
      throw new Error("Board URL must be HTTP(S) without embedded credentials");
    const remote = `${base.href.replace(/\/$/, "")}/api/git/${repository.id}.git`;
    const gitEnv = {
      ...env,
      THREADWORK_URL: url,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };
    const git = async (args, cwd = root) => {
      try {
        return (
          await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
            cwd,
            env: gitEnv,
            timeout: 120000,
            maxBuffer: 1024 * 1024,
          })
        ).stdout.trim();
      } catch {
        throw new Error(
          "Managed Git operation failed. Check board access, branch ownership, and gateway availability; existing work was preserved.",
        );
      }
    };
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (info?.isSymbolicLink() || (info && !info.isDirectory()))
      throw new Error("Managed checkout must be a real directory");
    if (!info) {
      await git(["init", path]);
      await git(["remote", "add", "origin", remote], path);
    } else {
      const gitDir = await lstat(join(path, ".git")).catch(() => null);
      if (!gitDir?.isDirectory() || gitDir.isSymbolicLink())
        throw new Error(
          "Existing managed checkout is invalid; no files were changed",
        );
      if ((await git(["remote", "get-url", "origin"], path)) !== remote)
        throw new Error(
          "Existing checkout points to another remote; no files were changed",
        );
    }
    await git(
      ["config", "--local", "--replace-all", "credential.helper", ""],
      path,
    );
    await git(
      [
        "config",
        "--local",
        "--add",
        "credential.helper",
        `!${quoted(process.execPath)} ${quoted(helper)}`,
      ],
      path,
    );
    await git(["config", "--local", "credential.useHttpPath", "true"], path);
    if (identity) {
      if (!(await git(["config", "--get", "user.name"], path).catch(() => "")))
        await git(
          [
            "config",
            "--local",
            "user.name",
            identity.name || identity.username,
          ],
          path,
        );
      if (!(await git(["config", "--get", "user.email"], path).catch(() => "")))
        await git(
          [
            "config",
            "--local",
            "user.email",
            `${identity.username}@threadwork.local`,
          ],
          path,
        );
    }
    if (await git(["status", "--porcelain"], path))
      return {
        path,
        branch_id: branch.id,
        branch: branch.name,
        remote,
        preserved: true,
        message:
          "Existing uncommitted work preserved; checkout was not switched or reset.",
      };
    await git(
      [
        "fetch",
        "origin",
        `refs/heads/${branch.name}:refs/remotes/origin/${branch.name}`,
      ],
      path,
    );
    const current = await git(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      path,
    ).catch(() => "");
    const exists = await git(
      ["show-ref", "--verify", `refs/heads/${branch.name}`],
      path,
    ).then(
      () => true,
      () => false,
    );
    if (exists && current !== branch.name)
      throw new Error(
        "Checkout is on another branch; switch it explicitly to preserve existing work",
      );
    if (!exists)
      await git(["checkout", "-b", branch.name, `origin/${branch.name}`], path);
    // Never reset or rebase an existing checkout: local commits belong to the worker.
    await git(["config", `branch.${branch.name}.remote`, "origin"], path);
    await git(
      ["config", `branch.${branch.name}.merge`, `refs/heads/${branch.name}`],
      path,
    );
    return {
      path,
      branch_id: branch.id,
      branch: branch.name,
      remote,
      preserved: exists,
      message:
        "Use ordinary Git in this directory. Fetch before continuing handed-off work; local commits are never reset automatically.",
    };
  })();
  locks.set(path, operation);
  try {
    return await operation;
  } finally {
    locks.delete(path);
  }
}
