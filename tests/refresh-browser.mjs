import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: scoped refresh, fallback, hidden origin and reconnect recovery",
  { timeout: 120000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-refresh-browser-"));
    const app = createApp({
      dataDir: dir,
      env: { ADMIN_PASSWORD: "refresh-browser-password" },
    });
    const insert = app.locals.db.prepare(
      "INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at) VALUES(1,?,'sample',1,1,?,?)",
    );
    app.locals.db.exec("BEGIN");
    for (let i = 1; i <= 510; i++)
      insert.run(
        `Refresh sample ${i}`,
        new Date(1700000000000 + i).toISOString(),
        new Date().toISOString(),
      );
    app.locals.db.exec("COMMIT");
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const requests = [];
    page.on("request", (r) => {
      if (r.method() === "GET" && r.url().includes("/api/"))
        requests.push(new URL(r.url()));
    });
    const full = () =>
      requests.filter(
        (u) => u.pathname === "/api/threads" && !u.searchParams.has("paged"),
      );
    const patches = () =>
      requests.filter(
        (u) => u.pathname === "/api/threads" && u.searchParams.has("paged"),
      );
    const detail = () =>
      requests.filter((u) => u.pathname === "/api/threads/510");
    async function post(path, data) {
      const r = await context.request.post(url + "/api" + path, { data });
      assert.equal(r.status(), 200, await r.text());
      return r.json();
    }
    try {
      await post("/login", {
        username: "admin",
        password: "refresh-browser-password",
      });
      await page.goto(url);
      await expect(page.locator(".thread-row")).toHaveCount(50);
      await page.waitForTimeout(500);
      assert.equal(patches().length, 1, "initial bounded page load");
      requests.length = 0;
      await page.waitForTimeout(21000);
      assert.ok(
        requests.some((u) => u.pathname === "/api/sync"),
        "fallback checks revision",
      );
      assert.equal(full().length, 0, "idle does not reload list pages");
      assert.equal(
        requests.filter((u) => u.pathname === "/api/bootstrap").length,
        0,
        "idle does not reload bootstrap",
      );
      await page
        .getByRole("button", { name: /general/ })
        .first()
        .click();
      await expect(page.locator(".channel-entry")).toHaveCount(50);
      await page.locator("#new-thread-message").fill("Local scoped message");
      await page.waitForTimeout(400);
      requests.length = 0;
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(page.locator(".channel-entry").last()).toContainText(
        "Local scoped message",
      );
      await page.waitForTimeout(400);
      assert.equal(full().length, 0);
      assert.equal(
        patches().length,
        1,
        "local acknowledgement and SSE coalesce",
      );
      await page.locator("#new-thread-message").fill("Retained unsent draft");
      await page
        .locator(".channel-thread-link")
        .filter({ hasText: "Refresh sample 510" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Refresh sample 510", exact: true }),
      ).toBeVisible();
      requests.length = 0;
      await page
        .getByLabel("Reply", { exact: true })
        .fill("Saved scoped reply");
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(page.locator(".reply").last()).toContainText(
        "Saved scoped reply",
      );
      await page.waitForTimeout(400);
      assert.equal(detail().length, 1);
      assert.equal(full().length, 0);
      assert.equal(patches().length, 0, "hidden origin waits until return");
      await page
        .getByLabel("Reply", { exact: true })
        .fill("Reply draft survives failed refresh");
      let failOnce = true;
      await page.route("**/api/threads/510", async (route) => {
        if (route.request().method() === "GET" && failOnce) {
          failOnce = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Refresh temporarily unavailable" }),
          });
        } else await route.continue();
      });
      const retryReply = await post("/threads/510/replies", {
        body: "Recovered after failed detail refresh",
      });
      await expect(page.locator(".toast.error")).toContainText(
        "Refresh temporarily unavailable",
      );
      await expect(page.getByLabel("Reply", { exact: true })).toHaveValue(
        "Reply draft survives failed refresh",
      );
      await expect(page.locator(`#reply-${retryReply.id}`)).toBeAttached({
        timeout: 25000,
      });
      await expect(page.getByLabel("Reply", { exact: true })).toHaveValue(
        "Reply draft survives failed refresh",
      );
      await page.unroute("**/api/threads/510");
      requests.length = 0;
      await post("/threads/1/replies", { body: "Other conversation update" });
      await page.waitForTimeout(600);
      assert.equal(
        detail().length,
        0,
        "unrelated conversation does not reload selected detail",
      );
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(page.locator("#new-thread-message")).toHaveValue(
        "Retained unsent draft",
      );
      await expect.poll(() => patches().length).toBe(1);
      assert.equal(full().length, 0, "return patches retained list");
      // A slow old summary response must not overwrite a newer invalidation.
      let release, captured;
      const gate = new Promise((r) => (release = r));
      const firstResponse = new Promise((r) => (captured = r));
      let held = false;
      const delaySummary = async (route) => {
        if (held) return route.continue();
        held = true;
        const response = await route.fetch();
        captured();
        await gate;
        await route.fulfill({ response });
      };
      await page.route("**/api/threads?paged=*", delaySummary);
      const patch = async (body) => {
        const r = await context.request.patch(url + "/api/threads/510", {
          data: { body },
        });
        assert.equal(r.status(), 200);
      };
      await patch("Earlier summary snapshot");
      await firstResponse;
      await patch("Newest summary wins");
      await expect(
        page
          .locator(".channel-entry")
          .filter({ hasText: "Refresh sample 510" }),
      ).toContainText("Newest summary wins");
      release();
      await page.waitForTimeout(400);
      await expect(
        page
          .locator(".channel-entry")
          .filter({ hasText: "Refresh sample 510" }),
      ).toContainText("Newest summary wins");
      await page.unroute("**/api/threads?paged=*", delaySummary);
      requests.length = 0;
      // Close the actual server stream. The reconnect revision check must recover
      // a mutation committed before the browser's EventSource reconnects.
      server.closeAllConnections();
      await page.waitForTimeout(200);
      await post("/threads", {
        channel_id: 1,
        title: "Recovered incoming thread",
        body: "Missed SSE",
      });
      await expect(page.locator(".channel-entry").last()).toContainText(
        "Recovered incoming thread",
        { timeout: 15000 },
      );
      assert.equal(full().length, 0);
      requests.length = 0;
      // A broad metadata change uses authoritative recovery, preserving the draft.
      await post("/channels", { name: "recovery-metadata" });
      await expect.poll(() => patches().length, { timeout: 25000 }).toBe(1);
      await expect(page.locator(".channel-entry")).toHaveCount(50);
      await expect(page.locator("#new-thread-message")).toHaveValue(
        "Retained unsent draft",
      );
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "browser: bootstrap snapshots and errors cannot overwrite newer state",
  { timeout: 90000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-bootstrap-race-"));
    const app = createApp({
      dataDir: dir,
      env: { ADMIN_PASSWORD: "bootstrap-race-password" },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    try {
      await page.request.post(url + "/api/login", {
        data: { username: "admin", password: "bootstrap-race-password" },
      });
      await page.goto(url);
      await expect(page.locator("aside .channel-nav")).toContainText("general");
      await page.waitForTimeout(300);
      const rename = async (name) => {
        const r = await page.request.patch(url + "/api/channels/1", {
          data: { name },
        });
        assert.equal(r.status(), 200, await r.text());
      };
      const sidebar = (name) =>
        page.locator("aside nav button").filter({ hasText: name });
      async function race(oldName, newName, error = false) {
        let captured, release;
        const snapshot = new Promise((r) => (captured = r)),
          gate = new Promise((r) => (release = r));
        let held = false;
        const intercept = async (route) => {
          if (held) return route.continue();
          held = true;
          const response = await route.fetch();
          captured();
          await gate;
          if (error)
            await route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ error: "Stale authentication failure" }),
            });
          else await route.fulfill({ response });
        };
        await page.route("**/api/bootstrap", intercept);
        await rename(oldName);
        await snapshot;
        await rename(newName);
        await expect(sidebar(newName)).toBeVisible();
        release();
        await page.waitForTimeout(300);
        await expect(sidebar(newName)).toBeVisible();
        await expect(sidebar(oldName)).toHaveCount(0);
        await page.unroute("**/api/bootstrap", intercept);
      }
      await race("earlier-name", "newest-name");
      await race("earlier-error", "newest-after-error", true);
      // After these revisions are consumed, an unchanged fallback must leave the
      // newest snapshot intact without needing another bootstrap to repair it.
      const bootstraps = [];
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/api/bootstrap") bootstraps.push(r);
      });
      await page.waitForTimeout(21000);
      await expect(sidebar("newest-after-error")).toBeVisible();
      assert.equal(
        bootstraps.length,
        0,
        "unchanged fallback retains newest state",
      );
      // A failure from the latest request still retries on the next unchanged check.
      let failOnce = true;
      await page.route("**/api/bootstrap", async (route) => {
        if (failOnce) {
          failOnce = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Latest bootstrap unavailable" }),
          });
        } else await route.continue();
      });
      await rename("recovered-latest");
      await expect(page.locator(".toast.error")).toContainText(
        "Latest bootstrap unavailable",
      );
      await expect(sidebar("recovered-latest")).toBeVisible({ timeout: 25000 });
      await expect(
        page.getByRole("button", { name: "Sign out", exact: true }),
      ).toBeVisible();
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
