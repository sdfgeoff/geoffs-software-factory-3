import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../server/app.mjs";
import { toolResults } from "../shared/results.mjs";

test("HTTP and real MCP share request boundaries, normalization and public discovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-requests-"));
  const app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "request-test-password",
      AGENT_SPARK_TOKEN: "request-test-token",
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new Client({
    name: "request-contract-test",
    version: "1.0.0",
  });
  const http = async (path, body, method = "POST", headers = {}) => {
    const response = await fetch(url + "/api" + path, {
      method,
      headers: {
        Authorization: "Bearer request-test-token",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const good = async (name, args) => {
    const response = await call(name, args);
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("agent/mcp.mjs")],
        env: {
          ...process.env,
          AGENT_TOKEN: "request-test-token",
          WORKER_INSTANCE: "",
          THREADWORK_URL: url,
          AGENT_WORKSPACE: dir,
        },
        stderr: "pipe",
      }),
    );
    const tools = (await client.listTools()).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      Object.keys(toolResults).sort(),
    );
    const schema = (name) =>
      tools.find((t) => t.name === name).inputSchema.properties;
    assert.equal(schema("update_thread").title.maxLength, 240);
    assert.equal(schema("update_thread").title.minLength, 1);
    for (const name of [
      "create_thread",
      "update_thread",
      "post_reply",
      "edit_reply",
    ])
      assert.equal(schema(name).body.maxLength, 50000);
    assert.equal(schema("post_reply").attachment_ids.maxItems, 10);
    assert.equal(schema("post_reply").attachment_ids.items.format, "uuid");
    assert.equal(schema("create_branch").name.maxLength, 150);
    assert.equal(schema("create_branch").thread_ids.maxItems, 100);
    assert.equal(schema("review_branch").commit.pattern, "^[a-f0-9]{40}$");
    assert.equal(schema("mark_notifications_read").ids.maxItems, 200);
    assert.equal(schema("schedule_notification").when.maxLength, 100);
    const thread = await good("create_thread", {
      channel_id: 1,
      title: "  Original  ",
      assignee_id: null,
    });
    assert.equal(thread.title, "Original");
    assert.equal(thread.body, "");
    assert.equal(thread.assignee_id, null);
    const tid = thread.id;
    const maxBody = "b".repeat(50000);
    const changed = await good("update_thread", {
      thread_id: tid,
      title: "  " + "t".repeat(240) + "  ",
      body: maxBody,
    });
    assert.equal(changed.title, "t".repeat(240));
    assert.equal(changed.body, maxBody);
    const direct = await http(
      `/threads/${tid}`,
      { title: "  Trimmed  ", body: maxBody, assignee_id: null },
      "PATCH",
    );
    assert.equal(direct.status, 200);
    assert.equal(direct.data.title, "Trimmed");
    const reply = await good("post_reply", { thread_id: tid, body: maxBody });
    assert.equal(reply.body, maxBody);
    // Numeric-string JSON IDs remain supported by HTTP; MCP stays typed.
    const coerced = await http("/threads", {
      channel_id: "1",
      body: "HTTP numeric ID",
    });
    assert.equal(coerced.status, 200);
    assert.equal(
      (await call("create_thread", { channel_id: "1", body: "Typed MCP ID" }))
        .isError,
      true,
    );
    const cases = [
      [
        "update_thread",
        { thread_id: tid, title: " " },
        `/threads/${tid}`,
        { title: " " },
        "PATCH",
        "title",
      ],
      [
        "update_thread",
        { thread_id: tid, title: "t".repeat(241) },
        `/threads/${tid}`,
        { title: "t".repeat(241) },
        "PATCH",
        "title",
      ],
      ...["create_thread", "update_thread", "post_reply", "edit_reply"].map(
        (name) => {
          const paths = {
            create_thread: "/threads",
            update_thread: `/threads/${tid}`,
            post_reply: `/threads/${tid}/replies`,
            edit_reply: `/replies/${reply.id}`,
          };
          const ids =
            name === "create_thread"
              ? { channel_id: 1 }
              : name === "edit_reply"
                ? { reply_id: reply.id }
                : { thread_id: tid };
          const body = {
            body: "b".repeat(50001),
            ...(name === "create_thread" ? { channel_id: 1 } : {}),
          };
          return [
            name,
            { ...ids, ...body },
            paths[name],
            body,
            ["update_thread", "edit_reply"].includes(name) ? "PATCH" : "POST",
            "body",
          ];
        },
      ),
      [
        "post_reply",
        { thread_id: tid, attachment_ids: ["invalid"] },
        `/threads/${tid}/replies`,
        { attachment_ids: ["invalid"] },
        "POST",
        "attachment_ids",
      ],
      [
        "post_reply",
        {
          thread_id: tid,
          attachment_ids: Array(11).fill(
            "123e4567-e89b-42d3-a456-426614174000",
          ),
        },
        `/threads/${tid}/replies`,
        {
          attachment_ids: Array(11).fill(
            "123e4567-e89b-42d3-a456-426614174000",
          ),
        },
        "POST",
        "attachment_ids",
      ],
      ...["x".repeat(151), "feature/../bad", "feature/bad.lock"].map((name) => [
        "create_branch",
        { repository_id: 1, name },
        "/repositories/1/branches",
        { name },
        "POST",
        "name",
      ]),
      [
        "create_branch",
        { repository_id: 1, name: "valid", base: "main" },
        "/repositories/1/branches",
        { name: "valid", base: "main" },
        "POST",
        "base",
      ],
      [
        "mark_notifications_read",
        { ids: Array(201).fill(1) },
        "/inbox/read",
        { ids: Array(201).fill(1) },
        "POST",
        "ids",
      ],
      [
        "schedule_notification",
        { message: "   ", when: "in one hour" },
        "/notification-schedules",
        { message: "   ", when: "in one hour" },
        "POST",
        "message",
      ],
    ];
    // Grant review capability only in this isolated fixture so HTTP reaches its
    // validation boundary before attempting to load a nonexistent branch.
    const user = (await good("workspace_overview")).user;
    app.locals.db
      .prepare(
        "INSERT OR REPLACE INTO work_capabilities(user_id,can_work,can_review) VALUES(?,1,1)",
      )
      .run(user.id);
    for (const commit of ["a".repeat(39), "a".repeat(41), "a".repeat(64)])
      cases.push([
        "review_branch",
        { branch_id: 1, commit, decision: "approved" },
        "/branches/1/reviews",
        { commit, decision: "approved" },
        "POST",
        "commit",
      ]);
    for (const [name, args, path, body, method, field] of cases) {
      const mcp = await call(name, args);
      assert.equal(mcp.isError, true, name);
      const error = mcp.structuredContent.outcome.error;
      assert.equal(
        error.code,
        "VALIDATION_ERROR",
        `${name}: ${JSON.stringify(error)}`,
      );
      assert.ok(
        error.issues.some((issue) => issue.path[0] === field),
        name,
      );
      const direct = await http(path, body, method);
      assert.equal(
        direct.status,
        400,
        `${name}: ${JSON.stringify(direct.data)}`,
      );
      assert.equal(direct.data.error_details.code, "VALIDATION_ERROR", name);
      assert.ok(
        direct.data.error_details.issues.some(
          (issue) => issue.path[0] === field,
        ),
        name,
      );
    }
    // HTTP still strips unknown keys where it did before, and idempotent
    // retries retain their original response and create only one reply.
    const idem = { "Idempotency-Key": "request-contract-retry" };
    const first = await http(
      `/threads/${tid}/replies`,
      { body: "Once", ignored: true },
      "POST",
      idem,
    );
    const second = await http(
      `/threads/${tid}/replies`,
      { body: "Once", ignored: true },
      "POST",
      idem,
    );
    assert.equal(first.status, 200);
    assert.deepEqual(second, first);
    const detail = await good("read_thread", { thread_id: tid });
    assert.equal(detail.replies.filter((r) => r.body === "Once").length, 1);
    const stale = await call("update_thread", {
      thread_id: tid,
      title: "Conflict",
      expected_updated_at: "stale",
    });
    assert.equal(stale.structuredContent.outcome.error.status, 409);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
