import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
let input = "";
for await (const part of process.stdin) input += part;
try {
  if (
    !process.env.THREADWORK_GIT_USER ||
    !process.env.THREADWORK_GIT_DB ||
    !process.env.THREADWORK_GIT_REPO
  )
    throw Error("Managed gateway required");
  const db = new DatabaseSync(process.env.THREADWORK_GIT_DB, {
    readOnly: true,
  });
  const user = Number(process.env.THREADWORK_GIT_USER),
    repo = Number(process.env.THREADWORK_GIT_REPO);
  const cap = db
    .prepare("SELECT can_work FROM work_capabilities WHERE user_id=?")
    .get(user);
  if (cap && !cap.can_work) throw Error("Implementation permission required");
  for (const line of input.trim().split("\n")) {
    const [old, next, ref] = line.split(" ");
    if (!/^[a-f0-9]{40}$/.test(next) || /^0+$/.test(next))
      throw Error("Branch deletion is disabled");
    const branch = db
      .prepare(
        "SELECT b.*,r.main_branch FROM managed_branches b JOIN repositories r ON r.id=b.repository_id WHERE b.repository_id=? AND b.name=?",
      )
      .get(repo, ref.replace(/^refs\/heads\//, ""));
    if (
      !ref.startsWith("refs/heads/") ||
      !branch ||
      branch.name === branch.main_branch ||
      branch.owner_id !== user ||
      branch.state !== "active"
    )
      throw Error("Only the owner may push a registered active branch");
    if (old !== branch.head_commit)
      throw Error("Branch head changed; fetch before pushing");
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "merge-base",
        "--is-ancestor",
        old,
        next,
      ],
      { stdio: "ignore" },
    );
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "cat-file", "-e", `${next}^{commit}`],
      { stdio: "ignore" },
    );
  }
  db.close();
} catch (e) {
  console.error(e.message || "Push rejected");
  process.exit(1);
}
