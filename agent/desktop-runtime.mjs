import { spawn } from "node:child_process";
import { mkdirSync, chmodSync, readlinkSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// The display is private to this worker container. Browsers are started lazily
// by the DevTools MCP server, on this display, with their own persistent profile.
const state = process.env.AGENT_DATA_DIR || "/state";
const runtime = process.env.XDG_RUNTIME_DIR || "/tmp/threadwork-runtime";
const env = {
  ...process.env,
  HOME: process.env.HOME?.startsWith(state + "/")
    ? process.env.HOME
    : join(state, "home"),
  DISPLAY: process.env.DISPLAY || ":99",
  XDG_RUNTIME_DIR: runtime,
};
for (const directory of [env.HOME, join(state, "browser"), runtime]) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}
// State volumes belong to exactly one worker. Chromium's singleton symlinks
// embed a container hostname and survive crashes; a replacement container must
// clear these stale links without resetting the browser's cookies or profile.
const browser = join(state, "browser");
try {
  const lock = readlinkSync(join(browser, "SingletonLock"));
  const match = lock.match(/^(.*)-(\d+)$/);
  if (match && match[1] === hostname()) {
    let live = false;
    try {
      process.kill(Number(match[2]), 0);
      live = true;
    } catch (error) {
      if (error.code !== "ESRCH") live = true;
    }
    if (live)
      throw new Error(
        "Persistent browser profile is already in use by a process in this container",
      );
  }
} catch (error) {
  if (!["ENOENT", "EINVAL"].includes(error.code)) throw error;
}
for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
  try {
    unlinkSync(join(browser, name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
env.XDG_CONFIG_HOME ||= join(env.HOME, ".config");
env.XDG_CACHE_HOME ||= join(env.HOME, ".cache");

let finish;
const finished = new Promise((resolve) => (finish = resolve));
let stopping = false;
const children = [];
const resolveExit = (code) => {
  if (!stopping) finish(code);
};
for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
])
  process.on(signal, () => resolveExit(code));

function launch(command, args, label) {
  const child = spawn(command, args, {
    env,
    detached: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const item = { child, exited: false };
  item.closed = new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`Could not start ${label}: ${error.message}`);
      item.exited = true;
      resolve();
      resolveExit(1);
    });
    child.on("close", (code, signal) => {
      item.exited = true;
      resolve();
      if (!stopping && label !== "worker")
        console.error(`${label} exited unexpectedly (${signal || code}).`);
      resolveExit(label === "worker" ? (code ?? 1) : 1);
    });
  });
  children.push(item);
  return item;
}
function probeDisplay() {
  return new Promise((resolve) => {
    const probe = spawn("xdpyinfo", ["-display", env.DISPLAY], {
      env,
      stdio: "ignore",
    });
    const timeout = setTimeout(() => probe.kill("SIGKILL"), 500);
    probe.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    probe.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}
function probeWindowManager() {
  return new Promise((resolve) => {
    const probe = spawn("xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    probe.stdout.on("data", (part) => (output += part));
    const timeout = setTimeout(() => probe.kill("SIGKILL"), 500);
    probe.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    probe.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0 && /window id # 0x[1-9a-f][0-9a-f]*/i.test(output));
    });
  });
}
function signalGroup(item, signal) {
  // Detached groups include browser/GUI descendants started by the worker.
  // The container's init process reaps orphaned descendants after shutdown.
  if (!item.child.pid) return;
  try {
    process.kill(-item.child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") console.error(error.message);
  }
}
async function main() {
  launch(
    "Xvfb",
    [
      env.DISPLAY,
      "-screen",
      "0",
      "1440x1000x24",
      "-nolisten",
      "tcp",
      "-noreset",
      "-ac",
    ],
    "virtual display",
  );
  const ready = (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await probeDisplay()) return true;
      await delay(100);
    }
    return false;
  })();
  const startup = await Promise.race([
    ready.then((ok) => ({ ready: ok })),
    finished.then((code) => ({ code })),
  ]);
  if (startup.ready) {
    launch("openbox", ["--sm-disable"], "window manager");
    const manager = await Promise.race([
      (async () => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await probeWindowManager()) return { ready: true };
          await delay(100);
        }
        return { ready: false };
      })(),
      finished.then((code) => ({ code })),
    ]);
    if (!manager.ready) {
      if (manager.code === undefined) {
        console.error("Window manager did not become ready within 10 seconds.");
        resolveExit(1);
      }
    } else {
      const args = process.argv.slice(2);
      launch(
        args.shift() || process.execPath,
        args.length || process.argv.length > 2
          ? args
          : [fileURLToPath(new URL("./worker.mjs", import.meta.url))],
        "worker",
      );
    }
  } else if (startup.code === undefined) {
    console.error("Virtual display did not become ready within 10 seconds.");
    resolveExit(1);
  }
  const code = startup.code ?? (await finished);
  stopping = true;
  for (const item of [...children].reverse()) signalGroup(item, "SIGTERM");
  await Promise.race([
    Promise.all(children.map((item) => item.closed)),
    delay(3000),
  ]);
  for (const item of children) signalGroup(item, "SIGKILL");
  process.exit(code);
}
main().catch((error) => {
  console.error(`Desktop runtime failed: ${error.message}`);
  stopping = true;
  for (const item of children) signalGroup(item, "SIGKILL");
  process.exit(1);
});
