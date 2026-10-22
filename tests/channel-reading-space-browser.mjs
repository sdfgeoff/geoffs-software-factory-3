import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

for (const [width, height] of [
  [1440, 900],
  [1440, 600],
  [390, 700],
])
  test(
    `browser: channel reading space at ${width}x${height}`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tw-channel-space-"));
      const app = createApp({
        dataDir: dir,
        env: {
          ADMIN_PASSWORD: "channel-space-password",
          AGENT_SPARK_TOKEN: "channel-space-agent",
        },
      });
      const server = app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      const url = `http://127.0.0.1:${server.address().port}`;
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
          args: ["--no-sandbox"],
        });
        const page = await browser.newPage({ viewport: { width, height } });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.request.post(url + "/api/login", {
          data: { username: "admin", password: "channel-space-password" },
        });
        await page.request.patch(url + "/api/channels/1", {
          data: {
            description:
              "Planning, updates and decisions shared across the team.",
          },
        });
        for (let i = 1; i <= 24; i++)
          await page.request.post(url + "/api/threads", {
            data: {
              channel_id: 1,
              title: `Channel update ${i}`,
              body: Array.from(
                { length: 7 },
                (_, n) =>
                  `Paragraph ${n + 1}: The team checked the release changes and recorded the results so everyone can follow the discussion and see what happens next.`,
              ).join("\n\n"),
            },
          });
        await page.goto(url);
        if (width < 700)
          await page.getByRole("button", { name: "Open navigation" }).click();
        await page
          .getByRole("button", { name: "general", exact: true })
          .click();
        const history = page.getByRole("region", {
          name: "History in general",
        });
        await expect(page.locator(".channel-entry")).toHaveCount(24);
        const anchor = page.locator("#channel-thread-12");
        await history.evaluate((el) => {
          const a = document.getElementById("channel-thread-12");
          el.scrollTop +=
            a.getBoundingClientRect().top -
            el.getBoundingClientRect().top +
            120;
        });
        await page.waitForTimeout(200);
        const offset = () =>
          anchor.evaluate(
            (el) =>
              el.getBoundingClientRect().top -
              el.closest(".channel-history").getBoundingClientRect().top,
          );
        const original = await offset();
        const stable = async () => {
          await page.waitForTimeout(150);
          assert.ok(
            Math.abs((await offset()) - original) < 4,
            "reading anchor moved",
          );
        };
        const metrics = await history.evaluate((el) => ({
          reading: el.clientHeight,
          app: document.querySelector(".main").clientHeight,
        }));
        if (process.env.CHANNEL_SPACE_EVIDENCE) {
          const d = process.env.CHANNEL_SPACE_EVIDENCE;
          mkdirSync(d, { recursive: true });
          const phase = process.env.CHANNEL_SPACE_BASELINE ? "before" : "after";
          await page.screenshot({
            path: join(d, `${phase}-${width}x${height}.png`),
          });
          writeFileSync(
            join(d, `${phase}-${width}x${height}.json`),
            JSON.stringify(metrics, null, 2),
          );
        }
        if (process.env.CHANNEL_SPACE_BASELINE) return;
        assert.ok(
          metrics.reading / metrics.app >= 0.7,
          JSON.stringify(metrics),
        );
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "horizontal overflow",
        );
        await page
          .getByRole("button", { name: "Show channel controls" })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Filter conversations" }),
        ).toBeVisible();
        await stable();
        await page
          .getByRole("button", { name: "Hide channel controls" })
          .click();
        await stable();
        const message = page.getByRole("textbox", {
          name: "Message",
          exact: true,
        });
        await message.focus();
        await message.fill(
          "Retained channel draft\n" + "A long line in the draft.\n".repeat(40),
        );
        await stable();
        await page
          .locator(".channel-compose-dock .formatting-help summary")
          .click();
        await stable();
        await page.getByText("Thread options", { exact: true }).click();
        await stable();
        await page
          .getByRole("textbox", { name: "Title (optional)" })
          .fill("Retained title");
        await page
          .getByRole("button", { name: "Collapse message", exact: true })
          .click();
        await stable();
        await page
          .getByRole("button", { name: "Expand message", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(message).toBeFocused();
        await expect(message).toHaveValue(/Retained channel draft/);
        await expect(
          page.getByRole("textbox", { name: "Title (optional)" }),
        ).toHaveValue("Retained title");
        await page
          .getByRole("button", { name: "Collapse message", exact: true })
          .click();
        await page.getByLabel("Attach files to message").setInputFiles({
          name: "channel-note.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Channel draft attachment"),
        });
        await expect(
          page.locator(".pending-files").getByText("channel-note.txt"),
        ).toBeVisible();
        await stable();
        await page
          .getByRole("button", { name: "Collapse message", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Expand message", exact: true })
          .click();
        await expect(
          page.locator(".pending-files").getByText("channel-note.txt"),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Remove channel-note.txt" })
          .click();
        await expect(page.locator(".pending-files")).toHaveCount(0);
        await page
          .getByRole("button", { name: "Collapse message", exact: true })
          .click();
        await page.request.post(url + "/api/threads", {
          headers: { Authorization: "Bearer channel-space-agent" },
          data: {
            channel_id: 1,
            title: "Incoming channel update",
            body: "While reading older channel messages",
          },
        });
        await expect(page.locator(".channel-entry")).toHaveCount(25);
        await stable();
        await anchor
          .getByRole("button", { name: /Admin.*Channel update 12/ })
          .click();
        await expect(
          page.getByRole("region", { name: "Conversation", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await stable();
        await expect(message).toHaveValue(/Retained channel draft/);
        await page
          .getByRole("button", { name: "Expand message", exact: true })
          .click();
        await message.fill("Sent from the compact channel composer");
        await page
          .getByRole("textbox", { name: "Title (optional)" })
          .fill("New compact message");
        await page.getByRole("button", { name: "Send", exact: true }).click();
        await expect(
          page.getByText("Message sent", { exact: true }),
        ).toBeVisible();
        await expect(
          history.getByText("Sent from the compact channel composer", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(message).toHaveValue("");
        await page
          .getByRole("button", { name: "Show channel controls" })
          .click();
        await page
          .getByRole("textbox", { name: "Filter conversations" })
          .fill("New compact message");
        await expect(page.locator(".channel-entry")).toHaveCount(1);
        await page
          .getByRole("button", { name: "Hide channel controls" })
          .click();
        await expect(
          page.getByRole("button", { name: "Show channel controls" }),
        ).toContainText("filtered");
        await page
          .getByRole("button", { name: "Show channel controls" })
          .click();
        await page
          .getByRole("textbox", { name: "Filter conversations" })
          .fill("");
        await expect(page.locator(".channel-entry")).toHaveCount(26);
        await page
          .getByRole("button", { name: "Hide channel controls" })
          .click();
        const board = page.getByRole("button", { name: "Board", exact: true });
        await board.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator(".board")).toBeVisible();
        await expect(board).toBeFocused();
        const threads = page.getByRole("button", {
          name: "Threads",
          exact: true,
        });
        await threads.focus();
        await page.keyboard.press("Enter");
        await expect(history).toBeVisible();
        await expect(threads).toBeFocused();
        await page
          .getByRole("button", { name: "Search everywhere", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Search everything", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await page.goto(url + "/?channel=1&thread=12");
        await expect(
          page.getByRole("region", { name: "Conversation", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Close thread", exact: true })
          .click();
        await expect(page.locator(".channel-reading-header")).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                !!document.activeElement?.closest(".channel-reading-header") &&
                document.activeElement.getClientRects().length > 0,
            ),
          )
          .toBe(true);
        assert.deepEqual(errors, []);
      } finally {
        await browser?.close();
        app.locals.shutdown();
        await new Promise((r) => server.close(r));
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
