import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../server/app.mjs";
test("real MCP transport performs board actions, uploads, downloads and enforces workspace paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "threadwork-mcp-"));
  const app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "mcp-test-password",
      AGENT_SPARK_TOKEN: "mcp-token",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("agent/mcp.mjs")],
    env: {
      ...process.env,
      AGENT_TOKEN: "mcp-token",
      WORKER_INSTANCE: "", // Do not inherit the live worker lease in isolated tests.
      THREADWORK_URL: `http://127.0.0.1:${server.address().port}`,
      AGENT_WORKSPACE: dir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 20);
    for (const name of [
      "search_platform",
      "orchestration_overview",
      "create_branch",
      "review_branch",
      "request_branch_merge",
      "prepare_branch_workspace",
      "schedule_notification",
      "list_scheduled_notifications",
      "cancel_scheduled_notification",
    ])
      assert.ok(tools.tools.some((t) => t.name === name));
    const tool = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return JSON.parse(r.content[0].text);
    };
    const schedule = await tool("schedule_notification", {
      message: "MCP reminder",
      when: "in one hour",
      repeat: "every 1 day",
    });
    assert.equal(schedule.interval_ms, 86400000);
    assert.equal(
      (await tool("list_scheduled_notifications"))[0].id,
      schedule.id,
    );
    await tool("cancel_scheduled_notification", { schedule_id: schedule.id });
    assert.deepEqual(await tool("list_scheduled_notifications"), []);
    const invalidSchedule = await client.callTool({
      name: "schedule_notification",
      arguments: { message: "Invalid", when: "yesterday" },
    });
    assert.equal(invalidSchedule.isError, true);
    const overview = await tool("workspace_overview");
    assert.equal(overview.user.username, "spark");
    const upstream = join(dir, "upstream.git"),
      seed = join(dir, "seed");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    await exec("git", ["init", "--bare", "--initial-branch=main", upstream], {
      env: gitEnv,
    });
    await exec("git", ["init", "--initial-branch=main", seed], { env: gitEnv });
    writeFileSync(join(seed, "notes.txt"), "initial");
    await exec("git", ["add", "."], { cwd: seed, env: gitEnv });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "commit",
        "-m",
        "initial",
      ],
      { cwd: seed, env: gitEnv },
    );
    await exec("git", ["push", upstream, "main"], { cwd: seed, env: gitEnv });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(baseUrl + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "mcp-test-password",
      }),
    });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    const registered = await fetch(baseUrl + "/api/repositories", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "MCP fixture",
        url: upstream,
        main_branch: "main",
      }),
    });
    const repository = await registered.json();
    assert.equal(registered.status, 200, JSON.stringify(repository));
    const managed = await tool("create_branch", {
      repository_id: repository.id,
      name: "work/mcp",
    });
    assert.equal(managed.owner_id, overview.user.id);
    const checkout = await tool("prepare_branch_workspace", {
      branch_id: managed.id,
    });
    assert.equal(
      readFileSync(join(checkout.path, "notes.txt"), "utf8"),
      "initial",
    );
    writeFileSync(join(checkout.path, "notes.txt"), "MCP managed work");
    const workerEnv = {
      ...gitEnv,
      THREADWORK_URL: baseUrl,
      AGENT_TOKEN: "mcp-token",
    };
    await exec("git", ["add", "."], { cwd: checkout.path, env: workerEnv });
    await exec("git", ["commit", "-m", "MCP work"], {
      cwd: checkout.path,
      env: workerEnv,
    });
    await exec("git", ["push", "origin", managed.name], {
      cwd: checkout.path,
      env: workerEnv,
    });
    const diff = await tool("read_branch_diff", { branch_id: managed.id });
    assert.match(diff.diff, /MCP managed work/);
    const mergeDenied = await client.callTool({
      name: "request_branch_merge",
      arguments: { branch_id: managed.id },
    });
    assert.equal(mergeDenied.isError, true);
    const reviewDenied = await client.callTool({
      name: "review_branch",
      arguments: {
        branch_id: managed.id,
        commit: diff.commit,
        decision: "approved",
      },
    });
    assert.equal(reviewDenied.isError, true);
    assert.equal(
      (await tool("orchestration_overview")).repositories[0].id,
      repository.id,
    );

    const t = await tool("create_thread", {
      channel_id: 1,
      title: "Created through MCP",
      body: "Shared with humans",
    });
    const search = await tool("search_platform", {
      query: "Created through MCP",
      limit: 1,
    });
    assert.equal(search.results[0].thread_id, t.id);
    assert.equal(search.results[0].kind, "thread");
    writeFileSync(join(dir, "notes.txt"), "A local workspace artifact");
    const a = await tool("upload_attachment", { path: "notes.txt" });
    const r = await tool("post_reply", {
      thread_id: t.id,
      body: "Attached my notes",
      attachment_ids: [a.id],
    });
    assert.ok(r.id);
    const detail = await tool("read_thread", { thread_id: t.id });
    assert.equal(detail.replies[0].attachments[0].id, a.id);
    await tool("download_attachment", {
      attachment_id: a.id,
      path: "downloaded.txt",
    });
    assert.equal(
      readFileSync(join(dir, "downloaded.txt"), "utf8"),
      "A local workspace artifact",
    );
    const escape = await client.callTool({
      name: "upload_attachment",
      arguments: { path: "/etc/passwd" },
    });
    assert.equal(escape.isError, true);
    const overwrite = await client.callTool({
      name: "download_attachment",
      arguments: { attachment_id: a.id, path: "notes.txt" },
    });
    assert.equal(overwrite.isError, true);
    assert.equal(
      readFileSync(join(dir, "notes.txt"), "utf8"),
      "A local workspace artifact",
    );
    writeFileSync(join(dir, "..valid-notes.txt"), "A valid workspace filename");
    const dotFile = await tool("upload_attachment", {
      path: "..valid-notes.txt",
    });
    assert.ok(dotFile.id);
    const opening = await tool("create_thread", {
      channel_id: 1,
      body: "A message with opening attachments",
      attachment_ids: [dotFile.id],
    });
    assert.equal(opening.title, "A message with opening attachments");
    const openingDetail = await tool("read_thread", { thread_id: opening.id });
    assert.equal(openingDetail.attachments[0].id, dotFile.id);
    assert.equal(openingDetail.replies.length, 0);
    writeFileSync(join(dir, "diagram.txt"), "An opening artifact");
    const fileOnly = await tool("upload_attachment", { path: "diagram.txt" });
    const fileThread = await tool("create_thread", {
      channel_id: 1,
      attachment_ids: [fileOnly.id],
    });
    assert.equal(fileThread.title, "diagram.txt");
    const empty = await client.callTool({
      name: "create_thread",
      arguments: { channel_id: 1 },
    });
    assert.equal(empty.isError, true);
    const notImage = await client.callTool({
      name: "view_image_attachment",
      arguments: { attachment_id: a.id },
    });
    assert.equal(notImage.isError, true);
    writeFileSync(
      join(dir, "pixel.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const image = await tool("upload_attachment", { path: "pixel.png" });
    await tool("post_reply", { thread_id: t.id, attachment_ids: [image.id] });
    const preview = await client.callTool({
      name: "view_image_attachment",
      arguments: { attachment_id: image.id },
    });
    assert.equal(preview.isError, undefined);
    assert.equal(preview.content[0].type, "image");
    assert.equal(preview.content[0].mimeType, "image/png");
    assert.deepEqual(
      Buffer.from(preview.content[0].data, "base64"),
      readFileSync(join(dir, "pixel.png")),
    );
    symlinkSync("/tmp", join(dir, "outside"));
    const symlink = await client.callTool({
      name: "download_attachment",
      arguments: { attachment_id: a.id, path: "outside/escape.txt" },
    });
    assert.equal(symlink.isError, true);
    const list = await tool("list_threads", { query: "Attached my notes" });
    assert.equal(list[0].id, t.id);
    const change = await tool("update_thread", {
      thread_id: t.id,
      status_id: 5,
    });
    assert.equal(change.status_id, 5);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
