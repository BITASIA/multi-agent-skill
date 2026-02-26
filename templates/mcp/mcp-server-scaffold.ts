/**
 * Minimal MCP Server Scaffold with Validation
 *
 * A framework-agnostic MCP server that validates every request and
 * response with Zod. Does NOT depend on any specific MCP SDK –
 * uses generic types so you can plug in any transport layer.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

export const ToolCallRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string().min(1),
    arguments: z.record(z.unknown()).default({}),
  }),
});

export type ToolCallRequest = z.infer<typeof ToolCallRequest>;

export const ToolCallResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z
    .object({
      content: z.array(
        z.object({
          type: z.enum(["text", "image", "resource"]),
          text: z.string().optional(),
          data: z.string().optional(),
          mimeType: z.string().optional(),
        })
      ),
      isError: z.boolean().default(false),
    })
    .optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
      data: z.unknown().optional(),
    })
    .optional(),
});

export type ToolCallResponse = z.infer<typeof ToolCallResponse>;

export const ToolListRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.literal("tools/list"),
});

// ---------------------------------------------------------------------------
// Tool handler interface
// ---------------------------------------------------------------------------

export interface ToolHandler {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  readonly outputSchema: z.ZodTypeAny;
  readonly execute: (input: unknown) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface ServerConfig {
  readonly name: string;
  readonly version: string;
}

export interface McpServer {
  readonly config: ServerConfig;
  readonly tools: ReadonlyMap<string, ToolHandler>;
  readonly handleRequest: (raw: unknown) => Promise<ToolCallResponse>;
  readonly listTools: () => ReadonlyArray<{ name: string; description: string }>;
  readonly healthCheck: () => HealthStatus;
}

export interface HealthStatus {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly serverName: string;
  readonly version: string;
  readonly toolCount: number;
  readonly uptimeMs: number;
  readonly checkedAt: string;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function errorResponse(id: string | number, code: number, message: string): ToolCallResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function successResponse(id: string | number, text: string): ToolCallResponse {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text }],
      isError: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create a new MCP server. Tools are registered at creation time.
 * The returned server is immutable.
 */
export function createServer(
  config: Readonly<ServerConfig>,
  handlers: ReadonlyArray<ToolHandler>
): McpServer {
  const startTime = Date.now();
  const toolMap = new Map(handlers.map((h) => [h.name, h]));

  async function handleRequest(raw: unknown): Promise<ToolCallResponse> {
    const reqParse = ToolCallRequest.safeParse(raw);
    if (!reqParse.success) {
      const id = (raw as Record<string, unknown>)?.id ?? 0;
      return errorResponse(
        id as string | number,
        -32600,
        `Invalid request: ${reqParse.error.message}`
      );
    }

    const req = reqParse.data;
    const handler = toolMap.get(req.params.name);

    if (!handler) {
      return errorResponse(req.id, -32601, `Unknown tool: ${req.params.name}`);
    }

    return executeHandler(req.id, handler, req.params.arguments);
  }

  async function executeHandler(
    id: string | number,
    handler: ToolHandler,
    rawInput: unknown
  ): Promise<ToolCallResponse> {
    // Validate input
    const inputResult = handler.inputSchema.safeParse(rawInput);
    if (!inputResult.success) {
      return errorResponse(
        id,
        -32602,
        `Input validation failed: ${inputResult.error.message}`
      );
    }

    try {
      const output = await handler.execute(inputResult.data);

      // Validate output
      const outputResult = handler.outputSchema.safeParse(output);
      if (!outputResult.success) {
        return errorResponse(
          id,
          -32603,
          `Output validation failed: ${outputResult.error.message}`
        );
      }

      return successResponse(id, JSON.stringify(outputResult.data));
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return errorResponse(id, -32603, message);
    }
  }

  function listTools(): ReadonlyArray<{ name: string; description: string }> {
    return handlers.map((h) => ({
      name: h.name,
      description: h.description,
    }));
  }

  function healthCheck(): HealthStatus {
    return {
      status: "healthy",
      serverName: config.name,
      version: config.version,
      toolCount: toolMap.size,
      uptimeMs: Date.now() - startTime,
      checkedAt: new Date().toISOString(),
    };
  }

  return Object.freeze({
    config,
    tools: toolMap,
    handleRequest,
    listTools,
    healthCheck,
  });
}

// ---------------------------------------------------------------------------
// Example: register a simple echo tool
// ---------------------------------------------------------------------------

const EchoInput = z.object({ message: z.string().min(1) });
const EchoOutput = z.object({ echo: z.string() });

const echoHandler: ToolHandler = {
  name: "echo",
  description: "Echoes the input message back.",
  inputSchema: EchoInput,
  outputSchema: EchoOutput,
  execute: async (input) => {
    const parsed = EchoInput.parse(input);
    return { echo: parsed.message };
  },
};

/** Ready-to-use example server. */
export const exampleServer = createServer(
  { name: "example-mcp-server", version: "0.1.0" },
  [echoHandler]
);
