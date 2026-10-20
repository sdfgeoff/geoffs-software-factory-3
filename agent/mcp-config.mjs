import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const agentDir = dirname(fileURLToPath(import.meta.url));
export function browserMcpArgs({
  workspace,
  stateDir,
  executable = "/usr/bin/chromium",
}) {
  return [
    join(
      agentDir,
      "..",
      "node_modules",
      "chrome-devtools-mcp",
      "build",
      "src",
      "bin",
      "chrome-devtools-mcp.js",
    ),
    "--executablePath=" + executable,
    "--userDataDir=" + join(stateDir, "browser"),
    "--workspace=" + workspace,
    "--viewport=1280x800",
    "--chromeArg=--no-sandbox",
    "--chromeArg=--disable-dev-shm-usage",
    "--no-usage-statistics",
    "--no-performance-crux",
  ];
}
export function workerMcpConfig({ workspace, stateDir, desktop = false }) {
  const board = `cli_auth_credentials_store = "file"\n[mcp_servers.threadwork]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(agentDir, "mcp.mjs"))}]\nenv_vars = ["THREADWORK_URL", "AGENT_TOKEN", "AGENT_WORKSPACE", "WORKER_INSTANCE", "THREADWORK_DESKTOP", "DISPLAY", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]\nrequired = true\nstartup_timeout_sec = 30\n`;
  if (!desktop) return board;
  return (
    board +
    `\n[mcp_servers.chrome_devtools]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(browserMcpArgs({ workspace: resolve(workspace), stateDir: resolve(stateDir) }))}\nenv_vars = ["DISPLAY", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]\nrequired = true\nstartup_timeout_sec = 45\ntool_timeout_sec = 120\n[mcp_servers.chrome_devtools.env]\nCHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = "1"\nCHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS = "1"\n`
  );
}
