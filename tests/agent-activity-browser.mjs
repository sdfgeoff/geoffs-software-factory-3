import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/app.mjs";

test(
  "browser: admin activity streams preserve reading, page history and distinguish ticket tools from wakes",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-activity-browser-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "activity-browser-admin",
        AGENT_SPARK_TOKEN: "activity-browser-agent",
      },
    });
    const db = app.locals.db;
    const timestamp = new Date().toISOString();
    const agent = db
      .prepare("SELECT id FROM users WHERE username='spark'")
      .get().id;
    const ticket = db
      .prepare(
        "INSERT INTO threads(channel_id,title,body,status_id,created_by,created_at,updated_at) VALUES(1,'Inspect activity links','A ticket with direct tool activity.',1,1,?,?) RETURNING id",
      )
      .get(timestamp, timestamp).id;
    const add = (
      type,
      payload,
      { turn = "turn-direct", item = null, links = [] } = {},
    ) => {
      const id = db
        .prepare(
          "INSERT INTO agent_activity(agent_id,event_id,session_id,turn_id,item_id,type,occurred_at,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
        )
        .get(
          agent,
          randomUUID(),
          "persistent-session-smoke",
          turn,
          item,
          type,
          timestamp,
          JSON.stringify(payload),
          timestamp,
        ).id;
      for (const kind of links)
        db.prepare(
          "INSERT INTO agent_activity_links(activity_id,thread_id,kind) VALUES(?,?,?)",
        ).run(id, ticket, kind);
      return id;
    };
    add(
      "turn/started",
      { turn: { id: "turn-historical", status: "inProgress" } },
      { turn: "turn-historical" },
    );
    for (let index = 0; index < 103; index++)
      add(
        "worker/log",
        { message: `Background event ${index}` },
        { turn: "turn-background" },
      );
    const toolId = add(
      "item/completed",
      {
        item: {
          id: "tool-direct",
          type: "mcpToolCall",
          server: "threadwork",
          tool: "read_thread",
          arguments: { thread_id: ticket },
          result: { title: "Direct ticket output" },
        },
      },
      { item: "tool-direct", links: ["tool"] },
    );
    add(
      "item/completed",
      {
        item: {
          id: "command-other",
          type: "commandExecution",
          command: "printf unrelated-command",
          aggregatedOutput: "Command output from the whole turn",
        },
      },
      { item: "command-other" },
    );
    add(
      "item/completed",
      {
        item: {
          id: "summary",
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "A concise recorded summary." },
          ],
        },
      },
      { item: "summary" },
    );
    add(
      "worker/wake",
      { notification_ids: [12], delivery: "steer" },
      { links: ["wake"] },
    );
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
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const activityRequests = [];
    page.on("request", (request) => {
      if (request.url().includes("/activity?"))
        activityRequests.push(request.url());
    });
    try {
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("activity-browser-admin");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page.getByRole("button", { name: /People & agents/ }).click();
      await page
        .getByRole("button", { name: "Manage", exact: false })
        .first()
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("button", { name: "Activity", exact: true })
        .click();
      const activity = page.getByRole("region", {
        name: "Agent activity",
        exact: true,
      });
      await expect(activity.locator(".activity-event")).toHaveCount(100);
      const direct = activity.locator(`[data-activity-id="${toolId}"]`);
      await direct.locator("summary").click();
      await expect(direct.getByLabel("Event details")).toContainText(
        "Direct ticket output",
      );
      await expect(direct).toContainText("persistent-session-smoke");
      await activity
        .getByRole("button", { name: "Load older activity", exact: true })
        .click();
      await expect(activity.locator(".activity-event")).toHaveCount(108);
      await expect(
        activity.getByRole("button", {
          name: "Load older activity",
          exact: true,
        }),
      ).toHaveCount(0);
      const stream = activity.getByRole("region", {
        name: "Activity event timeline",
        exact: true,
      });
      await stream.evaluate((element) => {
        element.scrollTop = 0;
      });
      const position = await stream.evaluate((element) => element.scrollTop);
      const liveId = add(
        "item/agentMessage/delta",
        { delta: "New live message without disturbing reading." },
        { item: "live-message" },
      );
      await expect(
        activity.locator(`[data-activity-id="${liveId}"]`),
      ).toHaveCount(1);
      assert.equal(
        await stream.evaluate((element) => element.scrollTop),
        position,
      );
      await expect(direct).toHaveAttribute("open", "");
      await expect(
        activity.getByRole("button", { name: /Show latest/ }),
      ).toBeVisible();
      assert.ok(
        activityRequests.some((request) =>
          new URL(request).searchParams.has("after"),
        ),
      );
      await activity
        .getByRole("button", { name: "Pause live updates", exact: true })
        .click();
      const pausedId = add(
        "item/agentMessage/delta",
        { delta: "Only arrives after updates resume." },
        { item: "paused-message" },
      );
      await page.waitForTimeout(1200);
      await expect(
        activity.locator(`[data-activity-id="${pausedId}"]`),
      ).toHaveCount(0);
      await activity
        .getByRole("button", { name: "Resume live updates", exact: true })
        .click();
      await expect(
        activity.locator(`[data-activity-id="${pausedId}"]`),
      ).toHaveCount(1);
      await activity
        .getByLabel("Filter by turn ID", { exact: true })
        .fill("turn-historical");
      await activity
        .getByRole("button", { name: "Apply turn filter", exact: true })
        .click();
      await expect(activity.locator(".activity-event")).toHaveCount(1);
      await expect(activity).toContainText("Turn started");
      await activity
        .getByLabel("Filter by turn ID", { exact: true })
        .fill("turn-burst");
      await activity
        .getByRole("button", { name: "Apply turn filter", exact: true })
        .click();
      await expect(activity.locator(".activity-event")).toHaveCount(0);
      for (let index = 0; index < 2100; index++)
        add(
          "worker/log",
          { message: `Burst event ${index}` },
          { turn: "turn-burst" },
        );
      await expect(activity.locator(".activity-event")).toHaveCount(2000);
      await expect(activity).toContainText(
        "This reading window reached 2,000 events.",
      );
      await expect(
        activity.getByRole("button", {
          name: "Resume live updates",
          exact: true,
        }),
      ).toBeDisabled();
      await expect(
        activity.getByLabel("Event details", { exact: true }),
      ).toHaveCount(0);
      await activity
        .getByRole("button", { name: "Refresh agent activity", exact: true })
        .click();
      await expect(activity.locator(".activity-event")).toHaveCount(100);
      await expect(
        activity.getByRole("button", {
          name: "Load older activity",
          exact: true,
        }),
      ).toBeVisible();
      await dialog
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      await page.getByRole("button", { name: /All work/ }).click();
      await page
        .locator(".thread-row")
        .filter({ hasText: "Inspect activity links" })
        .click();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      const ticketActivity = page.getByRole("region", {
        name: "Ticket agent activity",
        exact: true,
      });
      await expect(ticketActivity.locator(".activity-event")).toHaveCount(1);
      await expect(ticketActivity).not.toContainText("Command execution");
      await expect(ticketActivity).not.toContainText("Wake notification ·");
      await ticketActivity
        .getByLabel("Include wake notifications (separately labelled)", {
          exact: true,
        })
        .check();
      await expect(ticketActivity.locator(".activity-event")).toHaveCount(2);
      await expect(ticketActivity).toContainText(
        `Wake notification · TW-${ticket}`,
      );
      await ticketActivity
        .locator(`[data-activity-id="${toolId}"] summary`)
        .click();
      await ticketActivity
        .getByRole("button", { name: "Inspect full turn context", exact: true })
        .click();
      const full = page.getByRole("region", {
        name: "Agent activity",
        exact: true,
      });
      await expect(full).toContainText(
        "This complete turn may include work on other tickets.",
      );
      await expect(full).toContainText("Command execution");
      await expect(full).toContainText("Reasoning summary");
      await full
        .getByRole("button", { name: "Return to ticket activity", exact: true })
        .click();
      await expect(ticketActivity.locator(".activity-event")).toHaveCount(2);
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: "test-results/ticket-agent-activity.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () =>
          page
            .locator(".sidebar")
            .evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      assert.ok(
        await ticketActivity
          .getByRole("region", { name: "Activity event timeline", exact: true })
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
        "Activity timeline fits mobile width",
      );
      await page.screenshot({
        path: "test-results/ticket-agent-activity-mobile.png",
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const memberResponse = await context.request.post(
        url + "/api/admin/users",
        {
          data: {
            username: "observer",
            name: "Observer",
            password: "activity-observer-password",
            admin: false,
          },
        },
      );
      assert.ok(memberResponse.ok());
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByLabel("Username", { exact: true }).fill("observer");
      await page
        .getByLabel("Password", { exact: true })
        .fill("activity-observer-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .locator(".thread-row")
        .filter({ hasText: "Inspect activity links" })
        .click();
      await page.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(
        page.getByRole("region", {
          name: "Ticket agent activity",
          exact: true,
        }),
      ).toHaveCount(0);
      assert.equal(
        (
          await context.request.get(
            url + `/api/admin/threads/${ticket}/activity`,
          )
        ).status(),
        403,
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
