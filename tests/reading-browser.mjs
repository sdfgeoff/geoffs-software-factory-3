import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
  "base64",
);
for (const width of [1440, 390])
  test(
    `browser: reading positions, targets and live replies at ${width}px`,
    { timeout: 90000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "tw-reading-"));
      const app = createApp({
        dataDir: dir,
        env: {
          ADMIN_PASSWORD: "reading-test-password",
          AGENT_SPARK_TOKEN: "reading-test-spark",
        },
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
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      let releaseImage;
      try {
        await page.request.post(url + "/api/login", {
          data: { username: "admin", password: "reading-test-password" },
        });
        async function post(path, data, incoming = false) {
          const r = await page.request.post(url + "/api" + path, {
            data,
            ...(incoming
              ? { headers: { Authorization: "Bearer reading-test-spark" } }
              : {}),
          });
          assert.equal(r.status(), 200, await r.text());
          return r.json();
        }
        const image = await (
          await page.request.post(url + "/api/attachments", {
            headers: { Authorization: "Bearer reading-test-spark" },
            multipart: {
              file: {
                name: "delayed.png",
                mimeType: "image/png",
                buffer: pixel,
              },
            },
          })
        ).json();
        const one = await post("/threads", {
          channel_id: 1,
          title: "Long reading conversation",
          body: "Opening context",
        });
        const replies = [];
        for (let i = 1; i <= 16; i++)
          replies.push(
            await post(
              `/threads/${one.id}/replies`,
              {
                body: `Reading sample ${i}\n\n${"A long message gives the reader enough history to scroll and inspect. ".repeat(8)}`,
                ...(i === 1 ? { attachment_ids: [image.id] } : {}),
              },
              true,
            ),
          );
        const two = await post("/threads", {
          channel_id: 1,
          title: "Another conversation",
          body: "Separate reading history",
        });
        for (let i = 0; i < 8; i++)
          await post(
            `/threads/${two.id}/replies`,
            { body: `Other ${i} ${"A separate conversation. ".repeat(30)}` },
            true,
          );
        const gate = new Promise((r) => (releaseImage = r));
        await page.route(`**/api/attachments/${image.id}`, async (route) => {
          await gate;
          await route.continue();
        });
        await page.goto(url);
        const scroll = page.locator(".thread-scroll");
        const jump = page.getByRole("button", { name: /Jump to latest/ });
        const distance = () =>
          scroll.evaluate(
            (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
          );
        const top = () => scroll.evaluate((el) => el.scrollTop);
        async function open(title) {
          await page.locator(".thread-row").filter({ hasText: title }).click();
          await expect(scroll).toBeVisible();
        }
        async function close() {
          await page
            .getByRole("button", { name: "Close thread", exact: true })
            .click();
        }
        await open(one.title);
        await expect.poll(distance).toBeLessThanOrEqual(32);
        await expect(page.locator(".reply").first()).toContainText(
          "Reading sample 1",
        );
        await expect(page.locator(".reply").last()).toContainText(
          "Reading sample 16",
        );
        await scroll.evaluate((el) => {
          el.scrollTop = 600;
        });
        await expect(jump).toBeVisible();
        const saved = await top();
        const incoming = await post(
          `/threads/${one.id}/replies`,
          { body: "Incoming while reading history" },
          true,
        );
        await expect(page.locator(`#reply-${incoming.id}`)).toBeAttached();
        await expect(jump).toContainText("1 new reply");
        assert.ok(
          Math.abs((await top()) - saved) < 3,
          "incoming reply preserves history position",
        );
        // Image dimensions arriving above the viewport preserve the visible reply anchor.
        const anchor = await scroll.evaluate((el) => {
          const top = el.getBoundingClientRect().top;
          const r = [...el.querySelectorAll(".reply")].find(
            (r) => r.getBoundingClientRect().bottom > top,
          );
          return { id: r.id, offset: r.getBoundingClientRect().top - top };
        });
        releaseImage();
        await expect
          .poll(() =>
            page
              .locator(`.attachment img`)
              .first()
              .evaluate((img) => img.complete && img.naturalWidth > 0),
          )
          .toBe(true);
        await expect
          .poll(() =>
            page
              .locator(`#${anchor.id}`)
              .evaluate(
                (el, offset) =>
                  Math.abs(
                    el.getBoundingClientRect().top -
                      document
                        .querySelector(".thread-scroll")
                        .getBoundingClientRect().top -
                      offset,
                  ),
                anchor.offset,
              ),
          )
          .toBeLessThan(3);
        const restored = await top();
        // An ordinary mutation/refresh must not reapply a prior target or jump to latest.
        const changed = await page.request.patch(
          url + `/api/threads/${one.id}`,
          {
            data: { status_id: 2 },
          },
        );
        assert.equal(changed.status(), 200, await changed.text());
        assert.equal((await changed.json()).status_id, 2);
        await expect(
          page.locator(".thread-detail .thread-properties select").first(),
        ).toHaveValue("2");
        assert.ok(Math.abs((await top()) - restored) < 3);
        await close();
        await open(two.title);
        await expect.poll(distance).toBeLessThanOrEqual(32);
        await scroll.evaluate((el) => {
          el.scrollTop = 200;
        });
        await expect(jump).toBeVisible();
        const secondTop = await top();
        await close();
        await open(one.title);
        await expect
          .poll(async () => Math.abs((await top()) - restored))
          .toBeLessThan(3);
        await close();
        await open(two.title);
        await expect
          .poll(async () => Math.abs((await top()) - secondTop))
          .toBeLessThan(3);
        await close();
        await open(one.title);
        await jump.click();
        await expect.poll(distance).toBeLessThanOrEqual(32);
        await expect(scroll).toBeFocused();
        const following = await post(
          `/threads/${one.id}/replies`,
          { body: "Follow this latest reply" },
          true,
        );
        await expect(page.locator(`#reply-${following.id}`)).toBeAttached();
        await expect.poll(distance).toBeLessThanOrEqual(32);
        // Failed posting retains draft and history; success reveals the saved reply.
        await scroll.evaluate((el) => {
          el.scrollTop = 500;
        });
        await expect(jump).toBeVisible();
        const failedTop = await top();
        await page
          .getByLabel("Reply", { exact: true })
          .fill("My saved reply from history");
        await page.route(`**/api/threads/${one.id}/replies`, (route) =>
          route.request().method() === "POST"
            ? route.fulfill({
                status: 503,
                json: { error: "Test reply failure" },
              })
            : route.continue(),
        );
        await page.getByRole("button", { name: "Reply", exact: true }).click();
        await expect(page.getByLabel("Reply", { exact: true })).toHaveValue(
          "My saved reply from history",
        );
        assert.ok(Math.abs((await top()) - failedTop) < 3);
        await page.unroute(`**/api/threads/${one.id}/replies`);
        await page.getByRole("button", { name: "Reply", exact: true }).click();
        await expect(page.locator(".reply").last()).toContainText(
          "My saved reply from history",
        );
        await expect.poll(distance).toBeLessThanOrEqual(32);
        // Search and inbox target an older reply even when a bottom position is remembered.
        await close();
        await page
          .getByRole("button", { name: "Search everywhere", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Search everything", exact: true })
          .fill("Reading sample 4");
        await page
          .locator(".global-search-result")
          .filter({ hasText: "Reading sample 4" })
          .first()
          .click();
        const targeted = page.locator(`#reply-${replies[3].id}`);
        await expect(targeted).toHaveClass(/search-target/);
        assert.ok((await distance()) > 32);
        await close();
        await expect(
          page.getByLabel("Search everything", { exact: true }),
        ).toHaveValue("Reading sample 4");
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Open inbox", exact: true })
          .click();
        await page
          .locator(".inbox-item")
          .filter({ hasText: "Reading sample 2" })
          .first()
          .click();
        await expect(page.locator(`#reply-${replies[1].id}`)).toHaveClass(
          /search-target/,
        );
        // Direct target entry survives refresh and an unauthenticated sign-in.
        const link = `${url}/?thread=${one.id}&reply=${replies[4].id}`;
        await page.goto(link);
        await expect(page.locator(`#reply-${replies[4].id}`)).toHaveClass(
          /search-target/,
        );
        await page.reload();
        await expect(page.locator(`#reply-${replies[4].id}`)).toHaveClass(
          /search-target/,
        );
        await page.context().clearCookies();
        await page.goto(link);
        await page.getByLabel("Username", { exact: true }).fill("admin");
        await page
          .getByLabel("Password", { exact: true })
          .fill("reading-test-password");
        await page
          .getByRole("button", { name: "Sign in", exact: true })
          .click();
        await expect(page.locator(`#reply-${replies[4].id}`)).toHaveClass(
          /search-target/,
        );
        await scroll.evaluate((el) => {
          el.scrollTop = 300;
        });
        await expect(jump).toBeVisible();
        await post(
          `/threads/${one.id}/replies`,
          { body: "New activity for screenshot" },
          true,
        );
        await expect(jump).toContainText("new reply");
        mkdirSync("test-results", { recursive: true });
        await page.screenshot({
          path: `test-results/reading-history-${width}.png`,
        });
        await jump.click();
        await expect.poll(distance).toBeLessThanOrEqual(32);
        await page.screenshot({
          path: `test-results/reading-latest-${width}.png`,
        });
        assert.deepEqual(errors, []);
      } finally {
        releaseImage?.();
        await browser.close();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        app.locals.shutdown();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
