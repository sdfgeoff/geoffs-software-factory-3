import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: Board dialog creation from older history returns to latest with success feedback",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "tw-board-create-"));
    const app = createApp({
      dataDir: dir,
      env: { ADMIN_PASSWORD: "board-create-password" },
    });
    app.locals.db
      .exec(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<75)
    INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at)
    SELECT 1,printf('Older Board sample %02d',i),'sample',1,1,'2026-01-01','2026-01-01' FROM n;`);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.setPauseOnExceptions", { state: "all" });
    cdp.on("Debugger.paused", (event) => {
      if (event.reason === "exception" || event.reason === "promiseRejection")
        errors.push(
          event.data?.description || event.data?.value || event.reason,
        );
      cdp.send("Debugger.resume").catch(() => {});
    });
    try {
      await page.request.post(url + "/api/login", {
        data: { username: "admin", password: "board-create-password" },
      });
      await page.goto(url + "/?view=board");
      await expect(page.locator(".board-card")).toHaveCount(50);
      await page
        .getByRole("button", { name: "Older conversations", exact: true })
        .click();
      await expect(page.locator(".board-card")).toHaveCount(25);
      await page
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Channel", { exact: true }).selectOption("1");
      await dialog
        .getByLabel("Message", { exact: true })
        .fill("Created from an older Board page");
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".toast")).toHaveText("Message sent");
      await expect(page.locator(".toast.error")).toHaveCount(0);
      await expect(page.locator(".conversation-main")).toContainText(
        "Created from an older Board page",
      );
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(page.locator(".board-card")).toHaveCount(50);
      await expect(
        page
          .locator(".board-card")
          .filter({ hasText: "Created from an older Board page" }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("button", { name: "Newer conversations", exact: true }),
      ).toBeDisabled();
      await expect(page.locator(".thread-pagination")).toContainText(
        "50 of 76 conversations",
      );
      assert.deepEqual(
        errors,
        [],
        "including exceptions caught by the composer",
      );
      assert.equal(
        app.locals.db.prepare("SELECT COUNT(*) AS count FROM threads").get()
          .count,
        76,
      );
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
