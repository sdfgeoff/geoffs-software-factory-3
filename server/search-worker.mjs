import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { searchPlatform } from "./search.mjs";
import { listThreads } from "./thread-list.mjs";
const db = new DatabaseSync(workerData.path, { readOnly: true });
db.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON");
parentPort.on("message", ({ kind, input, user }) => {
  try {
    // Keep count, window, and multi-stage candidate reads on one WAL snapshot.
    db.exec("BEGIN");
    const result =
      kind === "global"
        ? searchPlatform(db, user, input)
        : listThreads(db, input);
    db.exec("COMMIT");
    parentPort.postMessage({ result });
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    parentPort.postMessage({
      error: {
        status: error.name === "ZodError" ? 400 : 500,
        message:
          error.name === "ZodError"
            ? error.issues
                .map((i) => `${i.path.join(".")}: ${i.message}`)
                .join("; ")
            : "Search failed",
      },
    });
  }
});
