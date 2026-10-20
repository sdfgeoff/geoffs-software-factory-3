import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "threadwork-desktop-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const program = (name, body) =>
    writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, {
      mode: 0o700,
    });
  const daemon = (name) =>
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(dir, name + ".started"))},JSON.stringify({pid:process.pid,args:process.argv.slice(2),HOME:process.env.HOME,DISPLAY:process.env.DISPLAY,XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR}));process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(join(dir, name + ".stopped"))},'yes');process.exit(0)});setInterval(()=>{},1000);`;
  program("Xvfb", daemon("display"));
  program("openbox", daemon("wm"));
  program("xdpyinfo", "process.exit(0)");
  program(
    "xprop",
    `console.log('_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234')`,
  );
  program("fixture-worker", daemon("worker"));
  const start = () => {
    const child = spawn(
      process.execPath,
      [resolve("agent/desktop-runtime.mjs"), "fixture-worker"],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AGENT_DATA_DIR: join(dir, "state"),
          XDG_RUNTIME_DIR: join(dir, "runtime"),
          DISPLAY: ":177",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.on("data", (b) => (output += b));
    const closed = new Promise((r) =>
      child.on("close", (code, signal) => r({ code, signal, output })),
    );
    return { child, closed };
  };
  return { dir, program, start };
}
async function waitFor(path) {
  for (let i = 0; i < 150 && !existsSync(path); i++) await delay(20);
  assert.ok(existsSync(path), `Missing ${path}`);
}

test("desktop supervisor starts a private display, supplies persistent paths, and terminates its process groups", async () => {
  const f = fixture();
  const profile = join(f.dir, "state", "browser");
  mkdirSync(profile, { recursive: true });
  for (const [name, target] of [
    ["SingletonLock", "old-container-999999"],
    ["SingletonCookie", "old-cookie"],
    ["SingletonSocket", "/tmp/missing-browser-socket"],
  ])
    symlinkSync(target, join(profile, name));
  writeFileSync(join(profile, "Preferences"), "persistent-profile");
  const { child, closed } = f.start();
  try {
    await waitFor(join(f.dir, "worker.started"));
    await waitFor(join(f.dir, "wm.started"));
    const display = JSON.parse(readFileSync(join(f.dir, "display.started"))),
      worker = JSON.parse(readFileSync(join(f.dir, "worker.started")));
    assert.deepEqual(display.args, [
      ":177",
      "-screen",
      "0",
      "1440x1000x24",
      "-nolisten",
      "tcp",
      "-noreset",
      "-ac",
    ]);
    assert.equal(worker.HOME, join(f.dir, "state", "home"));
    assert.equal(worker.DISPLAY, ":177");
    assert.equal(worker.XDG_RUNTIME_DIR, join(f.dir, "runtime"));
    assert.ok(existsSync(join(f.dir, "state", "browser")));
    assert.equal(
      readFileSync(join(profile, "Preferences"), "utf8"),
      "persistent-profile",
    );
    assert.throws(() => lstatSync(join(profile, "SingletonLock")), {
      code: "ENOENT",
    });
    child.kill("SIGTERM");
    assert.equal((await closed).code, 143);
    for (const name of ["display", "wm", "worker"])
      assert.ok(
        existsSync(join(f.dir, name + ".stopped")),
        `${name} received SIGTERM`,
      );
  } finally {
    child.kill("SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});
test("desktop supervisor fails when the display exits and never launches the worker", async () => {
  const f = fixture();
  f.program("Xvfb", "process.exit(42)");
  f.program("xdpyinfo", "process.exit(1)");
  const { child, closed } = f.start();
  try {
    const result = await closed;
    assert.equal(result.code, 1);
    assert.equal(existsSync(join(f.dir, "worker.started")), false);
    assert.match(result.output, /virtual display exited unexpectedly/);
  } finally {
    child.kill("SIGKILL");
    rmSync(f.dir, { recursive: true, force: true });
  }
});
