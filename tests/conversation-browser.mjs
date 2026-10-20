import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
for (const width of [1440, 390])
  test(
    `browser: main conversation navigation and sharing at ${width}px`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tw-conversation-"));
      const app = createApp({
        dataDir: dir,
        env: {
          ADMIN_PASSWORD: "conversation-test-password",
          PUBLIC_ORIGIN: "https://workspace.example.test",
        },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const base = `http://127.0.0.1:${server.address().port}`;
      const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
        args: ["--no-sandbox"],
      });
      const context = await browser.newContext({
        viewport: { width, height: width === 390 ? 844 : 1000 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      try {
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "clipboard", {
            value: { writeText: async (text) => (window.copiedLink = text) },
          });
        });
        await page.request.post(base + "/api/login", {
          data: { username: "admin", password: "conversation-test-password" },
        });
        const thread = await (
          await page.request.post(base + "/api/threads", {
            data: {
              channel_id: 1,
              title: "Release planning conversation",
              body: "A shared place to discuss the next release.\n\nWe are checking the latest changes, test results and remaining work together.",
            },
          })
        ).json();
        const replies = [];
        for (let i = 1; i <= 18; i++)
          replies.push(
            await (
              await page.request.post(
                base + `/api/threads/${thread.id}/replies`,
                {
                  data: {
                    body: `Update ${i}\n\n${"The team reviewed the changes and shared a detailed follow-up. ".repeat(8)}`,
                  },
                },
              )
            ).json(),
          );
        await page.request.post(base + "/api/threads", {
          data: {
            channel_id: 1,
            title: "Other discussion",
            body: "Another topic",
          },
        });
        await page.goto(base);
        const filter = page.getByPlaceholder("Search conversations…");
        await filter.fill("Release planning");
        const trigger = page
          .locator(".origin-view .thread-row")
          .filter({ hasText: "Release planning conversation" });
        await expect(trigger).toHaveCount(1);
        await trigger.focus();
        await page.keyboard.press("Enter");
        const region = page.getByRole("region", {
          name: "Conversation",
          exact: true,
        });
        await expect(region).toBeVisible();
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(
          region.getByRole("heading", { name: thread.title, exact: true }),
        ).toBeFocused();
        await expect(page).toHaveURL(new RegExp(`thread=${thread.id}`));
        const box = await region.boundingBox();
        assert.ok(
          box.width > width * (width === 390 ? 0.95 : 0.7),
          "conversation fills main content",
        );
        await region
          .getByRole("button", { name: "Close thread", exact: true })
          .focus();
        await page.keyboard.press("Shift+Tab");
        assert.ok(
          await region.evaluate((el) => !el.contains(document.activeElement)),
          "nonmodal conversation does not trap focus",
        );
        await region
          .getByRole("button", { name: "Copy conversation link", exact: true })
          .click();
        assert.equal(
          await page.evaluate(() => window.copiedLink),
          `https://workspace.example.test/?thread=${thread.id}`,
        );
        const target = replies[5];
        await region
          .getByRole("button", {
            name: `Copy link to reply ${target.id}`,
            exact: true,
          })
          .click();
        assert.equal(
          await page.evaluate(() => window.copiedLink),
          `https://workspace.example.test/?thread=${thread.id}&reply=${target.id}`,
        );
        const sharedTab = await page.context().newPage();
        await sharedTab.goto(
          base + new URL(await page.evaluate(() => window.copiedLink)).search,
        );
        await expect(sharedTab.locator(`#reply-${target.id}`)).toHaveClass(
          /search-target/,
        );
        await sharedTab.close();
        await page.goBack();
        await expect(filter).toHaveValue("Release planning");
        await expect(trigger).toBeFocused();
        await page.goForward();
        await expect(region).toBeVisible();
        await page.reload();
        await expect(region).toBeVisible();
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await expect(filter).toHaveValue("Release planning");
        await page.goto(base + `/?thread=${thread.id}&reply=${target.id}`);
        await expect(page.locator(`#reply-${target.id}`)).toHaveClass(
          /search-target/,
        );
        await expect(page.locator(`#reply-${target.id}`)).toBeInViewport();
        await page.reload();
        await expect(page.locator(`#reply-${target.id}`)).toHaveClass(
          /search-target/,
        );
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await expect(
          page.getByRole("heading", { name: /general/ }),
        ).toBeVisible();
        await page.goto(base + `/?thread=${thread.id}`);
        const reply = region.getByRole("textbox", {
          name: "Reply",
          exact: true,
        });
        await reply.fill("A draft that survives navigation");
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await page
          .locator(".channel-thread-link")
          .filter({ hasText: thread.title })
          .click();
        await expect(reply).toHaveValue("A draft that survives navigation");
        await page
          .getByRole("button", { name: "Edit thread", exact: true })
          .click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(region).toBeVisible();
        await page
          .getByRole("button", { name: "Activity", exact: true })
          .click();
        await expect(page.locator(".activity-list")).toBeVisible();
        await page
          .getByRole("button", { name: "Branches", exact: true })
          .click();
        await expect(
          page.getByRole("button", {
            name: "Branches",
            pressed: true,
            exact: true,
          }),
        ).toBeVisible();
        await page.getByRole("button", { name: /^Discussion/ }).click();
        await page
          .locator(".thread-scroll")
          .evaluate((e) => (e.scrollTop = 500));
        mkdirSync("test-results", { recursive: true });
        await page.screenshot({
          path: `test-results/conversation-${width}.png`,
        });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "no horizontal overflow",
        );
        await page.evaluate(() => {
          navigator.clipboard.writeText = async () => {
            throw new Error("denied");
          };
        });
        await region
          .getByRole("button", { name: "Copy conversation link", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Link to copy" }),
        ).toHaveValue(`https://workspace.example.test/?thread=${thread.id}`);
        await page.keyboard.press("Escape");
        await page.goto(base + `/?thread=${thread.id}&reply=999999`);
        await expect(page.getByRole("alert")).toContainText(
          "message is unavailable",
        );
        await page.goto(base + "/?thread=999999");
        await expect(
          page.getByRole("heading", { name: "Conversation unavailable" }),
        ).toBeVisible();
        await expect(page.locator(".thread-description")).toHaveCount(0);
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await expect(page.locator(".origin-view")).toBeVisible();
        assert.deepEqual(errors, []);
      } finally {
        await browser.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        app.locals.shutdown();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
