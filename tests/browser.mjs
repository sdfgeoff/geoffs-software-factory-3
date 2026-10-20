import "./orchestration-browser.mjs";
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

test(
  "browser: global search spans channels, replies, files, people, private reminders and admin logs",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-search-browser-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "browser-search-password",
        AGENT_SPARK_TOKEN: "browser-search-token",
      },
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(8000);
    try {
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser-search-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /All work/ }),
      ).toBeVisible();
      const create = async (path, body) => {
        const response = await context.request.post(url + "/api" + path, {
          data: body,
        });
        expect(response.ok()).toBeTruthy();
        return response.json();
      };
      const channel = await create("/channels", {
        name: "search-garden",
        description: "Cross-channel garden discussions",
      });
      const thread = await create("/threads", {
        channel_id: channel.id,
        title: "Planning spring planting",
        body: "A garden thread outside the current channel",
      });
      for (let i = 0; i < 12; i++)
        await create(`/threads/${thread.id}/replies`, {
          body: `Earlier discussion ${i}`,
        });
      const reply = await create(`/threads/${thread.id}/replies`, {
        body: "A hidden crocus reply worth finding",
      });
      const file = await context.request.post(url + "/api/attachments", {
        multipart: {
          file: {
            name: "tulip-sketch.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("A sketch"),
          },
        },
      });
      const attachment = await file.json();
      await create(`/threads/${thread.id}/replies`, {
        body: "",
        attachment_ids: [attachment.id],
      });
      await create("/notification-schedules", {
        message: "Private watering reminder",
        when: "in one hour",
      });
      await create("/admin/users", {
        username: "alex",
        name: "Alex Gardener",
        password: "browser-search-person",
      });
      const agent = app.locals.db.prepare("SELECT user_id FROM agents").get();
      app.locals.db
        .prepare(
          "INSERT INTO agent_logs(agent_id,level,message,created_at) VALUES(?,'info','Greenhouse runtime trace',?)",
        )
        .run(agent.user_id, new Date().toISOString());
      async function find(query) {
        await page
          .getByRole("button", { name: "Search everywhere", exact: true })
          .click();
        await page.getByLabel("Search everything", { exact: true }).fill(query);
      }
      await page
        .getByRole("button", { name: "Open inbox", exact: true })
        .click();
      await page.keyboard.press("Control+k");
      await expect(
        page.getByLabel("Search everything", { exact: true }),
      ).toBeFocused();
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("crocus");
      await expect(page.locator(".global-search-result")).toHaveCount(1);
      await page
        .getByLabel("Search everything", { exact: true })
        .press("ArrowDown");
      await expect(page.locator(".global-search-result")).toBeFocused();
      await page.keyboard.press("Control+k");
      await expect(
        page.getByLabel("Search everything", { exact: true }),
      ).toBeFocused();
      await page
        .getByLabel("Search everything", { exact: true })
        .press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("heading", {
          name: "Planning spring planting",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator(`#reply-${reply.id}`)).toHaveClass(
        /search-target/,
      );
      await expect(page.locator(`#reply-${reply.id}`)).toBeInViewport();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await page.keyboard.press("Control+k");
      await expect(
        page.getByLabel("Search everything", { exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("dialog", { name: "Thread details", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Activity", exact: true }),
      ).toHaveClass(/selected/);
      await page.keyboard.press("Control+k");
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("crocus");
      await page.locator(".global-search-result").click();
      await expect(
        page.getByRole("button", { name: /^Discussion/ }),
      ).toHaveClass(/selected/);
      await expect(page.locator(`#reply-${reply.id}`)).toBeInViewport();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await find("tulip-sketch");
      await expect(page.locator(".global-search-result")).toContainText(
        "Attachment",
      );
      await page.locator(".global-search-result").click();
      await expect(
        page.getByRole("heading", {
          name: "Planning spring planting",
          exact: true,
        }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await find("Alex Gardener");
      await page.locator(".global-search-result").click();
      await expect(page.locator(".person-row.search-target")).toContainText(
        "Alex Gardener",
      );
      await find("Private watering");
      await expect(page.locator(".global-search-result")).toContainText(
        "Private reminder · active",
      );
      await page.locator(".global-search-result").click();
      await expect(page.locator(".reminder-row.search-target")).toContainText(
        "Private watering reminder",
      );
      await find("Greenhouse runtime");
      await expect(page.locator(".global-search-result")).toContainText(
        "Runtime log",
      );
      await page.locator(".global-search-result").click();
      await expect(
        page
          .locator(".runtime-logs > div")
          .filter({ hasText: "Greenhouse runtime trace" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Configuration", exact: true })
        .click();
      await page.keyboard.press("Control+k");
      await expect(
        page.getByRole("dialog", { name: "Search everywhere", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByLabel("Search everything", { exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Configuration", exact: true }),
      ).toHaveClass(/selected/);
      await page.keyboard.press("Control+k");
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("Greenhouse runtime");
      await page.locator(".global-search-result").click();
      await expect(
        page.getByRole("button", { name: "Runtime log", exact: true }),
      ).toHaveClass(/selected/);
      await expect(
        page
          .locator(".runtime-logs > div")
          .filter({ hasText: "Greenhouse runtime trace" }),
      ).toBeVisible();
      await page.keyboard.press("Control+k");
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("crocus");
      await page.locator(".global-search-result").click();
      await expect(page.locator(".agent-detail-tabs")).toHaveCount(0);
      await expect(page.locator(`#reply-${reply.id}`)).toBeInViewport();
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await find("search-garden");
      await page.locator(".global-search-result").click();
      await expect(
        page.getByRole("heading", { name: /search-garden/ }),
      ).toBeVisible();
      for (let i = 0; i < 35; i++)
        app.locals.db
          .prepare(
            "INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at) VALUES(1,?,'',1,1,?,?)",
          )
          .run(
            `Pagination result ${i}`,
            new Date().toISOString(),
            new Date().toISOString(),
          );
      await find("Pagination");
      await expect(page.locator(".global-search-result")).toHaveCount(30);
      await page
        .getByRole("button", { name: "Load more results", exact: true })
        .click();
      await expect(page.locator(".global-search-result")).toHaveCount(35);
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("does-not-exist");
      await expect(page.getByRole("status")).toHaveText("No results found.");
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("garden");
      await expect(page.locator(".global-search-result").first()).toBeVisible();
      await page.screenshot({ path: "test-results/search-desktop.png" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByLabel("Username", { exact: true }).fill("alex");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser-search-person");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Search everywhere", exact: true }),
      ).toBeVisible();
      await find("Private watering");
      await expect(page.getByRole("status")).toHaveText("No results found.");
      await page
        .getByLabel("Search everything", { exact: true })
        .fill("Greenhouse runtime");
      await expect(page.getByRole("status")).toHaveText("No results found.");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await find("garden");
      await expect(page.locator(".global-search-result").first()).toBeVisible();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({ path: "test-results/search-mobile.png" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
