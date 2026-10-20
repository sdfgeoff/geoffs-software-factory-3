import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workerMcpConfig, browserMcpArgs } from "../agent/mcp-config.mjs";
import {
  desktopInput,
  launchDesktop,
  screenshotDesktop,
  desktopPath,
} from "../agent/desktop.mjs";

test("worker MCP config isolates browser credentials/profile and preserves the existing board configuration", () => {
  const plain = workerMcpConfig({
    workspace: "/state/workspace",
    stateDir: "/state",
  });
  assert.match(plain, /mcp_servers.threadwork/);
  assert.ok(!plain.includes("mcp_servers.chrome_devtools"));
  const desktop = workerMcpConfig({
    workspace: "/state/workspace",
    stateDir: "/state",
    desktop: true,
  });
  const browser = desktop.slice(
    desktop.indexOf("[mcp_servers.chrome_devtools]"),
  );
  assert.match(browser, /--userDataDir=\/state\/browser/);
  assert.match(browser, /--workspace=\/state\/workspace/);
  assert.ok(!browser.includes("AGENT_TOKEN"));
  assert.ok(!browser.includes("WORKER_INSTANCE"));
  assert.ok(!browser.includes("browserUrl"));
  assert.match(browser, /--no-usage-statistics/);
  assert.ok(
    !browserMcpArgs({ workspace: "/a", stateDir: "/b" }).includes("--headless"),
  );
});
test("desktop helpers require opt-in and preserve files at workspace boundaries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tw-desktop-path-"));
  const enabled = process.env.THREADWORK_DESKTOP;
  delete process.env.THREADWORK_DESKTOP;
  try {
    await assert.rejects(screenshotDesktop(dir), /No virtual display/);
    await assert.rejects(
      launchDesktop(dir, { command: "xterm" }),
      /No virtual display/,
    );
    await symlink(tmpdir(), join(dir, "outside"));
    await assert.rejects(
      desktopPath(dir, "outside/escape.png", { parentOnly: true }),
      /inside your workspace/,
    );
    await assert.rejects(
      desktopPath(dir, "../escape.png", { parentOnly: true }),
      /inside your workspace/,
    );
  } finally {
    if (enabled === undefined) delete process.env.THREADWORK_DESKTOP;
    else process.env.THREADWORK_DESKTOP = enabled;
    await rm(dir, { recursive: true, force: true });
  }
});
test("desktop capture creates PNG exclusively and native input uses literal arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tw-desktop-capture-"));
  const previous = { ...process.env };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
    "base64",
  );
  try {
    await writeFile(
      join(dir, "scrot"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.argv.at(-1),Buffer.from(${JSON.stringify(png.toString("base64"))},'base64'));`,
      { mode: 0o700 },
    );
    const argsFile = join(dir, "args.json");
    await writeFile(
      join(dir, "xdotool"),
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(process.argv.slice(2)));`,
      { mode: 0o700 },
    );
    process.env.PATH = dir + ":" + process.env.PATH;
    process.env.DISPLAY = ":199";
    process.env.THREADWORK_DESKTOP = "true";
    const shot = await screenshotDesktop(dir, "screen.png");
    assert.deepEqual(await readFile(shot.path), png);
    await assert.rejects(screenshotDesktop(dir, "screen.png"), /EEXIST/);
    await writeFile(join(dir, "original.png"), "keep");
    await symlink(join(dir, "original.png"), join(dir, "link.png"));
    await assert.rejects(screenshotDesktop(dir, "link.png"), /EEXIST/);
    assert.equal(await readFile(join(dir, "original.png"), "utf8"), "keep");
    const literal = "$(touch /tmp/should-never-exist); --option";
    await desktopInput({ action: "type", text: literal });
    assert.deepEqual(JSON.parse(await readFile(argsFile, "utf8")), [
      "type",
      "--clearmodifiers",
      "--delay",
      "0",
      "--",
      literal,
    ]);
    await assert.rejects(
      desktopInput({ action: "key", key: "--window 123" }),
      /key or combination/,
    );
    await assert.rejects(
      desktopInput({ action: "click", x: -1, y: 2 }),
      /coordinates/,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
