import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../server/app.mjs";

test("list_threads exposes opt-in bounded pages through real MCP without changing legacy arrays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tw-mcp-pages-"));
  const app = createApp({
    dataDir: join(dir, "data"),
    env: {
      ADMIN_PASSWORD: "pages-admin-password",
      AGENT_SPARK_TOKEN: "pages-agent-token",
    },
  });
  const db = app.locals.db;
  db.exec(
    `INSERT INTO channels(name,description,created_by,created_at) VALUES('other','Other channel',1,'2026-01-01');`,
  );
  const insert = db.prepare(
    "INSERT INTO threads(channel_id,title,body,status_id,assignee_id,created_by,created_at,updated_at) VALUES(?,?,'literal %_ marker',?,?,1,'2026-01-01','2026-01-01')",
  );
  db.exec("BEGIN");
  for (let i = 1; i <= 620; i++)
    insert.run((i % 2) + 1, `Conversation ${i}`, (i % 3) + 1, i % 4 ? 1 : 2);
  db.exec("COMMIT");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("agent/mcp.mjs")],
    env: {
      ...process.env,
      THREADWORK_URL: url,
      AGENT_TOKEN: "pages-agent-token",
      WORKER_INSTANCE: "",
      AGENT_WORKSPACE: dir,
      THREADWORK_DESKTOP: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "thread-page-contract-test",
    version: "1.0.0",
  });
  const headers = { Authorization: "Bearer pages-agent-token" };
  try {
    await client.connect(transport);
    const catalog = (await client.listTools()).tools;
    const tool = catalog.find((t) => t.name === "list_threads");
    assert.ok(tool);
    for (const field of ["paged", "limit", "before", "after", "status_id"])
      assert.ok(tool.inputSchema.properties[field], field);
    assert.match(tool.description, /legacy/i);
    assert.match(tool.description, /newest/i);
    const call = async (args = {}) => {
      const r = await client.callTool({
        name: "list_threads",
        arguments: args,
      });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.equal(r.structuredContent.outcome.ok, true);
      assert.deepEqual(
        JSON.parse(r.content[0].text),
        r.structuredContent.outcome.value,
      );
      return r.structuredContent.outcome.value;
    };
    const http = async (params = {}) => {
      const r = await fetch(
        url + "/api/threads?" + new URLSearchParams(params),
        { headers },
      );
      assert.equal(r.status, 200);
      return r.json();
    };
    const legacy = await call();
    assert.ok(Array.isArray(legacy));
    assert.equal(legacy.length, 500);
    assert.deepEqual(legacy, await http());
    assert.deepEqual(
      await call({ offset: 500 }),
      await http({ offset: "500" }),
    );
    assert.equal((await call({ offset: 500 })).length, 120);
    assert.deepEqual(await call({ paged: false }), legacy);
    const first = await call({ paged: true, limit: 100 });
    assert.equal(first.items.length, 100);
    assert.equal(first.total, 620);
    assert.equal(first.newer, null);
    assert.deepEqual(first, await http({ paged: "1", limit: "100" }));
    const seen = [...first.items.map((t) => t.id)];
    let page = first;
    while (page.older) {
      page = await call({ paged: true, limit: 100, before: page.older });
      seen.push(...page.items.map((t) => t.id));
    }
    assert.equal(seen.length, 620);
    assert.equal(new Set(seen).size, 620);
    assert.deepEqual(
      seen,
      [...seen].sort((a, b) => b - a),
    );
    const newer = await call({ paged: true, limit: 100, after: page.newer });
    assert.equal(newer.items.length, 100);
    assert.ok(newer.items[0].id > page.items[0].id);
    const args = {
      paged: true,
      limit: 7,
      channel_id: 1,
      assignee_id: 1,
      status_id: 1,
      query: "%_ marker",
    };
    const filtered = await call(args);
    assert.deepEqual(
      filtered,
      await http({
        paged: "1",
        limit: "7",
        channel: "1",
        assignee: "1",
        status: "1",
        q: "%_ marker",
      }),
    );
    assert.ok(filtered.total > 7);
    assert.ok(
      filtered.items.every(
        (t) => t.channel_id === 1 && t.assignee_id === 1 && t.status_id === 1,
      ),
    );
    assert.equal(
      Object.values(filtered.statusCounts).reduce((a, b) => a + b, 0),
      filtered.total,
    );
    assert.ok(
      (await call({ ...args, before: filtered.older })).items.every(
        (t) => t.channel_id === 1 && t.assignee_id === 1 && t.status_id === 1,
      ),
    );
    const empty = await call({ paged: true, query: "absent-page-marker" });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.items, []);
    assert.equal(empty.older, null);
    assert.equal(empty.newer, null);
    for (const args of [
      { paged: true, limit: 0 },
      { paged: true, limit: 101 },
      { paged: true, before: "invalid" },
      { paged: true, after: "invalid" },
    ]) {
      const r = await client.callTool({
        name: "list_threads",
        arguments: args,
      });
      assert.equal(r.isError, true, JSON.stringify(args));
    }
    for (const params of [
      { paged: "1", limit: "0" },
      { paged: "1", limit: "101" },
      { paged: "1", before: "invalid" },
      { paged: "1", after: "invalid" },
    ])
      assert.equal(
        (
          await fetch(url + "/api/threads?" + new URLSearchParams(params), {
            headers,
          })
        ).status,
        400,
      );
    for (const args of [
      { limit: 5 },
      { status_id: 1 },
      { before: first.older },
      { paged: true, offset: 0 },
      { paged: true, before: first.older, after: page.newer },
    ])
      assert.equal(
        (await client.callTool({ name: "list_threads", arguments: args }))
          .isError,
        true,
        JSON.stringify(args),
      );
    assert.equal((await fetch(url + "/api/threads?paged=1")).status, 401);
    assert.equal(
      (await call({ paged: true })).items.some(
        (t) => "token_hash" in t || "password" in t,
      ),
      false,
    );
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    app.locals.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
