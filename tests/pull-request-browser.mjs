import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: repository PR policy editing, approved publication and external merge status",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-pr-ui-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "pr-browser-password",
        AGENT_SPARK_TOKEN: "pr-browser-spark",
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
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const repo = {
      id: 1,
      name: "Garden",
      url: "https://github.com/acme/garden.git",
      main_branch: "main",
      require_human: false,
      merge_mode: "direct",
      github_token_configured: false,
    };
    const branch = {
      id: 1,
      repository_id: 1,
      repository_name: "Garden",
      name: "work/seeds",
      owner_id: 1,
      owner_name: "Admin",
      state: "active",
      head_commit: "a".repeat(40),
      thread_ids: [1],
      dependencies: [],
      reviews: [
        {
          id: 1,
          reviewer_id: 2,
          reviewer_name: "Reviewer",
          commit_hash: "a".repeat(40),
          target_commit: "b".repeat(40),
          decision: "approved",
          body: "Checked.",
        },
      ],
      pull_request: null,
    };
    const repositories = [repo];
    let registered,
      policy,
      publicationAttempts = 0,
      syncAttempts = 0;
    try {
      await page.route("**/api/orchestration", (route) =>
        route.fulfill({
          json: {
            repositories,
            branches: [branch],
            capabilities: [{ user_id: 1, can_work: true, can_review: true }],
          },
        }),
      );
      await page.route("**/api/repositories", async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        registered = route.request().postDataJSON();
        repositories.push({
          ...registered,
          id: 2,
          github_token_configured: true,
        });
        await route.fulfill({ json: repositories[1] });
      });
      await page.route("**/api/repositories/1", async (route) => {
        policy = route.request().postDataJSON();
        const { github_token_env, ...publicPolicy } = policy;
        Object.assign(repo, publicPolicy, {
          github_token_configured:
            !!github_token_env || repo.github_token_configured,
        });
        await route.fulfill({ json: repo });
      });
      await page.route("**/api/branches?thread_id=*", (route) =>
        route.fulfill({ json: [branch] }),
      );
      await page.route("**/api/branches/1", (route) =>
        route.fulfill({ json: branch }),
      );
      await page.route("**/api/branches/1/merge", async (route) => {
        publicationAttempts++;
        if (publicationAttempts === 1)
          return route.fulfill({
            status: 409,
            json: {
              error:
                "Review approval is required before opening a pull request",
            },
          });
        branch.pull_request = {
          number: 42,
          url: "https://github.com/acme/garden/pull/42",
          state: "open",
          head_commit: branch.head_commit,
          base_commit: "b".repeat(40),
          merge_commit: null,
          synced_at: "2026-10-21T00:00:00.000Z",
          error: null,
        };
        await route.fulfill({ json: branch });
      });
      await page.route("**/api/branches/1/pull-request/sync", async (route) => {
        syncAttempts++;
        if (syncAttempts === 1)
          return route.fulfill({
            status: 503,
            json: { error: "GitHub is temporarily unavailable" },
          });
        branch.pull_request = {
          ...branch.pull_request,
          state: syncAttempts === 2 ? "closed" : "merged",
          synced_at: "2026-10-21T01:00:00.000Z",
          error:
            syncAttempts === 2
              ? "Last GitHub sync reported a temporary rate limit"
              : null,
          merge_commit: syncAttempts >= 3 ? "d".repeat(40) : null,
        };
        if (syncAttempts >= 3) branch.state = "merged";
        await route.fulfill({ json: branch });
      });
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("pr-browser-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      const garden = page.locator(".orchestration-card").filter({
        has: page.getByText("Garden", { exact: true }),
      });
      await garden.locator("summary").click();
      await garden
        .getByRole("button", { name: "Edit settings", exact: true })
        .click();
      await expect(garden).toContainText("Direct merge by the board");
      await garden
        .getByLabel("Merge mode", { exact: true })
        .selectOption("pull_request");
      await garden.getByLabel("GitHub owner", { exact: true }).fill("acme");
      await garden
        .getByLabel("GitHub repository", { exact: true })
        .fill("garden");
      await garden
        .getByLabel("GitHub token", { exact: true })
        .selectOption("legacy");
      await garden
        .getByLabel("GitHub token environment variable", { exact: false })
        .fill("PROJECT_GITHUB_TOKEN");
      await garden
        .getByRole("button", { name: "Save settings", exact: true })
        .click();
      await expect(garden).toContainText("GitHub pull request · acme/garden");
      assert.equal(policy.merge_mode, "pull_request");
      assert.equal(policy.pr_provider, "github");
      assert.equal(policy.github_token_env, "PROJECT_GITHUB_TOKEN");
      await garden
        .getByRole("button", { name: "Edit settings", exact: true })
        .click();
      await expect(
        garden.getByLabel("GitHub token environment variable", {
          exact: false,
        }),
      ).toHaveValue("");
      await page
        .getByRole("button", { name: "Register repository", exact: true })
        .click();
      const registration = page.locator(".orchestration-card").filter({
        has: page.getByRole("heading", {
          name: "Register repository",
          exact: true,
        }),
      });
      await registration
        .getByLabel("Name", { exact: true })
        .fill("New project");
      await registration
        .getByLabel("Git URL", { exact: true })
        .fill("https://github.com/acme/new-project.git");
      await registration
        .getByLabel("Merge mode", { exact: true })
        .selectOption("pull_request");
      await registration
        .getByLabel("GitHub owner", { exact: true })
        .fill("acme");
      await registration
        .getByLabel("GitHub repository", { exact: true })
        .fill("new-project");
      await registration
        .getByLabel("GitHub token", { exact: true })
        .selectOption("legacy");
      await registration
        .getByLabel("GitHub token environment variable", { exact: false })
        .fill("NEW_PROJECT_GITHUB_TOKEN");
      await registration
        .getByRole("button", { name: "Register repository", exact: true })
        .click();
      await expect(
        page.getByText("New project", { exact: true }),
      ).toBeVisible();
      assert.equal(registered.merge_mode, "pull_request");
      assert.equal(registered.github_token_env, "NEW_PROJECT_GITHUB_TOKEN");
      await page.getByRole("button", { name: /All work/ }).click();
      await page
        .getByLabel("Message", { exact: true })
        .fill("Ship garden seeds");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page
        .locator(".thread-row")
        .filter({ hasText: "Ship garden seeds" })
        .click();
      await page.getByRole("button", { name: "Branches", exact: true }).click();
      await page.getByRole("button", { name: /work\/seeds.*Garden/ }).click();
      await expect(page.locator(".branch-detail")).toContainText(
        "Integration: GitHub pull request · acme/garden",
      );
      const status = page.getByRole("region", {
        name: "Pull request status",
        exact: true,
      });
      await expect(status).toContainText("No pull request published yet");
      await expect(
        page.getByRole("button", {
          name: "Request merge into main",
          exact: true,
        }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Open/update pull request", exact: true })
        .click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Review approval is required" }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Open/update pull request", exact: true })
        .click();
      await expect(
        status.getByRole("link", { name: /View on GitHub/ }),
      ).toHaveAttribute("href", "https://github.com/acme/garden/pull/42");
      await expect(status).toContainText("Open");
      await expect(status).toContainText("Last synced");
      await status
        .getByRole("button", {
          name: "Refresh pull request status",
          exact: true,
        })
        .click();
      await expect(status.getByRole("alert")).toContainText(
        "GitHub is temporarily unavailable",
      );
      await status
        .getByRole("button", {
          name: "Refresh pull request status",
          exact: true,
        })
        .click();
      await expect(status).toContainText("Closed");
      await expect(status.getByRole("alert")).toContainText(
        "temporary rate limit",
      );
      await status
        .getByRole("button", {
          name: "Refresh pull request status",
          exact: true,
        })
        .click();
      await expect(status).toContainText("Merged");
      await expect(status).toContainText("dddddddddddd");
      await expect(
        page.getByRole("button", {
          name: "Open/update pull request",
          exact: true,
        }),
      ).toHaveCount(0);
      assert.equal(publicationAttempts, 2);
      assert.equal(syncAttempts, 3);
      await expect(
        page.getByRole("button", { name: /Merge (pull request|on GitHub)/i }),
      ).toHaveCount(0);
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: "test-results/pull-request-branch.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () =>
          page
            .locator(".sidebar")
            .evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      assert.ok(
        await page
          .locator(".branch-detail")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      );
      await page.screenshot({
        path: "test-results/pull-request-branch-mobile.png",
      });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
