import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync, execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
  parseTokens,
  resolveWorkers,
  composeFleet,
  writeFleet,
} from "../scripts/workers.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const serverUrl = "http://127.0.0.1:8082";
const secretA = "fixture-fleet-secret-alpha";
const secretB = "fixture-fleet-secret-bravo";
const options = {
  serverUrl,
  project: "fixture-fleet",
  repoRoot,
  stateDir: "/tmp/threadwork-fixture-fleet",
};

function withoutSecrets(error, secrets = [secretA, secretB]) {
  for (const secret of secrets)
    assert.ok(
      !String(error).includes(secret),
      "Errors must not disclose agent credentials",
    );
  return true;
}

test("fleet token files trim lines and comments while rejecting ambiguous or duplicate credentials", () => {
  assert.deepEqual(
    parseTokens(
      `\n# Agents\r\n  ${secretA}  \r\n\n   # Other agent\n${secretB}\n`,
    ),
    [secretA, secretB],
  );
  for (const text of [
    `${secretA}\n${secretA}`,
    `${secretA} ${secretB}`,
    `${secretA}\t${secretB}`,
  ]) {
    assert.throws(() => parseTokens(text), withoutSecrets);
  }
});

test("fleet preflight authenticates each credential and resolves stable agent identity", async () => {
  const calls = [];
  const workers = await resolveWorkers([secretA, secretB], {
    serverUrl: serverUrl + "/",
    fetchImpl: async (url, init) => {
      const credential = new Headers(init.headers).get("Authorization");
      calls.push({ url: String(url), credential });
      return Response.json({
        id: credential === `Bearer ${secretA}` ? 41 : 52,
        kind: "agent",
        username: credential === `Bearer ${secretA}` ? "spark" : "sage",
      });
    },
  });
  assert.deepEqual(workers, [
    { id: 41, username: "spark", token: secretA },
    { id: 52, username: "sage", token: secretB },
  ]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.url, serverUrl + "/api/me");
  assert.deepEqual(
    calls.map((call) => call.credential).sort(),
    [`Bearer ${secretA}`, `Bearer ${secretB}`].sort(),
  );
});

test("fleet preflight rejects human accounts, invalid IDs and two tokens for the same agent without leaking credentials", async () => {
  for (const body of [
    { id: 1, kind: "human", username: "admin" },
    { id: 0, kind: "agent", username: "bad" },
    { id: 1.5, kind: "agent", username: "bad" },
    { id: -1, kind: "agent", username: "bad" },
  ]) {
    await assert.rejects(
      resolveWorkers([secretA], {
        serverUrl,
        fetchImpl: async () => Response.json(body),
      }),
      withoutSecrets,
    );
  }
  await assert.rejects(
    resolveWorkers([secretA, secretB], {
      serverUrl,
      fetchImpl: async () =>
        Response.json({ id: 41, kind: "agent", username: "spark" }),
    }),
    withoutSecrets,
  );
});

test("fleet preflight hides upstream error bodies and transport credentials", async () => {
  for (const fetchImpl of [
    async () =>
      Response.json(
        { error: `Incorrect credential ${secretA}` },
        { status: 401 },
      ),
    async () => {
      throw new Error(`Request containing ${secretA} failed`);
    },
  ]) {
    await assert.rejects(
      resolveWorkers([secretA], { serverUrl, fetchImpl }),
      withoutSecrets,
    );
  }
});

function stateVolume(config, agentId) {
  const service = config.services[`agent-${agentId}`];
  assert.ok(service, "Each service uses the authenticated agent ID");
  const mount = service.volumes.find((value) =>
    typeof value === "string"
      ? value.endsWith(":/state")
      : value.target === "/state",
  );
  assert.ok(mount, "Each agent needs persistent state at /state");
  const source = typeof mount === "string" ? mount.split(":")[0] : mount.source;
  assert.ok(
    config.volumes[source],
    "Inherited mounts must declare their own named volumes",
  );
  return config.volumes[source].name;
}

test("fleet configuration keeps isolated named state stable across line reordering, renaming and token rotation", () => {
  const first = composeFleet(
    [
      { id: 41, username: "spark", token: secretA },
      { id: 52, username: "sage", token: secretB },
    ],
    options,
  );
  const rotated = composeFleet(
    [
      { id: 52, username: "sage-renamed", token: "rotated-bravo-secret" },
      { id: 41, username: "spark-renamed", token: "rotated-alpha-secret" },
    ],
    options,
  );
  assert.deepEqual(Object.keys(first.services).sort(), [
    "agent-41",
    "agent-52",
  ]);
  assert.notEqual(stateVolume(first, 41), stateVolume(first, 52));
  assert.equal(stateVolume(first, 41), stateVolume(rotated, 41));
  assert.equal(stateVolume(first, 52), stateVolume(rotated, 52));
  assert.match(stateVolume(first, 41), /fixture-fleet.*41/);
  for (const service of Object.values(first.services)) {
    assert.equal(service.extends.service, "agent");
    assert.equal(
      resolve(service.extends.file),
      resolve(repoRoot, "compose.worker-base.yaml"),
    );
  }
});

