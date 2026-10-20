import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  realpath,
  lstat,
  open,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { resolve, join, relative, isAbsolute, dirname } from "node:path";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
function enabled() {
  if (process.env.THREADWORK_DESKTOP !== "true" || !process.env.DISPLAY)
    throw new Error(
      "No virtual display is configured. Use the desktop-enabled worker image.",
    );
}
export async function desktopPath(
  workspace,
  path,
  { parentOnly = false } = {},
) {
  const root = await realpath(workspace),
    candidate = resolve(root, path);
  const target = parentOnly
    ? resolve(await realpath(dirname(candidate)), candidate.split("/").pop())
    : await realpath(candidate);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new Error("Path must be inside your workspace");
  return target;
}
async function artifacts(workspace) {
  const root = await realpath(workspace),
    dir = join(root, "screenshots");
  await mkdir(dir, { mode: 0o700 }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  if ((await lstat(dir)).isSymbolicLink())
    throw new Error("Screenshot directory must not be a symlink");
  return dir;
}
export async function screenshotDesktop(workspace, path) {
  enabled();
  const dir = await artifacts(workspace);
  const destination = await desktopPath(
    workspace,
    path || join(dir, `desktop-${randomUUID()}.png`),
    { parentOnly: true },
  );
  if (!destination.endsWith(".png"))
    throw new Error("Screenshot filename must end in .png");
  // scrot's image encoder needs a seekable file. Capture in a private temporary
  // directory, then exclusively create the requested artifact (never follow an
  // existing output symlink or overwrite a worker file).
  const temporary = await mkdtemp(join(dir, ".capture-"));
  let stdout;
  try {
    const capturePath = join(temporary, "desktop.png");
    await exec("scrot", [capturePath], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    stdout = await readFile(capturePath);
    if (stdout.length > 20 * 1024 * 1024)
      throw new Error("Desktop screenshot exceeds 20 MB");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  if (
    !stdout
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Desktop capture did not produce a PNG");
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(stdout);
  } finally {
    await file.close();
  }
  return { path: destination, data: stdout.toString("base64") };
}
export async function launchDesktop(
  workspace,
  { command, args = [], cwd = "." },
) {
  enabled();
  const directory = await desktopPath(workspace, cwd);
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Application directory must be inside your workspace");
  if (!command || command.includes("\0"))
    throw new Error("Application command is required");
  const logPath = join(
    await artifacts(workspace),
    `application-${randomUUID()}.log`,
  );
  const file = await open(logPath, "wx", 0o600);
  try {
    const child = spawn(command, args, {
      cwd: directory,
      env: process.env,
      stdio: ["ignore", file.fd, file.fd],
    });
    await new Promise((r, j) => {
      child.once("spawn", r);
      child.once("error", j);
    });
    child.unref();
    return {
      pid: child.pid,
      log_path: logPath,
      message:
        "Application launched on your virtual display. Inspect its log or desktop for startup errors. Processes stop with this worker container.",
    };
  } finally {
    await file.close();
  }
}
export async function listDesktopWindows() {
  enabled();
  let output;
  try {
    output = (
      await exec("xdotool", ["search", "--onlyvisible", "--name", "."], {
        timeout: 10000,
      })
    ).stdout.trim();
  } catch (e) {
    if (e.code === 1) return { windows: [] };
    throw e;
  }
  const windows = [];
  for (const id of output.split("\n").filter(Boolean).slice(0, 50)) {
    try {
      const title = (
        await exec("xdotool", ["getwindowname", id], { timeout: 3000 })
      ).stdout.trim();
      windows.push({ id, title });
    } catch {
      /* A window may close between enumeration and inspection. */
    }
  }
  return { windows };
}
export async function desktopInput({ action, x, y, button = 1, text, key }) {
  enabled();
  let args;
  if (action === "click") {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x > 8192 ||
      y > 8192 ||
      !Number.isInteger(button) ||
      button < 1 ||
      button > 5
    )
      throw new Error("Click requires valid x/y coordinates and mouse button");
    args = [
      "mousemove",
      "--sync",
      String(x),
      String(y),
      "click",
      String(button),
    ];
  } else if (action === "type") {
    if (typeof text !== "string" || text.length > 10000)
      throw new Error("Typing requires text up to 10000 characters");
    args = ["type", "--clearmodifiers", "--delay", "0", "--", text];
  } else if (action === "key") {
    if (
      typeof key !== "string" ||
      key.length > 200 ||
      !/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(key)
    )
      throw new Error("Use a key or combination such as Return or ctrl+l");
    args = ["key", "--clearmodifiers", key];
  } else throw new Error("Unknown desktop action");
  await exec("xdotool", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  return { ok: true };
}
