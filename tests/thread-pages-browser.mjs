import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: bounded 10k conversation pages, old history, Board and direct targets",
  { timeout: 180000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-page-browser-"));
    const app = createApp({
      dataDir: dir,
      env: { ADMIN_PASSWORD: "page-browser-password" },
    });
    const db = app.locals.db;
    const replies = process.env.THREAD_PAGE_STRESS === "1" ? 300 : 3;
    db.exec(`BEGIN;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at)
    SELECT 1,printf('Scale conversation %05d',i),'Build update with **Markdown**.\n\nChecked the latest changes and shared results with the team.',i%5+1,1,printf('2026-01-%02dT00:00:00.000Z',i%28+1),'2026-01-01' FROM n;
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<${replies})
    INSERT INTO replies(thread_id,author_id,body,created_at) SELECT t.id,1,'Synthetic reply','2026-01-01' FROM threads t CROSS JOIN n;
    INSERT INTO events(id,type,actor_id,thread_id,channel_id,payload,created_at)
      SELECT id,'reply.created',1,thread_id,1,'{}',created_at FROM replies;
    INSERT INTO notifications(event_id,user_id) SELECT id,1 FROM events;
    COMMIT;`);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(10000);
    const metrics = [];
    try {
      await page.request.post(url + "/api/login", {
        data: { username: "admin", password: "page-browser-password" },
      });
      await page.addInitScript(() => {
        window.pageLongTasks = [];
        new PerformanceObserver((list) =>
          window.pageLongTasks.push(
            ...list
              .getEntries()
              .map((x) => ({ start: x.startTime, duration: x.duration })),
          ),
        ).observe({ type: "longtask", buffered: true });
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Performance.enable");
      async function measure(name, action, selector, expectedRequests = 1) {
        const requests = [];
        const collect = (r) => {
          if (new URL(r.url()).pathname === "/api/threads")
            requests.push(r.url());
        };
        page.on("request", collect);
        await page.evaluate(() => window.pageLongTasks?.splice(0));
        const start = performance.now();
        await action();
        await page.locator(selector).first().waitFor({ state: "visible" });
        const visibleMs = performance.now() - start;
        await expect(
          page.locator(".thread-pagination").getByRole("status"),
        ).toContainText("50 of 10000");
        const readyMs = performance.now() - start;
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const stats = await page.evaluate(() => ({
          nodes: document.querySelectorAll("*").length,
          longTasks: window.pageLongTasks.splice(0),
        }));
        const perf = (await cdp.send("Performance.getMetrics")).metrics;
        const heap = perf.find((x) => x.name === "JSHeapUsedSize").value;
        const result = {
          name,
          visibleMs,
          readyMs,
          nodes: stats.nodes,
          maxLongTaskMs: Math.max(0, ...stats.longTasks.map((x) => x.duration)),
          heapMiB: heap / 1024 / 1024,
          listRequests: requests,
        };
        metrics.push(result);
        page.off("request", collect);
        assert.ok(readyMs < 2000, JSON.stringify(result));
        assert.ok(result.nodes < 5000, JSON.stringify(result));
        assert.ok(result.maxLongTaskMs < 250, JSON.stringify(result));
        assert.ok(heap < 100 * 1024 * 1024, JSON.stringify(result));
        assert.equal(requests.length, expectedRequests);
      }
      await measure("all-work", () => page.goto(url), ".thread-row");
      assert.equal(await page.locator(".thread-row").count(), 50);
      const latestTitle = await page
        .locator(".thread-title")
        .first()
        .textContent();
      await page
        .getByRole("button", { name: "Older conversations", exact: true })
        .click();
      await expect(page.locator(".thread-title").first()).not.toHaveText(
        latestTitle,
      );
      await expect(page.locator(".thread-row")).toHaveCount(50);
      await page
        .getByRole("button", { name: "Newer conversations", exact: true })
        .click();
      await expect(page.locator(".thread-title").first()).toHaveText(
        latestTitle,
      );
      await measure(
        "channel",
        () =>
          page
            .getByRole("button", { name: /general/ })
            .first()
            .click(),
        ".channel-entry",
      );
      const history = page.locator(".channel-history");
      await history.evaluate((el) => (el.scrollTop = 0));
      await page
        .locator("#new-thread-message")
        .fill("Keep this draft across pages");
      await page
        .getByRole("button", { name: "Older conversations", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("button", { name: "Newer conversations", exact: true }),
      ).toBeEnabled();
      await expect(page.locator("#new-thread-message")).toHaveValue(
        "Keep this draft across pages",
      );
      await expect(page.locator(".channel-entry")).toHaveCount(50);
      const oldTitle = await page
        .locator(".channel-entry .thread-title")
        .first()
        .textContent();
      await page.locator(".channel-thread-link").first().click();
      await expect(page.locator(".conversation-main")).toContainText(oldTitle);
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(
        page.locator(".channel-entry .thread-title").first(),
      ).toHaveText(oldTitle);
      await page
        .getByRole("button", { name: "Latest conversations", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Newer conversations", exact: true }),
      ).toBeDisabled();
      await measure(
        "board",
        () => page.getByRole("button", { name: "Board", exact: true }).click(),
        ".board-card",
        0,
      );
      assert.equal(await page.locator(".board-card").count(), 50);
      assert.equal(
        await page
          .locator(".board-column small")
          .allTextContents()
          .then((a) => a.reduce((n, x) => n + Number(x), 0)),
        10000,
      );
      await page.goto(url + "/?channel=1&thread=1&view=threads");
      await expect(page.locator(".conversation-main")).toContainText(
        "Scale conversation 00001",
      );
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(page.locator(".channel-entry")).toHaveCount(50);
      mkdirSync("test-results", { recursive: true });
      writeFileSync(
        "test-results/thread-page-metrics.json",
        JSON.stringify(
          {
            threads: 10000,
            repliesPerThread: replies,
            events: 10000 * replies,
            notifications: 10000 * replies,
            viewport: "1440x1000",
            budget: {
              readyMs: 2000,
              maxLongTaskMs: 250,
              nodes: 5000,
              heapMiB: 100,
            },
            metrics,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(metrics));
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
