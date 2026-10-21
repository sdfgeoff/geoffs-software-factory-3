import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createApp } from "../server/app.mjs";

test(
  "browser: saved encrypted tokens are write-only, selectable, rotatable and restricted to admins",
  { timeout: 60000 },
  async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "threadwork-credential-browser-"),
    );
    const remote = join(directory, "upstream.git"),
      seed = join(directory, "seed");
    const execute = promisify(execFile);
    const git = async (cwd, ...args) =>
      (
        await execute("git", args, {
          cwd,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
        })
      ).stdout.trim();
    await git(directory, "init", "--bare", "--initial-branch=main", remote);
    await git(directory, "clone", remote, seed);
    await git(seed, "config", "user.name", "Fixture");
    await git(seed, "config", "user.email", "fixture@example.test");
    writeFileSync(join(seed, "README.md"), "Initial\n");
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "Initial");
    await git(seed, "push", "origin", "main");
    const originalSecret = "fake-browser-token-first",
      rotatedSecret = "fake-browser-token-rotated";
    let githubCalls = 0,
      pullRequest;
    const githubFetch = async (input, options) => {
      assert.equal(new URL(input).origin, "https://api.github.com");
      assert.equal(options.headers.Authorization, `Bearer ${rotatedSecret}`);
      githubCalls++;
      if (
        new URL(input).pathname.endsWith("/pulls") &&
        options.method === "GET"
      )
        return Response.json(pullRequest ? [pullRequest] : []);
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        pullRequest = {
          number: 7,
          html_url: "https://github.com/example/project/pull/7",
          state: "open",
          merged: false,
          merge_commit_sha: null,
          body: body.body,
          head: {
            ref: body.head,
            sha: await git(remote, "rev-parse", body.head),
            repo: { full_name: "example/project", owner: { login: "example" } },
          },
          base: {
            ref: body.base,
            sha: await git(remote, "rev-parse", body.base),
            repo: { full_name: "example/project" },
          },
        };
        return Response.json(pullRequest, { status: 201 });
      }
      return Response.json(pullRequest);
    };
    const app = createApp({
      dataDir: join(directory, "board"),
      env: {
        ADMIN_PASSWORD: "credential-browser-admin",
        AGENT_SPARK_TOKEN: "credential-browser-reviewer",
      },
      githubFetch,
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
      }),
      page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const request = async (path, method = "GET", data, headers) => {
      const response = await context.request.fetch(url + "/api" + path, {
        method,
        ...(data ? { data } : {}),
        ...(headers ? { headers } : {}),
      });
      assert.ok(response.ok(), await response.text());
      return response.json();
    };
    const tokenRow = (name) =>
      page
        .locator(".repository-token-row")
        .filter({ has: page.getByText(name, { exact: true }) });
    try {
      await page.goto(url);
      await page.getByLabel("Username", { exact: true }).fill("admin");
      await page
        .getByLabel("Password", { exact: true })
        .fill("credential-browser-admin");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      const panel = page.getByRole("region", {
        name: "Saved repository tokens",
        exact: true,
      });
      await panel
        .getByRole("button", { name: "Add repository token", exact: true })
        .click();
      await panel
        .getByLabel("Token name", { exact: true })
        .fill("Shared GitHub");
      await panel
        .getByLabel("Token value", { exact: true })
        .fill(originalSecret);
      await panel
        .getByRole("button", { name: "Save repository token", exact: true })
        .click();
      await expect(tokenRow("Shared GitHub")).toBeVisible();
      let metadata = await request("/admin/repository-credentials");
      assert.equal(metadata.length, 1);
      assert.deepEqual(Object.keys(metadata[0]).sort(), [
        "created_at",
        "id",
        "name",
        "updated_at",
      ]);
      assert.ok(!JSON.stringify(metadata).includes(originalSecret));
      await expect(panel).not.toContainText(originalSecret);
      await expect(
        panel.getByLabel("Token value", { exact: true }),
      ).toHaveCount(0);
      const selectedId = metadata[0].id;
      await tokenRow("Shared GitHub")
        .getByRole("button", { name: "Rename or replace", exact: true })
        .click();
      await expect(
        panel.getByLabel("Replacement token value", { exact: true }),
      ).toHaveValue("");
      await panel
        .getByLabel("Replacement token value", { exact: true })
        .fill(rotatedSecret);
      await panel
        .getByRole("button", { name: "Save token changes", exact: true })
        .click();
      await expect(
        panel.getByLabel("Replacement token value", { exact: true }),
      ).toHaveCount(0);
      metadata = await request("/admin/repository-credentials");
      assert.ok(!JSON.stringify(metadata).includes(rotatedSecret));
      const repo = await request("/repositories", "POST", {
        name: "Saved credential repository",
        url: remote,
      });
      // Only Git's transport is local; policy validation and the injected GitHub adapter use its real GitHub identity.
      app.locals.db
        .prepare("UPDATE repositories SET url=? WHERE id=?")
        .run("git@github.com:example/project.git", repo.id);
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const card = page.locator(".orchestration-card").filter({
        has: page.getByRole("heading", {
          name: "Saved credential repository",
          exact: true,
        }),
      });
      await card
        .getByLabel("Merge mode", { exact: true })
        .selectOption("pull_request");
      await card.getByLabel("GitHub owner", { exact: true }).fill("example");
      await card
        .getByLabel("GitHub repository", { exact: true })
        .fill("project");
      await card
        .getByLabel("GitHub token", { exact: true })
        .selectOption(String(selectedId));
      await card
        .getByRole("button", { name: "Save approval policy", exact: true })
        .click();
      await expect(card).toContainText("GitHub pull request · example/project");
      const savedRepo = (await request("/repositories"))[0];
      assert.equal(savedRepo.github_credential_id, selectedId);
      assert.equal(savedRepo.github_token_configured, true);
      assert.ok(!JSON.stringify(savedRepo).includes(rotatedSecret));
      await tokenRow("Shared GitHub")
        .getByRole("button", { name: "Delete token", exact: true })
        .click();
      await expect(tokenRow("Shared GitHub").getByRole("alert")).toContainText(
        /used by a repository/,
      );
      await card
        .getByRole("button", { name: "Add github token", exact: true })
        .click();
      await card
        .getByLabel("New github token name", { exact: true })
        .fill("Inline unused");
      await card
        .getByLabel("New github token value", { exact: true })
        .fill("fake-inline-token");
      await card
        .getByRole("button", { name: "Save github token", exact: true })
        .click();
      await expect(tokenRow("Inline unused")).toBeVisible();
      const inline = (await request("/admin/repository-credentials")).find(
        (entry) => entry.name === "Inline unused",
      );
      await expect(
        card.getByLabel("GitHub token", { exact: true }),
      ).toHaveValue(String(inline.id));
      await expect(
        card.getByLabel("New github token value", { exact: true }),
      ).toHaveCount(0);
      await card
        .getByLabel("GitHub token", { exact: true })
        .selectOption(String(selectedId));
      await tokenRow("Inline unused")
        .getByRole("button", { name: "Delete token", exact: true })
        .click();
      await expect(tokenRow("Inline unused")).toHaveCount(0);
      app.locals.db
        .prepare("UPDATE repositories SET url=? WHERE id=?")
        .run(remote, repo.id);
      const thread = await request("/threads", "POST", {
        channel_id: 1,
        title: "Publish using saved credentials",
        body: "A local integration fixture.",
      });
      const branch = await request(
        `/repositories/${repo.id}/branches`,
        "POST",
        { name: "work/saved-token", thread_ids: [thread.id] },
      );
      const gitCredential = await request("/git-credentials", "POST", {
        label: "browser fixture",
      });
      const authorization = `http.extraHeader=Authorization: Basic ${Buffer.from(`admin:${gitCredential.token}`).toString("base64")}`;
      const work = join(directory, "work");
      await git(
        directory,
        "-c",
        authorization,
        "clone",
        "--branch",
        branch.name,
        `${url}/api/git/${repo.id}.git`,
        work,
      );
      await git(work, "config", "user.name", "Admin");
      await git(work, "config", "user.email", "admin@threadwork.local");
      writeFileSync(
        join(work, "saved-token.txt"),
        "Vault publication fixture\n",
      );
      await git(work, "add", ".");
      await git(work, "commit", "-m", "Use saved token");
      await git(work, "-c", authorization, "push", "origin", branch.name);
      const head = await git(work, "rev-parse", "HEAD");
      const spark = app.locals.db
        .prepare("SELECT id FROM users WHERE username='spark'")
        .get().id;
      await request(`/users/${spark}/capabilities`, "POST", {
        can_work: true,
        can_review: true,
      });
      await request(
        `/branches/${branch.id}/reviews`,
        "POST",
        { commit: head, decision: "approved", body: "Verified." },
        { Authorization: "Bearer credential-browser-reviewer" },
      );
      await page.getByRole("button", { name: /All work/ }).click();
      await page
        .locator(".thread-row")
        .filter({ hasText: "Publish using saved credentials" })
        .click();
      await page.getByRole("button", { name: "Branches", exact: true }).click();
      await page.getByRole("button", { name: /work\/saved-token/ }).click();
      await page
        .getByRole("button", { name: "Open/update pull request", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: /View on GitHub/ }),
      ).toHaveAttribute("href", "https://github.com/example/project/pull/7");
      assert.ok(
        githubCalls >= 2,
        "Real publication decrypts rotated DB credential for the fake GitHub adapter",
      );
      await request("/admin/users", "POST", {
        username: "member",
        name: "Member",
        password: "credential-browser-member",
        admin: false,
      });
      const member = await browser.newContext();
      await member.request.post(url + "/api/login", {
        data: { username: "member", password: "credential-browser-member" },
      });
      for (const [method, path, data] of [
        ["GET", "/admin/repository-credentials"],
        [
          "POST",
          "/admin/repository-credentials",
          { name: "Forbidden", value: "forbidden-value" },
        ],
        [
          "PATCH",
          `/admin/repository-credentials/${selectedId}`,
          { value: "forbidden-change" },
        ],
        ["DELETE", `/admin/repository-credentials/${selectedId}`],
      ])
        assert.equal(
          (
            await member.request.fetch(url + "/api" + path, {
              method,
              ...(data ? { data } : {}),
            })
          ).status(),
          403,
        );
      assert.equal(
        (
          await context.request.get(url + "/api/admin/repository-credentials", {
            headers: { Authorization: "Bearer credential-browser-reviewer" },
          })
        ).status(),
        403,
      );
      const memberPage = await member.newPage();
      await memberPage.goto(url);
      await memberPage
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      await expect(
        memberPage.getByRole("heading", { name: "Repositories", exact: true }),
      ).toBeVisible();
      await expect(
        memberPage.getByRole("region", {
          name: "Saved repository tokens",
          exact: true,
        }),
      ).toHaveCount(0);
      await expect(
        memberPage.getByLabel("GitHub token", { exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Close thread", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Repositories", exact: true })
        .click();
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({ path: "test-results/repository-tokens.png" });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await new Promise((r) => server.close(r));
      app.locals.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
