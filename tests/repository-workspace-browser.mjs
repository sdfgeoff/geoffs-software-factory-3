import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: repository overview, disclosure, settings recovery and mobile access",
  { timeout: 60000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "repository-workspace-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "repository-fixture-password",
        AGENT_SPARK_TOKEN: "repository-fixture-worker",
      },
    });
    const db = app.locals.db;
    for (const [name, project] of [
      ["Threadwork", "threadwork"],
      ["Map viewer", "map-viewer"],
      ["CarbonCrop App", "carbonco_app"],
    ]) {
      const repo = db
        .prepare(
          "INSERT INTO repositories(name,url,main_branch,created_by,created_at) VALUES(?,?, 'main',1,datetime('now')) RETURNING id",
        )
        .get(name, `git@github.com:example/${project}.git`);
      for (let i = 0; i < 9; i++)
        db.prepare(
          "INSERT INTO managed_branches(repository_id,name,owner_id,state,head_commit,created_at,merged_at) VALUES(?,?,2,?,?,datetime('now'),?)",
        ).run(
          repo.id,
          `spark/change-${i}`,
          i < 2 ? "active" : "merged",
          "a".repeat(40),
          i < 2 ? null : new Date().toISOString(),
        );
    }
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    let browser;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(8000);
    await page.goto(url);
    await page.getByLabel("Username", { exact: true }).fill("admin");
    await page
      .getByLabel("Password", { exact: true })
      .fill("repository-fixture-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page
      .getByRole("button", { name: "Repositories", exact: true })
      .click();
    const sections = page.getByRole("group", { name: "Repository sections" });
    const section = (name) =>
      sections.getByRole("button", { name, exact: true }).click();
    const card = page
      .locator(".repository-card")
      .filter({ hasText: "Threadwork" });
    await expect(page.locator(".repository-card")).toHaveCount(3);
    await expect(page.locator(".repository-card[open]")).toHaveCount(0);
    await expect(card.locator("summary")).toContainText("2 active branches");
    await expect(
      page.getByRole("button", { name: "Save settings", exact: true }),
    ).toHaveCount(0);
    mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/repository-overview.png" });
    await card.locator("summary").focus();
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("open", "");
    await expect(
      card.getByText("git@github.com:example/threadwork.git", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      card.getByText("spark/change-8", { exact: true }),
    ).not.toBeVisible();
    await card
      .getByRole("button", { name: "Show merged branches (7)", exact: true })
      .click();
    await expect(
      card.getByText("spark/change-8", { exact: true }),
    ).toBeVisible();
    await card
      .getByRole("button", { name: "Hide merged branches (7)", exact: true })
      .click();
    await card
      .getByRole("button", { name: "Edit settings", exact: true })
      .click();
    const human = card.getByLabel("Require human review before merging", {
      exact: true,
    });
    await human.check();
    await section("Git access");
    await expect(
      page.getByRole("heading", { name: "Your Git access", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: "Saved repository tokens",
        exact: true,
      }),
    ).toBeVisible();
    await section("Overview");
    await expect(human).toBeChecked();
    let fail = true;
    await page.route("**/api/repositories/1", (route) => {
      if (route.request().method() === "PATCH" && fail) {
        fail = false;
        return route.fulfill({
          status: 503,
          json: { error: "Fixture service unavailable" },
        });
      }
      return route.continue();
    });
    await card
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(card.getByRole("alert")).toContainText(
      "Fixture service unavailable",
    );
    await expect(human).toBeChecked();
    await card
      .getByRole("button", { name: "Save settings", exact: true })
      .click();
    await expect(card.locator("summary")).toContainText(
      "Human review required",
    );
    await expect(
      card.getByRole("button", { name: "Edit settings", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(card).toHaveAttribute("open", "");
    await section("Permissions");
    await expect(
      page.getByRole("heading", {
        name: "Work and review permissions",
        exact: true,
      }),
    ).toBeVisible();
    assert.equal(
      await sections.getByRole("button", { pressed: true }).count(),
      1,
    );
    await section("Overview");
    const search = page.getByRole("searchbox", { name: "Find a repository" });
    await search.fill("carbonco");
    await expect(page.locator(".repository-card:visible")).toHaveCount(1);
    await search.fill("absent repository");
    await expect(
      page.getByRole("status").filter({ hasText: "No repositories match" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await expect(card).toHaveAttribute("open", "");
    await card.locator("summary").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator(".sidebar")).not.toBeInViewport();
    await page.screenshot({
      path: "test-results/repository-overview-mobile.png",
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await card.locator("summary").focus();
    await page.keyboard.press("Space");
    await expect(card).toHaveAttribute("open", "");
    await card
      .getByRole("button", { name: "Edit settings", exact: true })
      .click();
    await expect(card.getByLabel("Merge mode", { exact: true })).toBeVisible();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
  },
);
