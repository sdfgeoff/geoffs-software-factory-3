// Real installed Codex, isolated credentials, no model inference. Run with npm run test:codex.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { createApp } from "../server/app.mjs";
import { CodexClient } from "../agent/codex.mjs";
import { workerMcpConfig } from "../agent/mcp-config.mjs";
const dir = mkdtempSync(join(tmpdir(), "threadwork-real-codex-"));
const home = join(dir, "codex");
mkdirSync(home);
const app = createApp({
  dataDir: join(dir, "data"),
  env: {
    ADMIN_PASSWORD: "codex-smoke-password",
    AGENT_SPARK_TOKEN: "smoke-agent-token",
  },
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
writeFileSync(
  join(home, "config.toml"),
  workerMcpConfig({
    workspace: dir,
    stateDir: dir,
    desktop: process.env.THREADWORK_DESKTOP === "true",
  }),
);
const clientOptions = {
  cwd: dir,
  env: {
    ...process.env,
    CODEX_HOME: home,
    AGENT_TOKEN: "smoke-agent-token",
    THREADWORK_URL: `http://127.0.0.1:${server.address().port}`,
    AGENT_WORKSPACE: dir,
    OPENAI_API_KEY: "",
  },
};
let client = new CodexClient(clientOptions);
try {
  await client.initialize();
  const account = await client.call("account/read", {});
  assert.equal(
    account.account,
    null,
    "isolated home must not use host credentials",
  );
  const thread = await client.call("thread/start", {
    cwd: dir,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  assert.ok(thread.thread.id);
  const status = await client.call("mcpServerStatus/list", {});
  const mcp = status.data.find((s) => s.name === "threadwork");
  assert.ok(mcp, "MCP server is configured");
  assert.ok(
    Object.keys(mcp.tools).length >= 20,
    "Codex discovered board and reminder tools",
  );
  if (process.env.THREADWORK_DESKTOP === "true") {
    const browser = status.data.find((s) => s.name === "chrome_devtools");
    assert.ok(browser, "Browser MCP server is configured");
    assert.ok(
      browser.tools.take_screenshot,
      "Codex discovered browser screenshots",
    );
    assert.ok(
      mcp.tools.desktop_screenshot,
      "Codex discovered native desktop screenshots",
    );
    console.log(
      `Codex discovered Chrome DevTools (${Object.keys(browser.tools).length} tools) and native desktop tools.`,
    );
  }
  await client.call("thread/inject_items", {
    threadId: thread.thread.id,
    items: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Persistent agent initialized. No action requested.",
          },
        ],
      },
    ],
  });
  // Verify persistence on disk, not merely a resume backed by process memory.
  const closed = new Promise((resolve) => client.once("closed", resolve));
  client.stop();
  await closed;
  client = new CodexClient(clientOptions);
  await client.initialize();
  assert.equal((await client.call("account/read", {})).account, null);
  const resumed = await client.call("thread/resume", {
    threadId: thread.thread.id,
  });
  assert.equal(resumed.thread.id, thread.thread.id);
  console.log(
    `Real Codex protocol verified: initialize, unauthenticated account, thread/start, MCP discovery (${Object.keys(mcp.tools).length} tools), same-thread resume after process restart. No inference requested.`,
  );
} finally {
  client.stop();
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
  rmSync(dir, { recursive: true, force: true });
}
