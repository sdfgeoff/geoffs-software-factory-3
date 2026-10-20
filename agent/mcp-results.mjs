import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { errorResult, validationIssues } from "../shared/errors.mjs";

const failure = (code, message, guidance, issues) =>
  errorResult({
    publicError: {
      code,
      message,
      status: null,
      retryable: false,
      guidance,
      ...(issues ? { issues: validationIssues(issues) } : {}),
    },
  });
// Use the SDK's public protocol handlers so argument errors have the same typed
// envelope as handler failures. No dependency on McpServer private methods.
export class ResultMcpServer {
  constructor(identity) {
    this.tools = new Map();
    this.protocol = new Server(identity, {
      capabilities: { tools: { listChanged: true } },
    });
    this.protocol.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...this.tools.values()].map((t) => t.definition),
    }));
    this.protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = this.tools.get(request.params.name);
      if (!tool)
        return failure(
          "TOOL_NOT_FOUND",
          "Tool is unknown or unavailable",
          "Check the current tool catalog.",
        );
      if (request.params.task)
        return failure(
          "UNSUPPORTED_REQUEST",
          "This tool does not support task requests",
          "Use an ordinary tool call.",
        );
      try {
        const args = await tool.input.safeParseAsync(
          request.params.arguments ?? {},
        );
        if (!args.success)
          return failure(
            "VALIDATION_ERROR",
            "Tool argument validation failed",
            "Correct the tool arguments.",
            args.error.issues,
          );
        const result = await tool.handler(args.data);
        const output = await tool.output.safeParseAsync(
          result.structuredContent,
        );
        if (!output.success)
          return errorResult({ publicCode: "INVALID_RESULT" });
        return result;
      } catch (error) {
        return errorResult(error);
      }
    });
  }
  registerTool(name, { description, inputSchema, outputSchema }, handler) {
    if (this.tools.has(name)) throw Error(`Duplicate tool: ${name}`);
    const input = z.object(inputSchema),
      output = z.object(outputSchema).strict();
    const schema = (value) =>
      zodToJsonSchema(value, { $refStrategy: "none", target: "jsonSchema7" });
    this.tools.set(name, {
      input,
      output,
      handler,
      definition: {
        name,
        description,
        inputSchema: schema(input),
        outputSchema: schema(output),
      },
    });
  }
  connect(transport) {
    return this.protocol.connect(transport);
  }
}
