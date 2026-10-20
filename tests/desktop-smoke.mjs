// Opt-in real GUI/browser smoke for the desktop worker image. No model inference.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserMcpArgs } from "../agent/mcp-config.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

assert.ok(
  process.env.DISPLAY,
  "Run test:desktop inside the desktop worker image through desktop-runtime (DISPLAY required).",
);
const root = await mkdtemp(join(tmpdir(), "threadwork-desktop-smoke-"));
const workspace = join(root, "workspace");
const profile = join(root, "browser");
const home = join(root, "home");
await Promise.all([mkdir(workspace), mkdir(profile), mkdir(home)]);
const env = {
  PATH: process.env.PATH,
  DISPLAY: process.env.DISPLAY,
  ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  HOME: home,
  CODEX_HOME: join(root, "codex"),
  AGENT_DATA_DIR: root,
  AGENT_WORKSPACE: workspace,
  AGENT_TOKEN: "isolated-desktop-test-token",
  WORKER_INSTANCE: "",
  THREADWORK_URL: "http://127.0.0.1:1",
  THREADWORK_DESKTOP: "true",
  OPENAI_API_KEY: "",
  LANG: "C.UTF-8",
  CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1",
  CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
};
const clients = new Set();
const applicationPids = new Set();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (result) =>
  result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
