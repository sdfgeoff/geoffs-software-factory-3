// Git invokes this helper for the board gateway only. Credentials stay in the
// worker environment, never in a remote URL, Git config, or a checked-in file.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const fields = Object.fromEntries(
  input
    .split("\n")
    .filter((line) => line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
if (process.argv[2] === "get" && process.env.AGENT_TOKEN) {
  const board = new URL(process.env.THREADWORK_URL || "http://localhost:3001");
  const prefix = board.pathname.replace(/\/$/, "") + "/api/git/";
  if (
    fields.protocol === board.protocol.slice(0, -1) &&
    fields.host === board.host &&
    ("/" + (fields.path || "").replace(/^\//, "")).startsWith(prefix)
  )
    process.stdout.write(
      `username=threadwork\npassword=${process.env.AGENT_TOKEN}\n\n`,
    );
}