test("fleet files are private, token-bearing config is not metadata, and state cannot switch boards", () => {
  const root = mkdtempSync(join(tmpdir(), "threadwork-fleet-private-"));
  const stateDir = join(root, "private");
  try {
    const config = composeFleet(
      [{ id: 41, username: "spark", token: secretA }],
      { ...options, stateDir },
    );
    const file = writeFleet(config, { stateDir, serverUrl });
    assert.equal(resolve(file), file);
    assert.equal(statSync(stateDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(stateDir, "fleet.json")).mode & 0o777, 0o600);
    assert.ok(
      !readFileSync(join(stateDir, "fleet.json"), "utf8").includes(secretA),
    );
    assert.throws(
      () =>
        writeFleet(config, {
          stateDir,
          serverUrl: "http://different-board.invalid:8082",
        }),
      withoutSecrets,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Docker Compose resolves shared worker defaults, isolated volumes and literal dollar credentials without starting containers", (t) => {
  const version = spawnSync("docker", ["compose", "version"], {
    encoding: "utf8",
  });
  if (version.error || version.status !== 0)
    return t.skip("Docker Compose is unavailable");
  const stateDir = mkdtempSync(join(tmpdir(), "threadwork-fleet-config-"));
  const dollarToken = "fixture-$FLEET_TEST_SECRET-$$-token";
  const apiKey = "fixture-$FLEET_TEST_SECRET-$$-api";
  try {
    const config = composeFleet(
      [
        { id: 41, username: "spark", token: dollarToken },
        { id: 52, username: "sage", token: secretB },
      ],
      { ...options, stateDir, env: { OPENAI_API_KEY: apiKey } },
    );
    const file = writeFleet(config, { stateDir, serverUrl });
    const result = spawnSync(
      "docker",
      ["compose", "-f", file, "config", "--format", "json"],
      {
        cwd: stateDir,
        encoding: "utf8",
        env: {
          ...process.env,
          FLEET_TEST_SECRET: "THIS_MUST_NOT_REPLACE_CREDENTIAL_CONTENT",
          OPENAI_API_KEY: "",
          AGENT_TOKEN: "",
          THREADWORK_URL: "",
        },
      },
    );
    assert.equal(
      result.status,
      0,
      "Generated Compose file must resolve without external worker credentials",
    );
    const rendered = JSON.parse(result.stdout);
    const spark = rendered.services["agent-41"];
    const sage = rendered.services["agent-52"];
    // Compose serializes literal dollars as $$ so this config can round-trip safely.
    assert.equal(
      spark.environment.AGENT_TOKEN,
      dollarToken.replaceAll("$", () => "$$"),
    );
    assert.equal(sage.environment.AGENT_TOKEN, secretB);
    assert.equal(
      spark.environment.OPENAI_API_KEY,
      apiKey.replaceAll("$", () => "$$"),
    );
    assert.equal(
      spark.environment.THREADWORK_URL,
      "http://host.docker.internal:8082",
    );
    assert.equal(spark.read_only, true);
    assert.equal(spark.init, true);
    assert.equal(spark.restart, "unless-stopped");
    assert.equal(spark.build.context, repoRoot);
    assert.ok(spark.volumes.some((mount) => mount.target === "/state"));
    assert.notEqual(
      spark.volumes.find((mount) => mount.target === "/state").source,
      sage.volumes.find((mount) => mount.target === "/state").source,
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("fleet plan CLI resolves accounts and writes private config without printing tokens or starting workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "threadwork-fleet-plan-"));
  const tokenFile = join(root, "tokens.txt");
  const stateDir = join(root, "state");
  writeFileSync(tokenFile, `${secretA}\n${secretB}\n`, { mode: 0o600 });
  const calls = [];
  const server = createServer((req, res) => {
    calls.push(req.url);
    const token = req.headers.authorization;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: token === `Bearer ${secretA}` ? 41 : 52,
        kind: "agent",
        username: token === `Bearer ${secretA}` ? "spark" : "sage",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [
        resolve(repoRoot, "scripts/workers.mjs"),
        "plan",
        "--tokens",
        tokenFile,
        "--server",
        `http://127.0.0.1:${server.address().port}`,
        "--project",
        "fixture-fleet-plan",
        "--state-dir",
        stateDir,
      ],
      { cwd: root, timeout: 10000 },
    );
    for (const secret of [secretA, secretB])
      assert.ok(!(result.stdout + result.stderr).includes(secret));
    assert.match(result.stdout, /spark/);
    assert.match(result.stdout, /sage/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => url === "/api/me"));
    assert.equal(statSync(join(stateDir, "compose.json")).mode & 0o777, 0o600);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("fleet lifecycle commands use saved project identity without tokens or server access", async () => {
  const root = mkdtempSync(join(tmpdir(), "threadwork-fleet-lifecycle-"));
  const stateDir = join(root, "state");
  const project = "fixture-fleet-saved";
  const callsFile = join(root, "docker-calls.jsonl");
  const docker = join(root, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
    { mode: 0o700 },
  );
  try {
    const config = composeFleet(
      [{ id: 41, username: "spark", token: secretA }],
      { ...options, project, stateDir },
    );
    writeFleet(config, { stateDir, serverUrl });
    for (const command of ["status", "stop", "down", "logs"]) {
      const result = await promisify(execFile)(
        process.execPath,
        [
          resolve(repoRoot, "scripts/workers.mjs"),
          command,
          "--state-dir",
          stateDir,
        ],
        {
          cwd: root,
          timeout: 10000,
          env: { ...process.env, PATH: root + ":" + process.env.PATH },
        },
      );
      assert.ok(!(result.stdout + result.stderr).includes(secretA));
    }
    const calls = readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      calls.length,
      12,
      "Each lifecycle operation checks project ownership, validates privately, then invokes Compose",
    );
    for (const args of calls.filter((args) => args[0] === "compose")) {
      assert.equal(args[args.indexOf("-p") + 1], project);
      assert.equal(
        args[args.indexOf("-f") + 1],
        join(stateDir, "compose.json"),
      );
      assert.ok(!args.includes(secretA));
    }
    assert.ok(calls.some((args) => args.includes("ps")));
    assert.ok(calls.some((args) => args.includes("stop")));
    assert.ok(calls.some((args) => args.includes("down")));
    assert.ok(calls.some((args) => args.includes("logs")));
    assert.ok(
      !calls.some((args) => args.includes("--volumes")),
      "Down preserves agent sessions and workspaces",
    );
    writeFileSync(
      docker,
      `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconsole.log('unrelated-container ');\n`,
      { mode: 0o700 },
    );
    await assert.rejects(
      () =>
        promisify(execFile)(
          process.execPath,
          [
            resolve(repoRoot, "scripts/workers.mjs"),
            "down",
            "--state-dir",
            stateDir,
          ],
          {
            cwd: root,
            timeout: 10000,
            env: { ...process.env, PATH: root + ":" + process.env.PATH },
          },
        ),
      (error) => {
        assert.match(error.stderr, /containers managed elsewhere/);
        assert.ok(!(error.stdout + error.stderr).includes(secretA));
        return true;
      },
    );
    const afterCollision = readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      afterCollision.length,
      calls.length + 1,
      "Project collision is rejected before any Compose mutation",
    );
    assert.equal(afterCollision.at(-1)[0], "ps");
    writeFileSync(
      join(stateDir, "compose.json"),
      `{ "AGENT_TOKEN": "${secretA}" broken`,
    );
    await assert.rejects(
      () =>
        promisify(execFile)(
          process.execPath,
          [
            resolve(repoRoot, "scripts/workers.mjs"),
            "status",
            "--state-dir",
            stateDir,
          ],
          {
            cwd: root,
            timeout: 10000,
            env: { ...process.env, PATH: root + ":" + process.env.PATH },
          },
        ),
      (error) => {
        assert.match(error.stderr, /Saved fleet configuration is unreadable/);
        assert.ok(!(error.stdout + error.stderr).includes(secretA));
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fleet adopts explicit volumes without treating similar default prefixes as disposable new state", () => {
  const config = composeFleet([{ id: 41, username: "spark", token: secretA }], {
    ...options,
    volumeOverrides: { 41: "fixture-fleet_agent_41_backup" },
  });
  assert.equal(
    config.volumes["state-41"].name,
    "fixture-fleet_agent_41_backup",
  );
  assert.equal(config.volumes["state-41"].external, true);
  assert.throws(
    () =>
      composeFleet(
        [
          { id: 41, username: "spark", token: secretA },
          { id: 52, username: "sage", token: secretB },
        ],
        {
          ...options,
          volumeOverrides: { 41: "shared-volume", 52: "shared-volume" },
        },
      ),
    withoutSecrets,
  );
});

test("fleet retains removed agents' state mappings and rejects silent workspace replacement", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "threadwork-fleet-mapping-"));
  try {
    const both = [
      { id: 41, username: "spark", token: secretA },
      { id: 52, username: "sage", token: secretB },
    ];
    const first = composeFleet(both, {
      ...options,
      stateDir,
      volumeOverrides: { 41: "existing-spark-workspace" },
    });
    writeFleet(first, { stateDir, serverUrl });
    writeFleet(composeFleet([both[1]], { ...options, stateDir }), {
      stateDir,
      serverUrl,
    });
    const metadata = JSON.parse(
      readFileSync(join(stateDir, "fleet.json"), "utf8"),
    );
    assert.equal(metadata.volumes["state-41"], "existing-spark-workspace");
    const replacement = composeFleet(both, { ...options, stateDir });
    assert.throws(
      () => writeFleet(replacement, { stateDir, serverUrl }),
      withoutSecrets,
    );
    assert.equal(
      JSON.parse(readFileSync(join(stateDir, "fleet.json"), "utf8")).volumes[
        "state-41"
      ],
      "existing-spark-workspace",
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
