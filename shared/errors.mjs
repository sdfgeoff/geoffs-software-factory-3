import { z } from "zod";
export const publicErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    status: z.number().int().min(400).max(599).nullable(),
    retryable: z.boolean().nullable(),
    guidance: z.string(),
    issues: z
      .array(
        z
          .object({
            path: z.array(z.union([z.string(), z.number()])),
            code: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const codes = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  429: "RATE_LIMITED",
  500: "INTERNAL_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
  504: "GATEWAY_TIMEOUT",
};
// Issue messages are deliberately generic: Zod enum/literal/custom messages may
// contain the submitted value. Field paths and issue codes retain useful guidance.
export function validationIssues(issues = []) {
  return issues.slice(0, 50).map((i) => ({
    path: i.path.filter((p) => typeof p === "string" || typeof p === "number"),
    code: i.code,
    message: "Invalid field value",
  }));
}
export function httpError(status, message, issues) {
  const client = status < 500;
  return publicErrorSchema.parse({
    code: issues ? "VALIDATION_ERROR" : codes[status] || "HTTP_ERROR",
    message: issues
      ? "Request validation failed"
      : client
        ? String(message).slice(0, 1000)
        : "Server request failed",
    status,
    retryable: client && status !== 429 ? false : null,
    guidance:
      issues || status === 400
        ? "Correct the request arguments."
        : status === 401
          ? "Authenticate before retrying."
          : status === 403
            ? "Check the caller's permissions."
            : status === 409
              ? "Read the current state before deciding whether to retry."
              : status === 413
                ? "Reduce the request size."
                : status === 404
                  ? "Check the resource identifier and access."
                  : "Check service and operation state before retrying; a mutation may already have committed.",
    ...(issues ? { issues: validationIssues(issues) } : {}),
  });
}
export function publicToolError(error) {
  if (error.publicError) return publicErrorSchema.parse(error.publicError);
  if (error.publicCode === "INVALID_RESULT")
    return {
      code: "INVALID_RESULT",
      message: "Tool returned an invalid public result",
      status: null,
      retryable: null,
      guidance: "Inspect the server/tool contract before retrying.",
    };
  if (error.name === "TimeoutError" || error.name === "AbortError")
    return {
      code: "TIMEOUT",
      message: "Tool request timed out",
      status: null,
      retryable: null,
      guidance:
        "Check operation state before retrying; a mutation may already have committed.",
    };
  if (error.status) return httpError(error.status, error.message);
  if (error instanceof TypeError && error.message === "fetch failed")
    return {
      code: "NETWORK_ERROR",
      message: "Unable to reach the board",
      status: null,
      retryable: null,
      guidance: "Check connectivity and operation state before retrying.",
    };
  const files = {
    EEXIST: [
      "FILE_EXISTS",
      "Destination file already exists",
      "Choose a new destination file; existing files are not overwritten.",
    ],
    ENOENT: [
      "FILE_NOT_FOUND",
      "A workspace file or parent directory does not exist",
      "Check the source path and destination parent directory.",
    ],
    EACCES: [
      "FILE_PERMISSION_DENIED",
      "Workspace file permission denied",
      "Check workspace file permissions.",
    ],
    EPERM: [
      "FILE_PERMISSION_DENIED",
      "Workspace file permission denied",
      "Check workspace file permissions.",
    ],
    EISDIR: [
      "INVALID_PATH",
      "Expected a file path",
      "Choose a new destination file inside the workspace.",
    ],
    ENOTDIR: [
      "INVALID_PATH",
      "Expected a directory in the path",
      "Check that the parent directory exists.",
    ],
  };
  if (files[error.code]) {
    const [code, message, guidance] = files[error.code];
    return { code, message, status: null, retryable: false, guidance };
  }
  const safeMessages = [
    "No virtual display is configured. Use the desktop-enabled worker image.",
    "Path must be inside your workspace",
    "File exceeds 20 MB",
    "This attachment is not a supported image (PNG, JPEG, GIF or WebP)",
    "Desktop tools require THREADWORK_DESKTOP=true",
    "Desktop tools are disabled; set THREADWORK_DESKTOP=true",
  ];
  return {
    code: "LOCAL_TOOL_ERROR",
    message: safeMessages.includes(error.message)
      ? error.message
      : "Local tool operation failed",
    status: null,
    retryable: null,
    guidance:
      "Check tool arguments, workspace paths and local environment before retrying.",
  };
}
export function errorResult(error) {
  const details = publicToolError(error);
  return {
    isError: true,
    content: [{ type: "text", text: details.message }],
    structuredContent: { outcome: { ok: false, error: details } },
  };
}