async function eventually(fn, label, timeout = 12000) {
  const end = Date.now() + timeout;
  let error;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (e) {
      error = e;
      await pause(150);
    }
  }
  throw new Error(`${label}: ${error?.message || "timed out"}`, {
    cause: error,
  });
}
async function connect(args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env,
    stderr: "pipe",
  });
  // Drain stderr so a verbose browser cannot block on its pipe.
  let diagnostics = "";
  transport.stderr?.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-12000);
  });
  const client = new Client({
    name: "threadwork-desktop-smoke",
    version: "1.0.0",
  });
  clients.add(client);
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(`${e.message}\n${diagnostics}`, { cause: e });
  }
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 45000,
  });
  assert.ok(!result.isError, `${name}: ${text(result)}`);
  return result;
}
async function json(client, name, args = {}) {
  return JSON.parse(text(await call(client, name, args)));
}
function png(data, label) {
  assert.ok(
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    `${label} PNG signature`,
  );
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  assert.ok(
    width >= 640 && height >= 400 && width <= 8192 && height <= 8192,
    `${label} dimensions ${width}x${height}`,
  );
  return { width, height };
}
function uid(snapshot, role, name) {
  const line = snapshot
    .split("\n")
    .find((line) => line.includes(`${role} "${name}"`));
  assert.ok(line, `Snapshot contains ${role} ${name}: ${snapshot}`);
  const match = line.match(/uid=([^\s]+)/);
  assert.ok(match, `Snapshot UID for ${name}`);
  return match[1];
}
async function stopBrowserProcesses() {
  // Kill only this smoke's unique profile, never other browsers on the display.
  for (const entry of await readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const command = await readFile(`/proc/${entry}/cmdline`, "utf8");
      if (command.includes(profile) && command.includes("chromium"))
        process.kill(Number(entry), "SIGTERM");
    } catch {
      /* Process already exited. */
    }
  }
}
async function close(client) {
  if (!client) return;
  await client.close().catch(() => {});
  clients.delete(client);
}
const fixture = createServer((request, response) => {
  if (request.url.startsWith("/echo")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        message: new URL(request.url, "http://fixture").searchParams.get(
          "name",
        ),
      }),
    );
    return;
  }
  if (request.url === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>Threadwork isolated browser smoke</title></head><body>
  <h1>Browser smoke fixture</h1><label>Smoke name<input id="name"></label><button id="save">Save sample</button><p id="output" role="status"></p>
  <script>const output=document.querySelector('#output');output.textContent=localStorage.getItem('smoke-value')||'Empty profile';
  document.querySelector('#save').onclick=async()=>{const name=document.querySelector('#name').value;const result=await(await fetch('/echo?name='+encodeURIComponent(name))).json();localStorage.setItem('smoke-value','Saved '+result.message);output.textContent='Saved '+result.message;console.log('threadwork-smoke-console',result.message)};</script></body></html>`);
});
fixture.listen(0, "127.0.0.1");
await new Promise((r) => fixture.once("listening", r));
const url = `http://127.0.0.1:${fixture.address().port}`;
const browserArgs = browserMcpArgs({ workspace, stateDir: root });
try {
  let browser = await connect(browserArgs);
  let pageId;
  const pageCall = (name, args = {}) =>
    call(browser, name, { pageId, ...args });
  async function openFixture() {
    await call(browser, "new_page", { url });
    const pages = text(await call(browser, "list_pages"));
    const selected = pages
      .split("\n")
      .find(
        (line) =>
          /^\d+:/.test(line) &&
          line.includes(url) &&
          line.includes("[selected]"),
      );
    assert.ok(selected, `Selected local fixture page: ${pages}`);
    pageId = Number(selected.match(/^(\d+):/)[1]);
  }
  const tools = (await browser.listTools()).tools.map((t) => t.name);
  for (const name of [
    "new_page",
    "list_pages",
    "take_snapshot",
    "click",
    "type_text",
    "list_console_messages",
    "get_console_message",
    "list_network_requests",
    "get_network_request",
    "take_screenshot",
  ])
    assert.ok(tools.includes(name), `Browser MCP exposes ${name}`);
  await openFixture();
  let snapshot = text(await pageCall("take_snapshot"));
  assert.match(snapshot, /Empty profile/);
  await pageCall("click", { uid: uid(snapshot, "textbox", "Smoke name") });
  await pageCall("type_text", { text: "sprouting seeds" });
  snapshot = text(await pageCall("take_snapshot"));
  await pageCall("click", { uid: uid(snapshot, "button", "Save sample") });
  await eventually(
    async () =>
      assert.match(
        text(await pageCall("take_snapshot")),
        /Saved sprouting seeds/,
      ),
    "Browser click and typing updated DOM",
  );
  const consoleMessages = text(await pageCall("list_console_messages"));
  assert.match(consoleMessages, /threadwork-smoke-console/);
  const messageLine = consoleMessages
    .split("\n")
    .find((line) => line.includes("threadwork-smoke-console"));
  const messageId = messageLine.match(/msgid=(\d+)/);
  assert.ok(messageId, `Console message ID: ${consoleMessages}`);
  assert.match(
    text(
      await pageCall("get_console_message", {
        msgid: Number(messageId[1]),
      }),
    ),
    /sprouting seeds/,
  );
  const network = text(await pageCall("list_network_requests"));
  const echoLine = network
    .split("\n")
    .find((line) => line.includes("/echo?name="));
  assert.ok(echoLine, `Network captured local fixture request: ${network}`);
  const requestId = echoLine.match(/reqid=(\d+)/);
  assert.ok(requestId, `Network request ID: ${echoLine}`);
  const request = text(
    await pageCall("get_network_request", { reqid: Number(requestId[1]) }),
  );
  assert.match(request, /sprouting seeds/);
  const browserScreenshot = join(workspace, "browser.png");
  await pageCall("take_screenshot", {
    format: "png",
    filePath: browserScreenshot,
  });
  const browserDimensions = png(
    await readFile(browserScreenshot),
    "Browser screenshot",
  );
  await close(browser);
  browser = null;
  await stopBrowserProcesses();
  await eventually(async () => {
    try {
      await lstat(join(profile, "SingletonLock"));
      throw new Error("Profile still locked");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }, "Browser profile released");
  browser = await connect(browserArgs);
  await openFixture();
  assert.match(
    text(await pageCall("take_snapshot")),
    /Saved sprouting seeds/,
    "Same isolated profile preserves browser state after MCP restart",
  );
  await close(browser);
  await stopBrowserProcesses();

  const board = await connect([resolve("agent/mcp.mjs")]);
  const boardTools = (await board.listTools()).tools.map((t) => t.name);
  for (const name of [
    "desktop_launch",
    "desktop_list_windows",
    "desktop_input",
    "desktop_screenshot",
  ])
    assert.ok(boardTools.includes(name), `Board MCP exposes ${name}`);
  const launched = await json(board, "desktop_launch", {
    command: "/usr/bin/xterm",
    args: [
      "-title",
      "Threadwork Desktop Smoke",
      "-geometry",
      "80x20+0+0",
      "-e",
      "/bin/sh",
    ],
    cwd: ".",
  });
  assert.ok(Number.isInteger(launched.pid) && launched.pid > 1);
  applicationPids.add(launched.pid);
  assert.ok(launched.log_path.startsWith(workspace + "/"));
  assert.ok(
    (await stat(launched.log_path)).isFile(),
    "Launched application has a workspace log",
  );
  await eventually(async () => {
    const windows = await json(board, "desktop_list_windows");
    assert.ok(
      windows.windows.some((w) => w.title.includes("Threadwork Desktop Smoke")),
    );
  }, "Xterm window is visible");
  // Openbox focuses newly created windows; click its client area explicitly too.
  await call(board, "desktop_input", { action: "click", x: 110, y: 90 });
  await call(board, "desktop_input", {
    action: "type",
    text: "printf 'desktop-input-ok' > desktop-input.txt",
  });
  await call(board, "desktop_input", { action: "key", key: "Return" });
  await eventually(
    async () =>
      assert.equal(
        await readFile(join(workspace, "desktop-input.txt"), "utf8"),
        "desktop-input-ok",
      ),
    "Desktop input reached launched shell",
  );
  const desktop = await call(board, "desktop_screenshot", {
    path: "desktop.png",
  });
  const image = desktop.content.find((c) => c.type === "image");
  assert.ok(
    image && image.mimeType === "image/png",
    "Desktop MCP returns inline PNG",
  );
  const imageBytes = Buffer.from(image.data, "base64");
  const desktopDimensions = png(imageBytes, "Desktop screenshot");
  assert.deepEqual(
    await readFile(join(workspace, "desktop.png")),
    imageBytes,
    "Inline screenshot equals saved artifact",
  );
  for (const args of [{ path: "../escape.png" }, { path: "desktop.png" }]) {
    const rejected = await board.callTool({
      name: "desktop_screenshot",
      arguments: args,
    });
    assert.equal(
      rejected.isError,
      true,
      "Desktop screenshot rejects traversal and overwriting existing artifact",
    );
  }
  await symlink(root, join(workspace, "outside"));
  assert.equal(
    (
      await board.callTool({
        name: "desktop_screenshot",
        arguments: { path: "outside/symlink-escape.png" },
      })
    ).isError,
    true,
    "Desktop screenshot rejects parent symlink escape",
  );
  assert.equal(
    (
      await board.callTool({
        name: "desktop_launch",
        arguments: { command: "/usr/bin/true", cwd: root },
      })
    ).isError,
    true,
    "GUI launch rejects workspace escape",
  );
  await call(board, "desktop_input", { action: "type", text: "exit" });
  await call(board, "desktop_input", { action: "key", key: "Return" });
  await close(board);
  console.log(
    JSON.stringify(
      {
        verified:
          "Headed Chromium MCP snapshot, click/type, console and network inspection, screenshot, isolated profile restart; real Xterm launch, desktop input/window discovery/capture, workspace boundaries",
        browser_screenshot: browserDimensions,
        desktop_screenshot: desktopDimensions,
        inference: false,
        host_credentials: false,
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) await close(client);
  await stopBrowserProcesses();
  for (const pid of applicationPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* Already exited. */
    }
  }
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await rm(root, { recursive: true, force: true });
}
