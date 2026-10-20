// Run sequentially against baseline/current checkouts; copy only stopped synthetic data.
import { chromium } from "@playwright/test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
const [checkout, source, output] = process.argv.slice(2);
if (!output)
  throw Error(
    "Usage: node scripts/benchmark-refresh.mjs <built checkout> <checkpointed fixture> <new output>",
  );
const root = resolve(output),
  input = join(resolve(source), "threadwork.sqlite"),
  code = resolve(checkout);
if (existsSync(root)) throw Error("Output must be new");
if (existsSync(input + "-wal") && statSync(input + "-wal").size)
  throw Error("Checkpoint input first");
mkdirSync(join(root, "data"), { recursive: true });
copyFileSync(input, join(root, "data", "threadwork.sqlite"));
process.chdir(code);
const { createApp } = await import(pathToFileURL(join(code, "server/app.mjs")));
const { hash } = await import(pathToFileURL(join(code, "server/db.mjs")));
const app = createApp({
  dataDir: join(root, "data"),
  env: { ADMIN_PASSWORD: "unused-synthetic-password" },
});
const token = randomBytes(32).toString("hex");
app.locals.db
  .prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,1,?)")
  .run(hash(token), "2030-01-01T00:00:00Z");
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await context.addCookies([{ name: "tw_session", value: token, url: base }]);
const page = await context.newPage();
page.setDefaultTimeout(120000);
const report = {
  checkout: code,
  node: process.version,
  fixture: {
    threads: app.locals.db.prepare("SELECT COUNT(*) n FROM threads").get().n,
    replies: app.locals.db.prepare("SELECT COUNT(*) n FROM replies").get().n,
  },
  notes: [
    "Single sequential local browser run per checkout on shared hardware; no tail-latency or throughput claim.",
    "Request bodies are decoded HTTP response bytes; SSE stream excluded. APIRequestContext fixture writes are excluded from page request counts.",
    "DOM-targeted actions avoid whole-page accessibility traversal overhead. Initial list/Markdown rendering remains unbounded (#16).",
  ],
  actions: [],
  errors: [],
};
page.on("pageerror", (e) => report.errors.push(e.message));
let records = [],
  pending = [],
  active = 0,
  lastRequest = 0;
page.on("response", (r) => {
  const u = new URL(r.url());
  if (!u.pathname.startsWith("/api/") || u.pathname === "/api/events") return;
  const item = {
    path: u.pathname + u.search,
    method: r.request().method(),
    status: r.status(),
    bytes: 0,
  };
  records.push(item);
  active++;
  lastRequest = performance.now();
  pending.push(
    r
      .body()
      .then((b) => (item.bytes = b.length))
      .catch(() => {})
      .finally(() => active--),
  );
});
const save = () =>
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
async function action(name, fn, settle = 800) {
  records = [];
  pending = [];
  const start = performance.now();
  let value;
  try {
    value = await fn();
  } catch (e) {
    report.actions.push({
      name,
      error: e.message,
      visible_ms: performance.now() - start,
    });
    save();
    throw e;
  }
  const visible_ms = performance.now() - start;
  await page.waitForTimeout(settle);
  const quietStart = performance.now();
  while (active || performance.now() - lastRequest < 1000) {
    if (performance.now() - quietStart > 45000)
      throw Error("API requests did not settle");
    await new Promise((r) => setTimeout(r, 100));
  }
  await Promise.all(pending);
  const snapshot = records.slice();
  report.actions.push({
    name,
    visible_ms,
    ...value,
    request_count: snapshot.length,
    response_bytes: snapshot.reduce((s, r) => s + r.bytes, 0),
    full_list_pages: snapshot.filter(
      (r) => r.path.startsWith("/api/threads?") && !r.path.includes("ids="),
    ).length,
    requests: snapshot,
  });
  save();
  console.log(
    JSON.stringify({ ...report.actions.at(-1), requests: undefined }),
  );
}
try {
  const expected = report.fixture.threads;
  await action("all-work-ready", async () => {
    await page.goto(base);
    await page.waitForFunction(
      (n) => document.querySelectorAll(".thread-row").length === n,
      expected,
    );
  });
  await action(
    "idle-32-seconds",
    async () => {
      await page.waitForTimeout(32000);
    },
    0,
  );
  await action("channel-ready", async () => {
    const finalPage = page.waitForResponse((r) => {
      const u = new URL(r.url());
      return (
        u.pathname === "/api/threads" &&
        u.searchParams.get("offset") ===
          String(Math.floor(expected / 500) * 500)
      );
    });
    await page.evaluate(() =>
      [...document.querySelectorAll("aside nav button")]
        .find((e) => e.textContent.trim() === "general")
        .click(),
    );
    await finalPage;
    await page.waitForFunction(
      (n) => document.querySelectorAll(".channel-entry").length === n,
      expected,
    );
  });
  await action("channel-send", async () => {
    await page
      .locator("#new-thread-message")
      .fill("Scoped benchmark channel message");
    await page.evaluate(() =>
      document.querySelector(".channel-compose-dock form").requestSubmit(),
    );
    await page.waitForFunction(
      (n) => document.querySelectorAll(".channel-entry").length === n,
      expected + 1,
    );
  });
  await action("open-conversation", async () => {
    await page.evaluate(() =>
      document.querySelector(".channel-thread-link").click(),
    );
    await page.locator(".thread-detail .reply").first().waitFor();
  });
  await action("reply-send", async () => {
    await page
      .locator('textarea[aria-label="Reply"]')
      .fill("Scoped benchmark saved reply");
    await page.evaluate(() =>
      document.querySelector(".thread-detail .reply-composer").requestSubmit(),
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".thread-detail .reply")].some((e) =>
        e.textContent.includes("Scoped benchmark saved reply"),
      ),
    );
  });
  const id = Number(new URL(page.url()).searchParams.get("thread"));
  assert.ok(id);
  await action("incoming-selected-reply", async () => {
    const r = await context.request.post(base + `/api/threads/${id}/replies`, {
      data: { body: "Scoped benchmark incoming reply" },
    });
    assert.equal(r.status(), 200);
    await page.waitForFunction(() =>
      [...document.querySelectorAll(".thread-detail .reply")].some((e) =>
        e.textContent.includes("Scoped benchmark incoming reply"),
      ),
    );
  });
  await action("return-to-channel", async () => {
    await page.evaluate(() =>
      document.querySelector('button[aria-label="Close thread"]').click(),
    );
    await page.locator("#new-thread-message").waitFor();
  });
  await action("incoming-channel-thread", async () => {
    const r = await context.request.post(base + "/api/threads", {
      data: {
        channel_id: 1,
        title: "Scoped benchmark incoming thread",
        body: "Incoming channel update",
      },
    });
    assert.equal(r.status(), 200);
    await page.waitForFunction(() =>
      document
        .querySelector(".channel-entry:last-child")
        ?.textContent.includes("Scoped benchmark incoming thread"),
    );
  });
} finally {
  save();
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  app.locals.shutdown();
}
