import { randomUUID } from "node:crypto";
export function createApi({
  url = process.env.THREADWORK_URL || "http://localhost:3001",
  credential = process.env.AGENT_TOKEN,
  instance = process.env.WORKER_INSTANCE,
} = {}) {
  if (!credential) throw new Error("AGENT_TOKEN is required");
  return async function api(
    path,
    { method = "GET", body, raw = false, retries = 2, idempotencyKey } = {},
  ) {
    const key = idempotencyKey || (method !== "GET" ? randomUUID() : undefined);
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${url.replace(/\/$/, "")}/api${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${credential}`,
            ...(instance ? { "X-Worker-Instance": instance } : {}),
            ...(key ? { "Idempotency-Key": key } : {}),
            ...(body && !(body instanceof FormData)
              ? { "Content-Type": "application/json" }
              : {}),
          },
          body:
            body instanceof FormData
              ? body
              : body === undefined
                ? undefined
                : JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) {
          const info = await response.json().catch(() => ({}));
          const error = new Error(info.error || `HTTP ${response.status}`);
          error.status = response.status;
          throw error;
        }
        return raw ? response : await response.json();
      } catch (error) {
        if (attempt >= retries || (error.status && error.status < 500))
          throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, 500 * (attempt + 1)),
        );
      }
    }
  };
}
