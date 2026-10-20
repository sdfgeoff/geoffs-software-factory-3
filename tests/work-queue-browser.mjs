import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: subscribed work queue, voluntary claims, non-code handoff and separate review",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-queue-browser-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "queue-browser-admin",
        AGENT_SPARK_TOKEN: "queue-browser-agent",
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
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function request(ctx, path, method = "GET", data) {
      const response = await ctx.request.fetch(url + "/api" + path, {
        method,
        ...(data ? { data } : {}),
      });
      assert.ok(response.ok(), await response.text());
      return response.json();
    }
    async function signIn(p, name, password) {
      await p.goto(url);
      await p.getByLabel("Username", { exact: true }).fill(name);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(p.getByRole("heading", { name: /All work/ })).toBeVisible();
    }
    try {
      await signIn(page, "admin", "queue-browser-admin");
      const data = await request(context, "/bootstrap");
      const channel = data.channels[0];
      const ready = data.statuses.find((s) => s.name === "Ready");
      await request(context, `/channels/${channel.id}/subscription`, "PUT", {
        subscribed: true,
      });
      await request(context, "/admin/users", "POST", {
        username: "reviewer",
        name: "Queue Reviewer",
        password: "queue-browser-reviewer",
        admin: false,
      });
      const ticket = await request(context, "/threads", "POST", {
        channel_id: channel.id,
        status_id: ready.id,
        title: "Map future tickets",
        body: "Investigate and produce follow-up tickets, with no code output.",
      });
      await request(context, "/threads", "POST", {
        channel_id: channel.id,
        status_id: ready.id,
        title: "Another eligible task",
        body: "A separate available work block.",
      });
      await page
        .getByRole("button", { name: "Work queue", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Work queue", exact: true }),
      ).toBeVisible();
      await page
        .getByLabel("Notify about Ready work in subscribed channels", {
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "Save work preferences", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await request(context, "/work-preferences")).notify_ready_work,
        )
        .toBe(true);
      const item = page
        .locator(".queue-item")
        .filter({ hasText: "Map future tickets" });
      const blockedClaim = async (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: "Another worker claimed this ticket; refresh the queue.",
          },
        });
      await page.route(`**/api/threads/${ticket.id}/claim`, blockedClaim);
      await item
        .getByRole("button", { name: "Claim work", exact: true })
        .click();
      await expect(item.getByRole("alert")).toContainText(
        "Another worker claimed this ticket",
      );
      await expect(
        item.getByRole("button", { name: "Claim work", exact: true }),
      ).toBeEnabled();
      await page.unroute(`**/api/threads/${ticket.id}/claim`, blockedClaim);
      await item
        .getByRole("button", { name: "Claim work", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Your active work block" }),
      ).toBeVisible();
      await expect(
        page
          .locator(".queue-item")
          .filter({ hasText: "Another eligible task" })
          .getByRole("button", { name: "Claim work", exact: true }),
      ).toBeDisabled();
      await page
        .getByRole("button", { name: "Open active work", exact: true })
        .click();
      await page
        .getByLabel("Outcome / handoff summary", { exact: true })
        .fill(
          "Created follow-up tickets for the roadmap. Review the breakdown and dependencies.",
        );
      await page
        .getByRole("button", { name: "Submit work for review", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: /Submitted outcome/ }),
      ).toBeVisible();
      await expect
        .poll(async () => (await request(context, "/work-queue")).active_claim)
        .toBeNull();
      await expect
        .poll(
          async () =>
            (await request(context, `/threads/${ticket.id}`)).status_name,
        )
        .toBe("In review");
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Your active work block" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /People & agents/ }).click();
      await page
        .getByRole("button", { name: "Manage", exact: false })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Configuration", exact: true })
        .click();
      await page
        .getByLabel("Notify about Ready work in subscribed channels", {
          exact: true,
        })
        .check();
      await page
        .getByLabel("Notify about reviews in subscribed channels", {
          exact: true,
        })
        .check();
      await page
        .getByRole("button", { name: "Save work preferences", exact: true })
        .click();
      const spark =
        data.agents.find((a) => a.username === "spark") || data.agents[0];
      await expect
        .poll(
          async () =>
            (await request(context, `/admin/agents/${spark.user_id}`))
              .work_preferences.notify_ready_reviews,
        )
        .toBe(true);
      await page
        .getByRole("button", { name: "Close dialog", exact: true })
        .click();
      const reviewerContext = await browser.newContext();
      const reviewer = await reviewerContext.newPage();
      await signIn(reviewer, "reviewer", "queue-browser-reviewer");
      await request(
        reviewerContext,
        `/channels/${channel.id}/subscription`,
        "PUT",
        { subscribed: true },
      );
      await reviewer
        .getByRole("button", { name: "Work queue", exact: true })
        .click();
      const reviewItem = reviewer
        .locator(".queue-item")
        .filter({ hasText: "Map future tickets" });
      await reviewItem
        .getByRole("button", { name: "Claim review", exact: true })
        .click();
      await expect(
        reviewer.getByRole("heading", {
          name: "Your active review",
          exact: true,
        }),
      ).toBeVisible();
      await reviewer
        .getByRole("button", { name: "Open active work", exact: true })
        .click();
      await reviewer
        .getByLabel("Outcome review notes", { exact: true })
        .fill("The breakdown is clear and actionable.");
      await reviewer
        .getByRole("button", { name: "Record outcome review", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await request(reviewerContext, `/threads/${ticket.id}`))
              .status_name,
        )
        .toBe("Done");
      await expect
        .poll(
          async () =>
            (await request(reviewerContext, "/work-queue")).active_claim,
        )
        .toBeNull();
      await reviewer
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      mkdirSync("test-results", { recursive: true });
      await reviewer.screenshot({
        path: "test-results/work-queue-desktop.png",
      });
      await reviewer.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () =>
          reviewer
            .locator(".sidebar")
            .evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      assert.ok(
        await reviewer.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await reviewer.screenshot({ path: "test-results/work-queue-mobile.png" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
