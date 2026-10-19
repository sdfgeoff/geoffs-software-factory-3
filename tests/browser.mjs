import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
test(
  "browser: accounts, channels, shared views, attachments, inbox and responsive layout",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-browser-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "browser-admin-password",
        AGENT_SPARK_TOKEN: "browser-spark-token",
        AGENT_SAGE_TOKEN: "browser-sage-token",
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const executablePath =
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
    const browser = await chromium.launch({
      headless: true,
      executablePath,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    mkdirSync("test-results", { recursive: true });
    try {
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser-admin-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /All work/ }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Create channel", exact: true })
        .click();
      await page
        .getByLabel("Channel name", { exact: true })
        .fill("product-design");
      await page
        .getByLabel("Description", { exact: true })
        .fill("Ideas, designs, and the path to shipping.");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Create channel", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: /People & agents/ }).click();
      await page
        .getByRole("button", { name: "Add person", exact: true })
        .click();
      await page
        .getByLabel("Display name", { exact: true })
        .fill("Alex Morgan");
      await page.getByLabel("Username", { exact: true }).fill("alex");
      await page
        .getByLabel("Initial password", { exact: true })
        .fill("alex-browser-password");
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByText("Alex Morgan", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "product-design", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Subscribe", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Subscribed", exact: true }),
      ).toBeVisible();
      const generatedTitle = "Design an approachable onboarding flow";
      const editedTitle = "Design an approachable onboarding flow together";
      const openingBody = `${generatedTitle}\n\nA first impression that helps people find their next step. @spark, bring your perspective.`;
      const imageFile = (name) => ({
        name,
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHo0AAAAASUVORK5CYII=",
          "base64",
        ),
      });
      await page.getByLabel("Message", { exact: true }).fill(openingBody);
      await page
        .getByLabel("Attach files to message", { exact: true })
        .setInputFiles(imageFile("opening.png"));
      await expect(
        page.getByText("opening.png", { exact: true }),
      ).toBeVisible();
      const failCreation = async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Temporary test failure" }),
          });
        } else await route.continue();
      };
      await page.route("**/api/threads", failCreation);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Temporary test failure" }),
      ).toBeVisible();
      await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
        openingBody,
      );
      await expect(
        page.getByText("opening.png", { exact: true }),
      ).toBeVisible();
      await page.unroute("**/api/threads", failCreation);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.locator(".thread-row").filter({ hasText: generatedTitle }),
      ).toBeVisible();
      await page
        .locator(".thread-row")
        .filter({ hasText: generatedTitle })
        .click();
      await expect(
        page.getByRole("heading", { name: generatedTitle, exact: true }),
      ).toBeVisible();
      await expect(page.locator(".thread-description img")).toBeVisible();
      await page
        .getByRole("button", { name: "Edit thread", exact: true })
        .click();
      await page.getByLabel("Title", { exact: true }).fill(editedTitle);
      await page
        .getByLabel("Status", { exact: true })
        .last()
        .selectOption({ label: "Ready" });
      await page
        .getByLabel("Assignee", { exact: true })
        .last()
        .selectOption({ label: "Spark · AI" });
      await page
        .getByRole("button", { name: "Save changes", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: editedTitle, exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Reply", { exact: true })
        .fill("Here is a first visual direction.");
      await page
        .getByLabel("Attach files to reply", { exact: true })
        .setInputFiles(imageFile("direction.png"));
      await expect(
        page.getByText("direction.png", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Reply", exact: true }).click();
      await expect(page.locator(".reply img")).toBeVisible();
      await expect(
        page.getByText("Here is a first visual direction.", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await expect(page.locator(".board-card")).toHaveCount(1);
      await page
        .getByLabel(`Status of ${editedTitle}`)
        .selectOption({ label: "In progress" });
      await expect(
        page
          .locator(".board-column")
          .filter({
            has: page.locator("header").filter({ hasText: "In progress" }),
          })
          .locator(".board-card"),
      ).toHaveCount(1);
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await expect(page.locator(".thread-row .status-pill")).toHaveText(
        "In progress",
      );
      const sparkResponse = await fetch(url + "/api/threads/1/replies", {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-spark-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          body: "I reviewed the first direction and left notes.",
        }),
      });
      assert.equal(sparkResponse.status, 200);
      await page.getByRole("button", { name: /^Inbox/ }).click();
      await expect(
        page.getByText("I reviewed the first direction and left notes.", {
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByLabel("Reminder message", { exact: true })
        .fill("Check the build");
      await page.getByLabel("When", { exact: true }).fill("in one hour");
      await page
        .getByLabel("Repeat (optional)", { exact: true })
        .fill("every 1 day");
      let schedulePosts = 0;
      let releaseSchedule;
      const scheduleGate = new Promise((resolve) => {
        releaseSchedule = resolve;
      });
      await page.route("**/api/notification-schedules", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        schedulePosts += 1;
        if (schedulePosts === 1)
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "Test schedule failure" }),
          });
        await scheduleGate;
        return route.continue();
      });
      await page
        .getByRole("button", { name: "Schedule reminder", exact: true })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Test schedule failure",
      );
      await expect(
        page.getByLabel("Reminder message", { exact: true }),
      ).toHaveValue("Check the build");
      await expect(page.getByLabel("When", { exact: true })).toHaveValue(
        "in one hour",
      );
      await expect(
        page.getByLabel("Repeat (optional)", { exact: true }),
      ).toHaveValue("every 1 day");
      await expect(page.locator(".reminder-row")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Schedule reminder", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Scheduling…", exact: true }),
      ).toBeDisabled();
      await page.locator(".reminder-panel form").evaluate((form) => {
        form.requestSubmit();
        form.requestSubmit();
      });
      releaseSchedule();
      await expect(page.locator(".reminder-row")).toContainText(
        "Check the build",
      );
      assert.equal(
        schedulePosts,
        2,
        "one failed attempt and one retry, without duplicate pending submissions",
      );
      await page.unroute("**/api/notification-schedules");
      await expect(page.locator(".reminder-row")).toContainText("every 1 day");
      await page
        .getByRole("button", {
          name: "Cancel reminder: Check the build",
          exact: true,
        })
        .click();
      await expect(page.locator(".reminder-row")).toHaveCount(0);
      for (const [repeat, label] of [
        ["every 2 weeks", "every 2 weeks"],
        ["every 2 hours", "every 2 hours"],
        ["every 30 minutes", "every 30 minutes"],
        ["every 90 seconds", "every 90 seconds"],
      ]) {
        const message = `Interval display: ${repeat}`;
        const created = await page.request.post(
          `${url}/api/notification-schedules`,
          { data: { message, when: "in one hour", repeat } },
        );
        assert.equal(created.status(), 200);
        const row = page.locator(".reminder-row").filter({ hasText: message });
        await expect(row.locator("p")).toContainText(label);
        await row
          .getByRole("button", {
            name: `Cancel reminder: ${message}`,
            exact: true,
          })
          .click();
        await expect(row).toHaveCount(0);
      }
      const longMessage =
        "A private timed reminder: " + "remember this detail ".repeat(10);
      await page
        .getByLabel("Reminder message", { exact: true })
        .fill(longMessage);
      await page.getByLabel("When", { exact: true }).fill("in 1 second");
      await page
        .getByRole("button", { name: "Schedule reminder", exact: true })
        .click();
      await expect(
        page.locator(".inbox-item").filter({ hasText: longMessage.trim() }),
      ).toBeVisible();
      await expect(page.locator(".reminder-row")).toHaveCount(0);
      await page.getByRole("button", { name: "Mark all read" }).click();
      await expect(page.locator(".inbox-item.unread")).toHaveCount(0);
      await page
        .getByRole("button", { name: "product-design", exact: true })
        .click();
      await page.screenshot({
        path: "test-results/workspace-desktop.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page.screenshot({
        path: "test-results/board-desktop.png",
        fullPage: true,
      });
      await page.getByRole("button", { name: /People & agents/ }).click();
      await page
        .getByRole("button", { name: "Manage", exact: false })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page
        .getByRole("button", { name: "Configuration", exact: true })
        .click();
      await expect(
        page.getByText("Channel subscriptions", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "product-design", exact: true })
        .click();
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      await expect
        .poll(() =>
          page
            .locator(".sidebar")
            .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await expect(page.locator(".thread-row")).toBeVisible();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "mobile page must not overflow horizontally",
      );
      await page.screenshot({
        path: "test-results/workspace-mobile.png",
        fullPage: true,
      });
      await page.locator(".thread-row").click();
      await expect(page.locator(".reply img")).toBeVisible();
      await page.screenshot({
        path: "test-results/thread-mobile.png",
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Board", exact: true }).click();
      await page
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      const createDialog = page.getByRole("dialog");
      await createDialog
        .locator("input[type=file]")
        .setInputFiles(imageFile("attachment-only.png"));
      await expect(
        createDialog.getByText("attachment-only.png", { exact: true }),
      ).toBeVisible();
      await createDialog
        .getByRole("button", { name: "Send", exact: true })
        .click();
      await expect(
        page
          .getByRole("dialog", { name: "Thread details" })
          .getByRole("heading", { name: "attachment-only.png", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".thread-description img")).toBeVisible();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await page.getByRole("button", { name: "Threads", exact: true }).click();
      const message = page.getByLabel("Message", { exact: true });
      await message.fill("Keyboard conversation");
      await message.press("Shift+Enter");
      await message.pressSequentially("Second line stays in the same message.");
      await expect(message).toHaveValue(
        "Keyboard conversation\nSecond line stays in the same message.",
      );
      await message.press("Enter");
      await expect(
        page
          .locator(".thread-row")
          .filter({ hasText: "Keyboard conversation" }),
      ).toBeVisible();
      await expect(message).toHaveValue("");
      await expect(message).toBeFocused();
      const privateMessage = "Private for Admin " + "x".repeat(180);
      const privateReminder = await page.request.post(
        `${url}/api/notification-schedules`,
        {
          data: {
            message: privateMessage,
            when: "in one hour",
            repeat: "every 1 day",
          },
        },
      );
      assert.equal(privateReminder.status(), 200);
      await page.getByRole("button", { name: /^Inbox/ }).click();
      await expect(
        page.locator(".reminder-row").filter({ hasText: privateMessage }),
      ).toBeVisible();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          page
            .locator(".sidebar")
            .evaluate((el) => el.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "long private reminders fit mobile layout",
      );
      await page.screenshot({
        path: "test-results/reminders-mobile.png",
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByLabel("Username", { exact: true }).fill("alex");
      await page
        .getByLabel("Password", { exact: true })
        .fill("alex-browser-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /Your inbox/ }),
      ).toBeVisible();
      await expect(page.getByText(privateMessage, { exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator(".reminder-row")).toHaveCount(0);
      assert.deepEqual(
        await (
          await page.request.get(`${url}/api/notification-schedules`)
        ).json(),
        [],
        "the next account has no access to the prior account's private schedules",
      );
      assert.deepEqual(errors, [], "no browser runtime errors");
    } catch (error) {
      await page.screenshot({
        path: "test-results/browser-failure.png",
        fullPage: true,
      });
      throw error;
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
