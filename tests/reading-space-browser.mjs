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
    `browser: conversation reading space at ${width}x${height}`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tw-reading-space-"));
      const app = createApp({
        dataDir: dir,
        env: {
          ADMIN_PASSWORD: "reading-space-password",
          AGENT_SPARK_TOKEN: "reading-space-agent",
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
          data: { username: "admin", password: "reading-space-password" },
        });
        const thread = await (
          await page.request.post(url + "/api/threads", {
            data: {
              channel_id: 1,
              title:
                "Planning a readable conversation with a full title available in Details",
              body: "A discussion about the next release.",
            },
          })
        ).json();
        let target;
        for (let i = 1; i <= 24; i++) {
          const reply = await (
            await page.request.post(url + `/api/threads/${thread.id}/replies`, {
              data: {
                body:
                  `Update ${i}\n\n` +
                  Array.from(
                    { length: 8 },
                    (_, n) =>
                      `Paragraph ${n + 1}: The team reviewed the release changes, checked the results, and recorded the next steps so everyone can follow the discussion.`,
                  ).join("\n\n"),
              },
            })
          ).json();
          if (i === 12) target = reply;
        }
        await page.goto(url + `/?thread=${thread.id}&reply=${target.id}`);
        const reading = page.getByRole("region", {
          name: "Conversation reading area",
        });
        await expect(reading).toBeVisible();
        await page.waitForTimeout(300);
        const anchor = page.locator(`#reply-${target.id}`);
        await reading.evaluate((el, id) => {
          const a = document.getElementById("reply-" + id);
          el.scrollTop +=
            a.getBoundingClientRect().top -
            el.getBoundingClientRect().top +
            150;
        }, target.id);
        await page.waitForTimeout(150);
        const offset = () =>
          anchor.evaluate(
            (el) =>
              el.getBoundingClientRect().top -
              el.closest(".thread-scroll").getBoundingClientRect().top,
          );
        const original = await offset();
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          "horizontal overflow",
        );
        const metrics = await reading.evaluate((el) => ({
          reading: el.clientHeight,
          app: document.querySelector(".main").clientHeight,
          viewport: innerHeight,
        }));
        const evidence = process.env.READING_SPACE_EVIDENCE;
        const phase = process.env.READING_BASELINE ? "before" : "after";
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          await page.screenshot({
            path: join(evidence, `${phase}-${width}x${height}.png`),
          });
          writeFileSync(
            join(evidence, `${phase}-${width}x${height}.json`),
            JSON.stringify(metrics, null, 2),
          );
        }
        if (process.env.READING_BASELINE) return;
        assert.ok(
          metrics.reading / metrics.app >= 0.7,
          JSON.stringify(metrics),
        );
        const unchanged = async () => {
          await page.waitForTimeout(150);
          assert.ok(
            Math.abs((await offset()) - original) < 4,
            "reading anchor moved",
          );
        };
        await page
          .getByRole("button", { name: "Show conversation details" })
          .click();
        await expect(
          page.getByRole("combobox", { name: "Status", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("combobox", { name: "Status", exact: true })
          .selectOption("2");
        await expect(
          page.getByRole("combobox", { name: "Status", exact: true }),
        ).toHaveValue("2");
        await page
          .getByRole("combobox", { name: "Assignee", exact: true })
          .selectOption({ label: "Spark · AI" });
        await expect(
          page
            .getByRole("combobox", { name: "Assignee", exact: true })
            .locator("option:checked"),
        ).toHaveText("Spark · AI");
        await unchanged();
        await page
          .getByRole("button", { name: "Hide conversation details" })
          .click();
        await unchanged();
        const reply = page.getByRole("textbox", { name: "Reply", exact: true });
        await reply.focus();
        await reply.fill(
          "A retained draft\n" + "A long draft line.\n".repeat(45),
        );
        await unchanged();
        await page
          .locator(
            ".conversation-workspace > .reply-composer .formatting-help summary",
          )
          .click();
        await expect(
          page.locator(
            ".conversation-workspace > .reply-composer .formatting-help",
          ),
        ).toHaveAttribute("open", "");
        await unchanged();
        await page
          .getByRole("button", { name: "Collapse reply", exact: true })
          .click();
        await unchanged();
        await expect(reply).toHaveValue(/A retained draft/);
        await page
          .getByRole("button", { name: "Expand reply", exact: true })
          .focus();
        await page.keyboard.press("Enter");
        await expect(reply).toBeFocused();
        await expect(reply).toHaveValue(/A retained draft/);
        await unchanged();
        await page
          .getByRole("button", { name: "Collapse reply", exact: true })
          .click();
        await page
          .locator(".conversation-workspace")
          .getByLabel("Attach files to reply")
          .setInputFiles({
            name: "draft-note.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Draft attachment"),
          });
        const pending = page.locator(".conversation-workspace .pending-files");
        await expect(pending.getByText("draft-note.txt")).toBeVisible();
        await unchanged();
        await page
          .getByRole("button", { name: "Collapse reply", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Expand reply", exact: true })
          .click();
        await expect(pending.getByText("draft-note.txt")).toBeVisible();
        await pending
          .getByRole("button", { name: "Remove draft-note.txt" })
          .click();
        await expect(pending).toHaveCount(0);
        await page
          .getByRole("button", { name: "Collapse reply", exact: true })
          .click();
        await page.request.post(url + `/api/threads/${thread.id}/replies`, {
          headers: { Authorization: "Bearer reading-space-agent" },
          data: { body: "Incoming while reading history" },
        });
        await expect(
          page.getByRole("button", { name: /1 new reply/ }),
        ).toBeVisible();
        await unchanged();
        await page
          .getByRole("button", { name: "Expand reply", exact: true })
          .click();
        await reply.fill("Posted from the expanded composer");
        await page.getByRole("button", { name: "Reply", exact: true }).click();
        await expect(
          reading.getByText("Posted from the expanded composer", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(reply).toHaveValue("");
        await page
          .getByRole("button", { name: "Search everywhere", exact: true })
          .click();
        await expect(
          page.getByRole("textbox", { name: "Search everything", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, []);
      } finally {
        await browser?.close();
        await new Promise((r) => server.close(r));
        app.locals.shutdown();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
