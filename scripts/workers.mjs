import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const literal = (value) => String(value).replaceAll("$", () => "$$");
export function parseTokens(text) {
  const tokens = [];
  for (const [index, raw] of text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .entries()) {
    const token = raw.trim();
    if (!token || token.startsWith("#")) continue;
    if (/\s|[\x00-\x1f\x7f]/.test(token) || token.length > 4096)
      throw new Error(
        `Invalid token on line ${index + 1}; use one server token per line.`,
      );
    if (tokens.includes(token))
      throw new Error(`Duplicate token on line ${index + 1}.`);
    tokens.push(token);
  }
  if (!tokens.length)
    throw new Error("The token file contains no worker tokens.");
  return tokens;
}
export function normalizeServer(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error("Use an HTTP or HTTPS board server URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Use an HTTP or HTTPS board URL without credentials, query, or fragment.",
    );
  return url.href.replace(/\/+$/, "");
}
export async function resolveWorkers(tokens, { serverUrl, fetchImpl = fetch }) {
  const server = normalizeServer(serverUrl);
  const workers = [];
  // Bound concurrent authentication requests; errors never include bodies or tokens.
  for (let offset = 0; offset < tokens.length; offset += 8) {
    const group = await Promise.all(
      tokens.slice(offset, offset + 8).map(async (token, i) => {
        const index = offset + i + 1;
        let user;
        try {
          const response = await fetchImpl(`${server}/api/me`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok) throw new Error();
          user = await response.json();
        } catch {
          throw new Error(
            `Could not authenticate worker token ${index}; check the server URL and token.`,
          );
        }
        if (
          user?.kind !== "agent" ||
          !Number.isSafeInteger(user.id) ||
          user.id < 1 ||
          typeof user.username !== "string" ||
          !/^[a-z][a-z0-9_-]{1,39}$/.test(user.username)
        )
          throw new Error(
            `Token ${index} must identify a board agent account.`,
          );
        return { id: user.id, username: user.username, token };
      }),
    );
    for (const worker of group) {
      if (workers.some((existing) => existing.id === worker.id))
        throw new Error(
          `More than one token identifies agent ${worker.id}; use one worker per agent.`,
        );
      workers.push(worker);
    }
  }
  return workers;
}
export function composeFleet(
  workers,
  {
    serverUrl,
    project,
    repoRoot: root = repoRoot,
    env = {},
    volumeOverrides = {},
  },
) {
  if (!projectPattern.test(project))
    throw new Error(
      "Project names must use lowercase letters, digits, underscores, or hyphens.",
    );
  const containerUrl = new URL(normalizeServer(serverUrl));
  if (["localhost", "127.0.0.1", "[::1]"].includes(containerUrl.hostname))
    containerUrl.hostname = "host.docker.internal";
  const services = {},
    volumes = {};
  for (const worker of [...workers].sort((a, b) => a.id - b.id)) {
    if (
      !Number.isSafeInteger(worker.id) ||
      worker.id < 1 ||
      services[`agent-${worker.id}`]
    )
      throw new Error("Worker identities must be unique positive integers.");
    const state = `state-${worker.id}`;
    volumes[state] = {
      name: volumeOverrides[worker.id] || `${project}_agent_${worker.id}`,
    };
    if (volumeOverrides[worker.id]) volumes[state].external = true;
    else
      volumes[state].labels = {
        "com.threadwork.server": createHash("sha256")
          .update(normalizeServer(serverUrl))
          .digest("hex"),
        "com.threadwork.agent": String(worker.id),
      };
    services[`agent-${worker.id}`] = {
      extends: {
        file: join(root, "compose.worker-base.yaml"),
        service: "agent",
      },
      build: { context: root, dockerfile: "docker/Dockerfile.agent" },
      environment: {
        THREADWORK_URL: literal(containerUrl.href.replace(/\/+$/, "")),
        AGENT_TOKEN: literal(worker.token),
        OPENAI_API_KEY: literal(env.OPENAI_API_KEY || ""),
        AGENT_ACTIVITY: literal(env.AGENT_ACTIVITY || "true"),
        AGENT_ACTIVITY_STDOUT: literal(env.AGENT_ACTIVITY_STDOUT || "true"),
      },
      labels: {
        "com.threadwork.fleet": createHash("sha256")
          .update(normalizeServer(serverUrl))
          .digest("hex"),
      },
      extra_hosts: ["host.docker.internal:host-gateway"],
      volumes: [`${state}:/state`],
    };
  }
  if (!Object.keys(services).length)
    throw new Error("The fleet must contain at least one worker.");
  const names = Object.values(volumes).map((volume) => volume.name);
  if (new Set(names).size !== names.length)
    throw new Error("Each agent must have a separate state volume.");
  return { name: project, services, volumes };
}
function readPrivate(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(
      "Saved fleet configuration is unreadable; restore its backup or repair the private file.",
    );
  }
}
function privateWrite(path, value) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(path + ".tmp", 0o600);
  renameSync(path + ".tmp", path);
}
export function writeFleet(config, { stateDir, serverUrl }) {
  stateDir = resolve(stateDir);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  chmodSync(stateDir, 0o700);
  const identityFile = join(stateDir, "fleet.json");
  const server = normalizeServer(serverUrl);
  if (existsSync(identityFile)) {
    const previous = readPrivate(identityFile);
    if (previous.server !== server || previous.project !== config.name)
      throw new Error(
        "This fleet state belongs to a different server/project. Reuse its original URL or choose a different project and state directory.",
      );
    // Moving an existing agent onto another volume silently loses its workspace.
    for (const [key, volume] of Object.entries(config.volumes)) {
      if (previous.volumes?.[key] && previous.volumes[key] !== volume.name)
        throw new Error(
          `State volume for ${key} changed; restore the original mapping instead of replacing the agent workspace.`,
        );
    }
  }
  const previous = existsSync(identityFile) ? readPrivate(identityFile) : {};
  privateWrite(identityFile, {
    server,
    project: config.name,
    volumes: {
      ...previous.volumes,
      ...Object.fromEntries(
        Object.entries(config.volumes).map(([key, value]) => [key, value.name]),
      ),
    },
    external: {
      ...previous.external,
      ...Object.fromEntries(
        Object.entries(config.volumes).map(([key, value]) => [
          key,
          !!value.external,
        ]),
      ),
    },
  });
  const path = join(stateDir, "compose.json");
  privateWrite(path, config);
  return path;
}
function run(command, args, { capture = false, env = process.env } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.resume();
    }
    child.on("error", () =>
      reject(
        new Error(
          "Docker Compose could not be started. Install Docker with Compose.",
        ),
      ),
    );
    child.on("close", (code) =>
      code === 0
        ? resolvePromise(output)
        : reject(
            new Error(`Docker command failed (exit ${code ?? "signal"}).`),
          ),
    );
  });
}
async function checkVolumes(config) {
  for (const [state, volume] of Object.entries(config.volumes)) {
    const service = state.replace("state-", "agent-");
    const output = await run(
      "docker",
      [
        "ps",
        "--filter",
        `volume=${volume.name}`,
        "--format",
        '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}',
      ],
      { capture: true },
    );
    if (
      output
        .trim()
        .split("\n")
        .some((line) => line && line !== `${config.name}\t${service}`)
    )
      throw new Error(
        `State volume for ${service} is in use by another container; stop that worker before migrating it.`,
      );
    if (volume.external)
      await run("docker", ["volume", "inspect", volume.name], {
        capture: true,
      });
    else {
      const labels = await run(
        "docker",
        ["volume", "inspect", volume.name, "--format", "{{json .Labels}}"],
        { capture: true },
      ).catch(() => null);
      if (labels) {
        const actual = JSON.parse(labels) || {};
        if (
          actual["com.threadwork.server"] !==
            volume.labels["com.threadwork.server"] ||
          actual["com.threadwork.agent"] !==
            volume.labels["com.threadwork.agent"]
        )
          throw new Error(
            `State volume for ${service} belongs to another fleet/server. Choose a unique project or explicitly adopt the correct existing volume.`,
          );
      }
    }
  }
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      tokens: { type: "string" },
      server: { type: "string" },
      project: { type: "string" },
      "state-dir": { type: "string" },
      volume: { type: "string", multiple: true },
      "no-build": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0] || "up";
  if (values.help) {
    console.log(
      "Usage: npm run workers -- <up|plan|stop|down|status|logs> [--tokens FILE] [--server URL] [--project NAME] [--state-dir DIR] [--volume ID=EXISTING_VOLUME] [--no-build]\nDefaults: data/workers/tokens.txt; http://localhost:8082; project threadwork-fleet.\nup reconciles the token list (removes omitted containers, preserves all volumes).\nOther commands use the saved fleet and work without tokens or the server.\nSign each agent into Codex in the board's admin panel after starting it.",
    );
    return;
  }
  if (
    positionals.length > 1 ||
    !["up", "plan", "stop", "down", "status", "logs"].includes(command)
  )
    throw new Error(
      "Choose up, plan, stop, down, status, or logs. Use --help for options.",
    );
  const selectedStateDir = values["state-dir"]
    ? resolve(values["state-dir"])
    : null;
  const savedIdentity =
    selectedStateDir && existsSync(join(selectedStateDir, "fleet.json"))
      ? readPrivate(join(selectedStateDir, "fleet.json"))
      : {};
  if (
    savedIdentity.project &&
    values.project &&
    savedIdentity.project !== values.project
  )
    throw new Error(
      "This fleet state belongs to a different project. Use its saved project name or a different state directory.",
    );
  values.project ||= savedIdentity.project || "threadwork-fleet";
  if (!projectPattern.test(values.project))
    throw new Error("Invalid fleet project name.");
  const stateDir =
    selectedStateDir ||
    resolve(join(repoRoot, "data", "worker-fleets", values.project));
  let configPath = join(stateDir, "compose.json");
  if (["up", "plan"].includes(command)) {
    const tokens = parseTokens(
      readFileSync(
        resolve(
          values.tokens || join(repoRoot, "data", "workers", "tokens.txt"),
        ),
        "utf8",
      ),
    );
    const metadata = existsSync(join(stateDir, "fleet.json"))
      ? readPrivate(join(stateDir, "fleet.json"))
      : {};
    const serverUrl =
      values.server ||
      metadata.server ||
      process.env.THREADWORK_URL ||
      `http://localhost:${process.env.WEB_PORT || 8082}`;
    const workers = await resolveWorkers(tokens, { serverUrl });
    const volumeOverrides = {};
    for (const [key, name] of Object.entries(metadata.volumes || {}))
      if (metadata.external?.[key])
        volumeOverrides[key.replace(/^state-/, "")] = name;
    for (const override of values.volume || []) {
      const match = override.match(/^([1-9]\d*)=([a-zA-Z0-9][a-zA-Z0-9_.-]*)$/);
      if (!match || !workers.some((worker) => worker.id === Number(match[1])))
        throw new Error(
          "Volume overrides must use ID=EXISTING_VOLUME for an agent in this fleet.",
        );
      volumeOverrides[match[1]] = match[2];
    }
    const config = composeFleet(workers, {
      serverUrl,
      project: values.project,
      repoRoot,
      env: process.env,
      volumeOverrides,
    });
    configPath = writeFleet(config, { stateDir, serverUrl });
    console.log(
      `Fleet ${values.project}: ${workers.map((worker) => `@${worker.username} (agent-${worker.id})`).join(", ")}`,
    );
    if (command === "plan") {
      console.log(
        "Private Compose configuration saved. No containers were started.",
      );
      return;
    }
    await checkVolumes(config);
  } else if (!existsSync(configPath))
    throw new Error("No saved fleet configuration. Run plan or up first.");
  // Orphan reconciliation/down must never target an unrelated Compose project.
  const storedConfig = readPrivate(configPath);
  const owner = Object.values(storedConfig.services)[0]?.labels?.[
    "com.threadwork.fleet"
  ];
  const occupants = await run(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${values.project}`,
      "--format",
      '{{.ID}} {{.Label "com.threadwork.fleet"}}',
    ],
    { capture: true },
  );
  if (
    !owner ||
    occupants
      .trim()
      .split("\n")
      .some((line) => line && line.split(" ")[1] !== owner)
  )
    throw new Error(
      "This Compose project contains containers managed elsewhere. Choose a separate fleet project; no containers were changed.",
    );
  // Validate privately: Compose config output contains secrets and must not be printed.
  const composeArgs = [
    "compose",
    "--project-directory",
    repoRoot,
    "-p",
    values.project,
    "-f",
    configPath,
  ];
  await run("docker", [...composeArgs, "config", "--quiet"], { capture: true });
  const operation =
    command === "up"
      ? [
          "up",
          "-d",
          "--remove-orphans",
          ...(values["no-build"] ? ["--no-build"] : ["--build"]),
        ]
      : command === "status"
        ? ["ps"]
        : command === "logs"
          ? ["logs", "--follow", "--tail", "100"]
          : [command];
  await run("docker", [...composeArgs, ...operation]);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // fs and CLI parser errors can contain input values; do not echo those.
    const safe = error.code
      ? "Could not read worker configuration or invoke Docker. Check paths, permissions, and --help."
      : error.message;
    console.error(safe);
    process.exitCode = 1;
  });
}
