#!/usr/bin/env node
// Protocol fixture only: never makes model requests or posts to the board.
import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let turn = 0,
  timer,
  authenticated = !process.env.FAKE_CODEX_NO_AUTH;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(request) + "\n");
  const { method, id } = request;
  if (
    method === "thread/inject_items" &&
    process.env.FAKE_CODEX_INJECT_FAIL_ONCE &&
    !existsSync(process.env.FAKE_CODEX_INJECT_FAIL_ONCE)
  ) {
    writeFileSync(process.env.FAKE_CODEX_INJECT_FAIL_ONCE, "failed");
    send({
      id,
      error: { code: -32000, message: "Transient initialization failure" },
    });
    return;
  }
  let result = {};
  if (method === "account/read")
    result = {
      account: authenticated
        ? { type: "chatgpt", email: "fixture@example.test" }
        : null,
      requiresOpenaiAuth: true,
    };
  if (method === "account/login/start") {
    authenticated = true;
    result = {
      verificationUrl: "https://example.test/device",
      userCode: "TEST-CODE",
    };
    send({ method: "account/login/completed", params: { success: true } });
  }
  if (method === "thread/start" || method === "thread/resume")
    result = { thread: { id: "one-persistent-session" } };
  if (method === "turn/start") {
    const tid = "turn-" + ++turn;
    result = { turn: { id: tid, status: "inProgress" } };
    const finish = () => {
      send({
        method: "item/agentMessage/delta",
        params: { delta: "Private runtime response. Never post me." },
      });
      send({
        method: "turn/completed",
        params: { turn: { id: tid, status: "completed" } },
      });
    };
    if (process.env.FAKE_CODEX_COMPLETE_EARLY) finish();
    else timer = setTimeout(finish, 1800);
  }
  if (method === "turn/steer")
    result = { turnId: request.params.expectedTurnId };
  if (method === "turn/interrupt") {
    clearTimeout(timer);
    send({
      method: "turn/completed",
      params: { turn: { id: request.params.turnId, status: "interrupted" } },
    });
  }
  send({ id, result });
  if (
    method === "turn/start" &&
    process.env.FAKE_CODEX_CRASH_ONCE &&
    !existsSync(process.env.FAKE_CODEX_CRASH_ONCE)
  ) {
    writeFileSync(process.env.FAKE_CODEX_CRASH_ONCE, "crashed");
    setTimeout(() => process.exit(1), 20);
  }
});
