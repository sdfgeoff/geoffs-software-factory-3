import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../server/app.mjs";
import { createApi } from "../agent/api.mjs";
import { errorResult } from "../shared/errors.mjs";
import { toolResults, publicResult } from "../shared/results.mjs";
async function connect(url, dir) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("agent/mcp.mjs")],
    env: {
      ...process.env,
      THREADWORK_URL: url,
      AGENT_TOKEN: "result-agent-token",
      WORKER_INSTANCE: "",
      AGENT_WORKSPACE: dir,
      THREADWORK_DESKTOP: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "result-contract-test", version: "1.0.0" });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  return { client, tools };
}
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${server.address().port}`;
};
const stop = async (server) => {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
};
function outcome(response) {
  return response.structuredContent.outcome;
}

test("real MCP advertises public result contracts and preserves legacy text/image content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-results-"));
  const app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "results-admin-password",
      AGENT_SPARK_TOKEN: "result-agent-token",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let client;
  try {
    const connected = await connect(url, dir);
    client = connected.client;
    assert.deepEqual(
      connected.tools.map((t) => t.name).sort(),
      Object.keys(toolResults).sort(),
    );
    for (const tool of connected.tools) {
      assert.equal(tool.outputSchema.type, "object");
      assert.ok(tool.outputSchema.properties.outcome);
    }
    const call = (name, args = {}) =>
      client.callTool({ name, arguments: args });
    const good = async (name, args = {}) => {
      const response = await call(name, args);
      assert.ok(!response.isError, JSON.stringify(response));
      assert.equal(outcome(response).ok, true);
      assert.deepEqual(
        JSON.parse(response.content[0].text),
        outcome(response).value,
      );
      return outcome(response).value;
    };
    const overview = await good("workspace_overview");
    assert.equal(overview.user.username, "spark");
    assert.equal("token_hash" in overview.user, false);
    assert.equal("instance_id" in overview.agents[0], false);
    const thread = await good("create_thread", {
      channel_id: 1,
      title: "Public result contract",
      body: "Opening",
    });
    await good("read_thread", { thread_id: thread.id });
    await good("list_threads");
    await good("subscribe_channel", { channel_id: 1, subscribed: true });
    await good("subscribe_thread", { thread_id: thread.id, subscribed: true });
    await good("search_platform", { query: "Public result" });
    await good("work_queue");
    await good("orchestration_overview");
    await good("post_reply", { thread_id: thread.id, body: "New reply" });
    const sdkFailure = await call("read_thread", { thread_id: -1 });
    assert.equal(sdkFailure.isError, true);
    assert.equal(outcome(sdkFailure).error.code, "VALIDATION_ERROR");
    assert.deepEqual(outcome(sdkFailure).error.issues[0].path, ["thread_id"]);
    const httpFailure = await call("update_thread", {
      thread_id: thread.id,
      title: "",
    });
    // Shared request contracts now reject this at the MCP boundary.
    assert.equal(outcome(httpFailure).error.status, null);
    assert.equal(outcome(httpFailure).error.code, "VALIDATION_ERROR");
    assert.equal(outcome(httpFailure).error.retryable, false);
    assert.deepEqual(outcome(httpFailure).error.issues[0].path, ["title"]);
    const conflict = await call("update_thread", {
      thread_id: thread.id,
      expected_updated_at: "stale",
      title: "Change",
    });
    assert.equal(outcome(conflict).error.status, 409);
    assert.equal(outcome(conflict).error.code, "CONFLICT");
    assert.match(outcome(conflict).error.guidance, /current state/);
    // Fixture author is a different account; tool still respects server authorization.
    const stamp = new Date().toISOString();
    const reply = app.locals.db
      .prepare(
        "INSERT INTO replies(thread_id,author_id,body,created_at) VALUES(?,1,'Admin reply',?) RETURNING id",
      )
      .get(thread.id, stamp);
    const denied = await call("edit_reply", {
      reply_id: reply.id,
      body: "Cannot edit",
    });
    assert.equal(outcome(denied).error.status, 403);
    assert.equal(outcome(denied).error.code, "FORBIDDEN");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHo0AAAAASUVORK5CYII=",
      "base64",
    );
    const upload = await fetch(url + "/api/attachments", {
      method: "POST",
      headers: { Authorization: "Bearer result-agent-token" },
      body: (() => {
        const f = new FormData();
        f.set("file", new Blob([png], { type: "image/png" }), "sample.png");
        return f;
      })(),
    });
    const attachment = await upload.json();
    const image = await call("view_image_attachment", {
      attachment_id: attachment.id,
    });
    assert.ok(!image.isError);
    assert.equal(image.content[0].type, "image");
    assert.deepEqual(outcome(image).value, { mimeType: "image/png" });
    const local = await call("download_attachment", {
      attachment_id: attachment.id,
      path: "/outside-workspace.png",
    });
    assert.equal(local.isError, true);
    assert.equal(outcome(local).error.status, null);
    assert.equal(outcome(local).error.code, "LOCAL_TOOL_ERROR");
    const destination = join(dir, "download.png");
    await good("download_attachment", {
      attachment_id: attachment.id,
      path: destination,
    });
    const overwrite = await call("download_attachment", {
      attachment_id: attachment.id,
      path: destination,
    });
    assert.equal(outcome(overwrite).error.code, "FILE_EXISTS");
    assert.equal(outcome(overwrite).error.retryable, false);
    const unknown = await call("not_a_board_tool");
    assert.equal(outcome(unknown).error.code, "TOOL_NOT_FOUND");

    const invalidEnum = await call("review_branch", {
      branch_id: 1,
      commit: "a".repeat(40),
      decision: "PRIVATE-ARGUMENT",
    });
    assert.equal(outcome(invalidEnum).error.code, "VALIDATION_ERROR");
    assert.ok(!JSON.stringify(invalidEnum).includes("PRIVATE-ARGUMENT"));
    const disabledDesktop = await call("desktop_screenshot");
    assert.equal(disabledDesktop.isError, true);
    assert.equal(outcome(disabledDesktop).error.code, "LOCAL_TOOL_ERROR");
    // A newly leaked database column fails before HTTP/MCP can serialize its value.
    app.locals.db.exec("ALTER TABLE threads ADD COLUMN private_internal TEXT");
    app.locals.db
      .prepare("UPDATE threads SET private_internal='PRIVATE-COLUMN'")
      .run();
    const invalid = await call("read_thread", { thread_id: thread.id });
    assert.equal(invalid.isError, true);
    assert.ok(!JSON.stringify(invalid).includes("PRIVATE-COLUMN"));
    assert.ok(!JSON.stringify(overview).includes("result-agent-token"));
  } finally {
    await client?.close();
    await stop(server);
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API failures keep safe structured metadata, retry policy and unknown mutation outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-result-errors-"));
  let mode = "unavailable",
    requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (mode === "hang") return;
    res.setHeader("content-type", "application/json");
    if (mode === "bad-public-result") {
      res.end(JSON.stringify({ user: { password: "PRIVATE-SECRET" } }));
      return;
    }
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "PRIVATE-SERVER-STACK" }));
  });
  const url = await listen(server);
  let client;
  try {
    ({ client } = await connect(url, dir));
    const response = await client.callTool({
      name: "read_thread",
      arguments: { thread_id: 1 },
    });
    assert.equal(response.isError, true);
    assert.equal(outcome(response).error.status, 503);
    assert.equal(outcome(response).error.code, "SERVICE_UNAVAILABLE");
    assert.equal(outcome(response).error.retryable, null);
    assert.equal(requests, 3, "existing two retries retained");
    assert.ok(!JSON.stringify(response).includes("PRIVATE-SERVER-STACK"));
    mode = "bad-public-result";
    const bad = await client.callTool({
      name: "workspace_overview",
      arguments: {},
    });
    assert.equal(outcome(bad).error.code, "INVALID_RESULT");
    assert.ok(!JSON.stringify(bad).includes("PRIVATE-SECRET"));
    assert.throws(
      () => publicResult("workspace_overview", { password: "PRIVATE-SECRET" }),
      /invalid public result/,
    );
    mode = "hang";
    const api = createApi({ url, credential: "test-only" });
    let timeout;
    try {
      await api("/slow", { method: "POST", body: {}, timeout: 20, retries: 0 });
    } catch (e) {
      timeout = errorResult(e);
    }
    assert.equal(outcome(timeout).error.code, "TIMEOUT");
    assert.equal(outcome(timeout).error.retryable, null);
    assert.match(outcome(timeout).error.guidance, /already have committed/);
    await stop(server);
    const network = await client.callTool({
      name: "read_thread",
      arguments: { thread_id: 1 },
    });
    assert.equal(outcome(network).error.code, "NETWORK_ERROR");
    assert.equal(outcome(network).error.status, null);
    assert.equal(outcome(network).error.retryable, null);
  } finally {
    await client?.close();
    await stop(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
