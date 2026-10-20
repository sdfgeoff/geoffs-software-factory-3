import { parentPort } from "node:worker_threads";
parentPort.on("message", (message) => {
  if (message.input?.block) while (true) {}
  parentPort.postMessage({ result: { ok: true } });
});
