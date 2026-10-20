import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
const files = ["server", "agent", "scripts", "tests", "shared"].flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => `${dir}/${f}`),
);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
