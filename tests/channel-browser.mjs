import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
for (const width of [1440, 390])
  test(
    `browser: channel stream and drafts at ${width}px`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tw-channel-"));
      const app = createApp({
        dataDir: dir,
        env: { ADMIN_PASSWORD: "channel-test-password" },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const url = `http://127.0.0.1:${server.address().port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
      const page = await browser.newPage({
        viewport: { width, height: width === 390 ? 844 : 1000 },
      });
      page.setDefaultTimeout(8000);
      try {
        await page.request.post(url + "/api/login", {
          data: { username: "admin", password: "channel-test-password" },
        });
        for (let i = 1; i <= 18; i++) {
          const r = await page.request.post(url + "/api/threads", {
            data: {
              channel_id: 1,
              title: `Stream sample ${String(i).padStart(2, "0")}`,
              body: `Build update ${i}\n\n${"We checked the latest changes and shared the results with the team. ".repeat(3)}`,
            },
          });
          assert.equal(r.status(), 200);
        }
        await page.goto(url);
        if (width === 390)
          await page.getByRole("button", { name: "Open navigation" }).click();
        await page
          .getByRole("button", { name: /general/ })
          .first()
          .click();
        const history = page.locator(".channel-history"),
          message = page.locator("#new-thread-message");
        await expect(page.locator(".channel-entry")).toHaveCount(18);
        await expect(page.locator(".channel-entry").first()).toContainText(
          "Stream sample 01",
        );
        await expect(page.locator(".channel-entry").last()).toContainText(
          "Stream sample 18",
        );
        await expect
          .poll(() =>
            history.evaluate(
              (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
            ),
          )
          .toBeLessThan(33);
        await message.fill("@ad");
        await expect(
          page.locator(".channel-compose-dock .mention-menu"),
        ).toBeVisible();
        await message.press("Enter");
        await expect(message).toHaveValue("@admin ");
        await message.fill("Unsent channel draft");
        await page.getByText("Thread options", { exact: true }).click();
        await page
          .getByRole("textbox", { name: "Title (optional)" })
          .fill("Draft title");
        let releaseUpload;
        const uploadGate = new Promise((r) => (releaseUpload = r));
        await page.route("**/api/attachments", async (route) => {
          await uploadGate;
          await route.continue();
        });
        await page.getByLabel("Attach files to message").setInputFiles({
          name: "draft.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Retained attachment"),
        });
        await page.getByRole("button", { name: "Board", exact: true }).click();
        await page
          .getByRole("button", { name: "Threads", exact: true })
          .click();
        releaseUpload();
        await expect(page.locator(".channel-compose-dock")).toContainText(
          "draft.txt",
        );
        await history.evaluate((e) => (e.scrollTop = 0));
        await page.locator(".channel-thread-link").first().click();
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await expect(message).toHaveValue("Unsent channel draft");
        await page.getByRole("button", { name: "Board", exact: true }).click();
        await page
          .getByRole("button", { name: "Threads", exact: true })
          .click();
        await expect(message).toHaveValue("Unsent channel draft");
        await page
          .getByRole("button", { name: "Expand message", exact: true })
          .click();
        await page.getByText("Thread options", { exact: true }).click();
        await expect(
          page.getByRole("textbox", { name: "Title (optional)" }),
        ).toHaveValue("Draft title");
        await expect(page.locator(".channel-compose-dock")).toContainText(
          "draft.txt",
        );
        await page.getByText("Thread options", { exact: true }).click();
        let fail = true;
        await page.route("**/api/threads", async (route) => {
          if (route.request().method() === "POST" && fail) {
            fail = false;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ error: "Sample send failure" }),
            });
          } else await route.continue();
        });
        const send = page
          .locator(".channel-compose-dock")
          .getByRole("button", { name: /Send/ });
        await send.click();
        await expect(message).toHaveValue("Unsent channel draft");
        await expect(page.locator(".channel-compose-dock")).toContainText(
          "Sample send failure",
        );
        await send.click();
        await expect(message).toHaveValue("");
        await expect(page.locator(".channel-entry")).toHaveCount(19);
        await expect
          .poll(() =>
            history.evaluate(
              (e) => e.scrollHeight - e.clientHeight - e.scrollTop,
            ),
          )
          .toBeLessThan(33);
        await message.fill(
          "Review the latest build\nShare the results with the team",
        );
        mkdirSync("test-results", { recursive: true });
        await page.screenshot({ path: `test-results/channel-${width}.png` });
        if (width === 390) {
          await page.setViewportSize({ width, height: 500 });
          await message.focus();
          await send.scrollIntoViewIfNeeded();
          const box = await send.boundingBox();
          assert.ok(
            box.y >= 0 && box.y + box.height <= 501,
            "send reachable in reduced viewport",
          );
        }
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "no horizontal overflow",
        );
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        app.locals.shutdown();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
