import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";

test(
  "browser: managed branch UI preserves review revision and reports merge rejection",
  { timeout: 60000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "threadwork-git-ui-"));
    const app = createApp({
      dataDir: dir,
      env: {
        ADMIN_PASSWORD: "browser-orchestration-password",
        AGENT_SPARK_TOKEN: "browser-orchestration-spark",
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const commit = "a".repeat(40);
    const repository = {
      id: 1,
      name: "Garden",
      url: "https://example.test/garden.git",
      main_branch: "main",
      require_human: false,
    };
    const branch = {
      id: 1,
      repository_id: 1,
      repository_name: "Garden",
      name: "work/seed",
      owner_id: 2,
      owner_name: "Spark",
      state: "active",
      head_commit: commit,
      thread_ids: [1],
      dependencies: [],
      reviews: [],
    };
    const capabilities = [
      { user_id: 1, can_work: true, can_review: true },
      { user_id: 2, can_work: true, can_review: false },
    ];
    let reviewBody;
    try {
      await page.route("**/api/orchestration", (route) =>
        route.fulfill({
          json: {
            repositories: [repository],
            branches: [branch],
            capabilities,
          },
        }),
      );
      await page.route("**/api/branches?thread_id=*", (route) =>
        route.fulfill({ json: [branch] }),
      );
      await page.route("**/api/branches/1", (route) =>
        route.fulfill({ json: branch }),
      );
      await page.route("**/api/branches/1/diff", (route) =>
        route.fulfill({
          json: {
            commit,
            target_commit: "b".repeat(40),
            diff: "+A seed change",
          },
        }),
      );
      await page.route("**/api/branches/1/reviews", async (route) => {
        reviewBody = route.request().postDataJSON();
        branch.reviews.push({
          id: 1,
          reviewer_id: 1,
          reviewer_name: "Admin",
          commit_hash: reviewBody.commit,
          target_commit: "b".repeat(40),
          decision: reviewBody.decision,
          body: reviewBody.body,
        });
        await route.fulfill({ json: branch.reviews[0] });
      });
      await page.route("**/api/branches/1/merge", (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: "Main has moved; update your branch and obtain a new review",
          },
        }),
      );
      await page.route("**/api/git-credentials", (route) =>
        route.fulfill({
          json: {
            username: "admin",
            token: "one-time-test-credential",
            expires_at: "2099-01-01T00:00:00Z",
          },
        }),
      );
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("browser-orchestration-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: /All work/ }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Repositories", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("https://example.test/garden.git", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Register repository", exact: true })
        .click();
      await page
        .locator(".orchestration-card")
        .filter({
          has: page.getByRole("heading", {
            name: "Register repository",
            exact: true,
          }),
        })
        .getByLabel("Git token", { exact: true })
        .selectOption("legacy");
      await expect(
        page.getByLabel("Server credential environment variable"),
      ).toBeVisible();
      await page.getByRole("button", { name: "Cancel registration" }).click();
      await page.getByRole("button", { name: "Create Git credential" }).click();
      await expect(
        page.getByText("one-time-test-credential", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Dismiss credential" }).click();
      await expect(
        page.getByText("one-time-test-credential", { exact: true }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: /All work/ }).click();
      await page
        .getByLabel("Message", { exact: true })
        .fill("Plan a seed library");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page
        .locator(".thread-row")
        .filter({ hasText: "Plan a seed library" })
        .click();
      await page.getByRole("button", { name: "Branches", exact: true }).click();
      await page.getByRole("button", { name: /work\/seed.*Garden/ }).click();
      await expect(page.getByText(commit, { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: "Inspect changes against main" })
        .click();
      await expect(page.getByLabel("Branch diff")).toContainText(
        "+A seed change",
      );
      await page
        .getByLabel("Review notes")
        .fill("Checked the seed handling and tests.");
      await page.getByRole("button", { name: "Record review" }).click();
      await expect(
        page.getByText("Admin · Approved", { exact: true }),
      ).toBeVisible();
      assert.equal(reviewBody.commit, commit);
      assert.equal(reviewBody.target_commit, "b".repeat(40));
      assert.equal(reviewBody.decision, "approved");
      await page
        .getByRole("button", { name: "Request merge into main" })
        .click();
      await expect(
        page.getByRole("alert").filter({ hasText: "Main has moved" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Request merge into main" }),
      ).toBeEnabled();
      await page.route("**/api/branches/1/diff", (route) =>
        route.fulfill({
          json: {
            commit: "c".repeat(40),
            target_commit: "b".repeat(40),
            diff: "+A later seed change",
          },
        }),
      );
      await page.getByRole("button", { name: "Hide changes" }).click();
      await page
        .getByRole("button", { name: "Inspect changes against main" })
        .click();
      await expect(
        page.getByRole("button", { name: "Record review" }),
      ).toBeDisabled();
      await expect(
        page.getByRole("alert").filter({ hasText: "The branch changed" }),
      ).toBeVisible();
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: "test-results/branches-desktop.png" });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({ path: "test-results/branches-mobile.png" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "browser: real repository registration, branch review and explicit merge",
  { timeout: 60000 },
  async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { writeFileSync } = await import("node:fs");
    const run = promisify(execFile);
    const dir = mkdtempSync(join(tmpdir(), "threadwork-real-git-ui-"));
    const upstream = join(dir, "upstream.git");
    const seed = join(dir, "seed");
    const git = async (cwd, ...args) =>
      (
        await run("git", args, {
          cwd,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
          },
        })
      ).stdout.trim();
    await git(dir, "init", "--bare", "--initial-branch=main", upstream);
    await git(dir, "clone", upstream, seed);
    await git(seed, "config", "user.name", "Seed");
    await git(seed, "config", "user.email", "seed@example.test");
    writeFileSync(join(seed, "README.md"), "# Seeds\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "Initial seed");
    await git(seed, "push", "origin", "main");
    const app = createApp({
      dataDir: join(dir, "board"),
      env: { ADMIN_PASSWORD: "real-browser-password" },
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
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function request(path, data) {
      const response = await context.request.post(url + "/api" + path, {
        data,
      });
      assert.equal(response.ok(), true, await response.text());
      return response.json();
    }
    async function signIn(p, username, password) {
      await p.goto(url);
      await p.getByLabel("Username", { exact: true }).fill(username);
      await p.getByLabel("Password", { exact: true }).fill(password);
      await p.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(p.getByRole("heading", { name: /All work/ })).toBeVisible();
    }
    async function openBranch(p) {
      await p.getByRole("button", { name: /All work/ }).click();
      await p
        .locator(".thread-row")
        .filter({ hasText: "Grow actual seeds" })
        .click();
      await p.getByRole("button", { name: "Branches", exact: true }).click();
      await p.getByRole("button", { name: /work\/grow.*Seed project/ }).click();
    }
    try {
      await signIn(page, "admin", "real-browser-password");
      await request("/admin/users", {
        username: "reviewer",
        name: "Reviewer",
        password: "real-reviewer-password",
        admin: false,
      });
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Register repository", exact: true })
        .click();
      await page.getByLabel("Name", { exact: true }).fill("Seed project");
      await page.getByLabel("Git URL", { exact: true }).fill(upstream);
      await page
        .getByRole("button", { name: "Register repository", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Seed project", exact: true }),
      ).toBeVisible();
      const bootstrap = await (
        await context.request.get(url + "/api/bootstrap")
      ).json();
      await request("/threads", {
        channel_id: bootstrap.channels[0].id,
        body: "Grow actual seeds",
        status_id: bootstrap.statuses[0].id,
      });
      await openBranchCreation();
      async function openBranchCreation() {
        await page.getByRole("button", { name: /All work/ }).click();
        await page
          .locator(".thread-row")
          .filter({ hasText: "Grow actual seeds" })
          .click();
        await page
          .getByRole("button", { name: "Branches", exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "Create or register branch",
            exact: true,
          })
          .click();
        await page
          .getByLabel("Repository", { exact: true })
          .selectOption({ label: "Seed project" });
        await page.getByLabel("Branch name", { exact: true }).fill("work/grow");
        await page
          .locator("form")
          .filter({ has: page.getByLabel("Branch name", { exact: true }) })
          .getByRole("button", {
            name: "Create or register branch",
            exact: true,
          })
          .click();
      }
      await expect(
        page.getByRole("heading", { name: "Seed project / work/grow" }),
      ).toBeVisible();
      const credential = await request("/git-credentials", {
        label: "browser-test",
      });
      const auth = `http.extraHeader=Authorization: Basic ${Buffer.from(`admin:${credential.token}`).toString("base64")}`;
      const work = join(dir, "work");
      await git(
        dir,
        "-c",
        auth,
        "clone",
        "--branch",
        "work/grow",
        `${url}/api/git/1.git`,
        work,
      );
      await git(work, "config", "user.name", "Admin");
      await git(work, "config", "user.email", "admin@threadwork.local");
      writeFileSync(join(work, "seeds.txt"), "Grow the seeds carefully.\n");
      await git(work, "add", ".");
      await git(work, "commit", "-m", "Grow seeds");
      await git(work, "-c", auth, "push", "origin", "work/grow");
      const expected = await git(work, "rev-parse", "HEAD");
      const reviewerContext = await browser.newContext();
      const reviewer = await reviewerContext.newPage();
      await signIn(reviewer, "reviewer", "real-reviewer-password");
      await openBranch(reviewer);
      await reviewer
        .getByRole("button", { name: "Inspect changes against main" })
        .click();
      await expect(reviewer.getByLabel("Branch diff")).toContainText(
        "Grow the seeds carefully.",
      );
      await reviewer
        .getByLabel("Review notes")
        .fill("Verified the seed change.");
      await reviewer.getByRole("button", { name: "Record review" }).click();
      await expect(
        reviewer.getByText("Reviewer · Approved", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Refresh branches", exact: true })
        .click();
      await expect(
        page.getByText("Reviewer · Approved", { exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Request merge into main" })
        .click();
      await expect(
        page.getByRole("button", { name: "Request merge into main" }),
      ).toHaveCount(0);
      await expect(
        page
          .getByText("Owner:", { exact: false })
          .filter({ hasText: "merged" }),
      ).toBeVisible();
      assert.equal(await git(upstream, "rev-parse", "main"), expected);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
