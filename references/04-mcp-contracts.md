# MCP Contracts: Tool Definitions with Enforcement

## MCP Overview for Multi-Agent Context

The Model Context Protocol (MCP) standardizes how agents interact with
external tools and services. In a multi-agent system, MCP serves as the
contract layer between agents and the tools they call. Each tool has a
typed definition, and every call is validated before execution and after
completion.

MCP tools are the atomic operations agents can perform. An agent's
capability is defined entirely by the set of MCP tools available to it.
This makes tool definitions the most critical contract in the system.

```typescript
// An MCP tool definition is a contract:
// - Name: what it does
// - Description: when to use it (for the LLM)
// - Input schema: what it accepts
// - Output schema: what it returns (enforced by your middleware)

// The agent sees the tool definition and decides whether to call it.
// Your middleware validates the call before execution.
// The result is validated before returning to the agent.
```

## Tool Definition Structure with Typed Schemas

```typescript
import { z } from "zod";

// Generic tool definition type
interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  handler: (input: TInput) => Promise<TOutput>;
}

// Factory function for creating typed tool definitions
function defineTool<TInput, TOutput>(config: {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  handler: (input: TInput) => Promise<TOutput>;
}): ToolDefinition<TInput, TOutput> {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    handler: config.handler,
  };
}
```

### Concrete Tool Definitions

```typescript
// Search tool
const searchTool = defineTool({
  name: "search_documents",
  description:
    "Search the document store by query. Returns ranked results " +
    "with relevance scores. Use when you need to find information " +
    "from the knowledge base.",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(50).default(10),
    filters: z
      .object({
        category: z.enum(["technical", "business", "legal"]).optional(),
        dateAfter: z.string().datetime().optional(),
        dateBefore: z.string().datetime().optional(),
        author: z.string().optional(),
      })
      .optional(),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        id: z.string().uuid(),
        title: z.string(),
        snippet: z.string().max(500),
        relevance: z.number().min(0).max(1),
        metadata: z.object({
          category: z.string(),
          author: z.string(),
          publishedAt: z.string().datetime(),
        }),
      })
    ),
    totalCount: z.number().int().nonnegative(),
    queryTimeMs: z.number().nonnegative(),
  }),
  handler: async (input) => {
    // Implementation would connect to actual search service
    return {
      results: [],
      totalCount: 0,
      queryTimeMs: 0,
    };
  },
});

// Task assignment tool
const assignTaskTool = defineTool({
  name: "assign_task",
  description:
    "Assign a task to a specific agent. The task must exist and be " +
    "in 'pending' status. The target agent must be available.",
  inputSchema: z.object({
    taskId: z.string().uuid(),
    assignTo: z.string().min(1),
    priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    deadline: z.string().datetime().optional(),
    context: z.string().max(2000).optional(),
  }),
  outputSchema: z.object({
    assigned: z.boolean(),
    taskId: z.string().uuid(),
    assignedTo: z.string(),
    assignedAt: z.string().datetime(),
    estimatedCompletion: z.string().datetime().optional(),
  }),
  handler: async (input) => {
    return {
      assigned: true,
      taskId: input.taskId,
      assignedTo: input.assignTo,
      assignedAt: new Date().toISOString(),
    };
  },
});

// Send notification tool
const notifyTool = defineTool({
  name: "send_notification",
  description:
    "Send a notification to a user or channel. Use for status updates, " +
    "alerts, or completion notices.",
  inputSchema: z.object({
    recipient: z.union([
      z.object({ type: z.literal("user"), userId: z.string().uuid() }),
      z.object({ type: z.literal("channel"), channelId: z.string() }),
    ]),
    message: z.object({
      title: z.string().min(1).max(100),
      body: z.string().min(1).max(2000),
      severity: z.enum(["info", "warning", "error", "critical"]).default("info"),
    }),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    notificationId: z.string().uuid(),
    sentAt: z.string().datetime(),
    deliveryStatus: z.enum(["delivered", "queued", "failed"]),
  }),
  handler: async (input) => {
    return {
      sent: true,
      notificationId: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      deliveryStatus: "delivered" as const,
    };
  },
});
```

## Input/Output Contract Enforcement

### Validation Middleware

```typescript
import { z } from "zod";

// Middleware that wraps any tool with input/output validation
function withContractEnforcement<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return {
    ...tool,
    handler: async (rawInput: TInput) => {
      // Validate input (even though it's typed, it comes from an agent)
      const inputResult = tool.inputSchema.safeParse(rawInput);
      if (!inputResult.success) {
        throw new ContractViolationError(
          tool.name,
          "input",
          inputResult.error,
        );
      }

      // Execute handler with validated input
      const rawOutput = await tool.handler(inputResult.data);

      // Validate output
      const outputResult = tool.outputSchema.safeParse(rawOutput);
      if (!outputResult.success) {
        throw new ContractViolationError(
          tool.name,
          "output",
          outputResult.error,
        );
      }

      return outputResult.data;
    },
  };
}

class ContractViolationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly boundary: "input" | "output",
    public readonly zodError: z.ZodError,
  ) {
    const issues = zodError.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    super(
      `Contract violation in tool "${toolName}" at ${boundary} boundary: ${issues}`,
    );
    this.name = "ContractViolationError";
  }
}
```

### Pre-Execution Validation Middleware

Validate business rules before the tool handler runs.

```typescript
type PreValidator<TInput> = (input: TInput) => Promise<{
  valid: boolean;
  reason?: string;
}>;

function withPreValidation<TInput, TOutput>(
  tool: ToolDefinition<TInput, TOutput>,
  validators: PreValidator<TInput>[],
): ToolDefinition<TInput, TOutput> {
  return {
    ...tool,
    handler: async (input: TInput) => {
      // Run all pre-validators
      for (const validator of validators) {
        const result = await validator(input);
        if (!result.valid) {
          throw new PreValidationError(tool.name, result.reason ?? "Unknown");
        }
      }
      return tool.handler(input);
    },
  };
}

class PreValidationError extends Error {
  constructor(toolName: string, reason: string) {
    super(`Pre-validation failed for tool "${toolName}": ${reason}`);
    this.name = "PreValidationError";
  }
}

// Example: rate limiting pre-validator
function rateLimitValidator(
  maxCallsPerMinute: number,
): PreValidator<unknown> {
  const calls: number[] = [];

  return async () => {
    const now = Date.now();
    const oneMinuteAgo = now - 60_000;

    // Remove calls older than one minute (immutable filter)
    const recentCalls = calls.filter((t) => t > oneMinuteAgo);
    calls.length = 0;
    calls.push(...recentCalls, now);

    if (recentCalls.length >= maxCallsPerMinute) {
      return {
        valid: false,
        reason: `Rate limit exceeded: ${maxCallsPerMinute} calls/minute`,
      };
    }
    return { valid: true };
  };
}

// Example: permission pre-validator
function permissionValidator(
  requiredPermission: string,
  getAgentPermissions: () => Promise<string[]>,
): PreValidator<unknown> {
  return async () => {
    const permissions = await getAgentPermissions();
    if (!permissions.includes(requiredPermission)) {
      return {
        valid: false,
        reason: `Missing required permission: ${requiredPermission}`,
      };
    }
    return { valid: true };
  };
}
```

## Contract Testing Between Agents

Contract tests verify that agents produce outputs matching the expected
schema. They run against real agent implementations with synthetic inputs.

```typescript
import { z } from "zod";

// Contract test framework
interface ContractTest<TInput, TOutput> {
  name: string;
  tool: ToolDefinition<TInput, TOutput>;
  testCases: Array<{
    description: string;
    input: TInput;
    expectedOutputShape?: z.ZodType; // Optional stricter validation
    shouldFail?: boolean;
  }>;
}

async function runContractTests<TInput, TOutput>(
  test: ContractTest<TInput, TOutput>,
): Promise<{
  passed: number;
  failed: number;
  results: Array<{
    description: string;
    passed: boolean;
    error?: string;
  }>;
}> {
  const results: Array<{
    description: string;
    passed: boolean;
    error?: string;
  }> = [];

  for (const testCase of test.testCases) {
    try {
      // Validate input matches the tool's input schema
      const validInput = test.tool.inputSchema.parse(testCase.input);

      // Execute the handler
      const output = await test.tool.handler(validInput);

      // Validate output matches the tool's output schema
      test.tool.outputSchema.parse(output);

      // If a stricter shape was specified, validate that too
      if (testCase.expectedOutputShape) {
        testCase.expectedOutputShape.parse(output);
      }

      if (testCase.shouldFail) {
        results.push({
          description: testCase.description,
          passed: false,
          error: "Expected failure but succeeded",
        });
      } else {
        results.push({ description: testCase.description, passed: true });
      }
    } catch (error) {
      if (testCase.shouldFail) {
        results.push({ description: testCase.description, passed: true });
      } else {
        results.push({
          description: testCase.description,
          passed: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  return {
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
}

// Example contract test
const searchToolContractTest: ContractTest<
  z.infer<typeof searchTool.inputSchema>,
  z.infer<typeof searchTool.outputSchema>
> = {
  name: "search_documents contract",
  tool: searchTool,
  testCases: [
    {
      description: "Valid query returns results matching schema",
      input: { query: "typescript patterns", maxResults: 5 },
    },
    {
      description: "Empty query should fail validation",
      input: { query: "", maxResults: 5 },
      shouldFail: true,
    },
    {
      description: "Filtered query returns results matching schema",
      input: {
        query: "security audit",
        maxResults: 10,
        filters: { category: "technical" as const },
      },
    },
  ],
};
```

## MCP Server Scaffold with Validation

A complete MCP server that registers tools, validates contracts, and
handles requests.

```typescript
import { z } from "zod";

// Tool registry
class ToolRegistry {
  private tools: Map<string, ToolDefinition<unknown, unknown>> = new Map();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
  }

  get(name: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  // Export tool definitions in MCP format
  toMCPToolList(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema),
    }));
  }
}

// Convert Zod schema to JSON Schema (simplified)
function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  // In production, use a library like zod-to-json-schema
  // This is a simplified illustration
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as z.ZodType);
      if (!(value instanceof z.ZodOptional)) {
        required.push(key);
      }
    }

    return { type: "object", properties, required };
  }
  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  return {};
}

// MCP request/response schemas
const MCPToolCallRequestSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()).optional(),
  }),
});

const MCPToolCallResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal("text"),
      text: z.string(),
    })
  ),
  isError: z.boolean().optional(),
});

type MCPToolCallRequest = z.infer<typeof MCPToolCallRequestSchema>;
type MCPToolCallResponse = z.infer<typeof MCPToolCallResponseSchema>;

// MCP Server with validation
class ValidatedMCPServer {
  private registry: ToolRegistry;
  private middleware: Array<
    (toolName: string, input: unknown) => Promise<void>
  > = [];

  constructor() {
    this.registry = new ToolRegistry();
  }

  registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    // Wrap with contract enforcement before registering
    const enforcedTool = withContractEnforcement(tool);
    this.registry.register(enforcedTool);
  }

  addMiddleware(
    fn: (toolName: string, input: unknown) => Promise<void>,
  ): void {
    this.middleware = [...this.middleware, fn];
  }

  async handleToolCall(request: unknown): Promise<MCPToolCallResponse> {
    // Validate request structure
    const reqResult = MCPToolCallRequestSchema.safeParse(request);
    if (!reqResult.success) {
      return {
        content: [
          {
            type: "text",
            text: `Invalid request: ${reqResult.error.message}`,
          },
        ],
        isError: true,
      };
    }

    const { name, arguments: args } = reqResult.data.params;

    // Look up tool
    const tool = this.registry.get(name);
    if (!tool) {
      return {
        content: [
          { type: "text", text: `Unknown tool: ${name}` },
        ],
        isError: true,
      };
    }

    // Run middleware
    for (const mw of this.middleware) {
      try {
        await mw(name, args);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Middleware rejected call: ${
                error instanceof Error ? error.message : "Unknown"
              }`,
            },
          ],
          isError: true,
        };
      }
    }

    // Execute tool (contract enforcement is built in)
    try {
      const result = await tool.handler(args ?? {});
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : "Tool execution failed",
          },
        ],
        isError: true,
      };
    }
  }

  getToolList() {
    return this.registry.toMCPToolList();
  }
}
```

### Wiring It Together

```typescript
// Create server
const server = new ValidatedMCPServer();

// Register tools
server.registerTool(searchTool);
server.registerTool(assignTaskTool);
server.registerTool(notifyTool);

// Add logging middleware
server.addMiddleware(async (toolName, input) => {
  const sanitizedInput = JSON.stringify(input).substring(0, 500);
  console.info(`[MCP] Tool call: ${toolName}, input: ${sanitizedInput}`);
});

// Add rate limiting middleware
const callCounts: Map<string, number[]> = new Map();
server.addMiddleware(async (toolName) => {
  const now = Date.now();
  const existing = callCounts.get(toolName) ?? [];
  const recent = existing.filter((t) => t > now - 60_000);
  const updated = [...recent, now];
  callCounts.set(toolName, updated);

  if (recent.length > 100) {
    throw new Error(`Rate limit exceeded for tool "${toolName}"`);
  }
});

// Handle a tool call
const response = await server.handleToolCall({
  method: "tools/call",
  params: {
    name: "search_documents",
    arguments: {
      query: "multi-agent patterns",
      maxResults: 5,
    },
  },
});
```

## Agent-to-Agent Tool Exposure

Agents can expose their capabilities as MCP tools for other agents to call.

```typescript
// Agent A exposes its analysis capability as an MCP tool
const analysisAgentTool = defineTool({
  name: "analyze_code",
  description:
    "Perform deep code analysis. Returns findings categorized by " +
    "severity. Use for security reviews, performance audits, or " +
    "quality assessments.",
  inputSchema: z.object({
    code: z.string().min(1),
    language: z.enum(["typescript", "javascript", "python", "go"]),
    analysisType: z.enum(["security", "performance", "quality"]),
    context: z.string().max(1000).optional(),
  }),
  outputSchema: z.object({
    findings: z.array(
      z.object({
        id: z.string().uuid(),
        severity: z.enum(["critical", "high", "medium", "low", "info"]),
        category: z.string(),
        line: z.number().int().positive().optional(),
        message: z.string(),
        suggestedFix: z.string().optional(),
      })
    ),
    summary: z.string().max(2000),
    overallScore: z.number().min(0).max(100),
    analysisTimeMs: z.number().nonnegative(),
  }),
  handler: async (input) => {
    // Calls the actual analysis agent under the hood
    // The contract ensures the agent's output is well-formed
    const agentResult = await runAnalysisAgent(input);
    return agentResult;
  },
});

async function runAnalysisAgent(input: unknown): Promise<unknown> {
  // Placeholder for actual agent invocation
  return {
    findings: [],
    summary: "No issues found",
    overallScore: 100,
    analysisTimeMs: 150,
  };
}

// Agent B can now call Agent A through the MCP protocol
// with full contract enforcement on both sides
```

## Contract Versioning for MCP Tools

```typescript
// Tool contracts evolve over time. Use versioned endpoints.
const searchToolV1 = defineTool({
  name: "search_documents_v1",
  description: "Search documents (v1 - basic query)",
  inputSchema: z.object({
    query: z.string().min(1),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      id: z.string(),
      title: z.string(),
    })),
  }),
  handler: async (input) => ({ results: [] }),
});

const searchToolV2 = defineTool({
  name: "search_documents_v2",
  description: "Search documents (v2 - with filters and relevance)",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(50).default(10),
    filters: z.object({
      category: z.string().optional(),
    }).optional(),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      id: z.string().uuid(),
      title: z.string(),
      relevance: z.number().min(0).max(1),
    })),
    totalCount: z.number().int().nonnegative(),
  }),
  handler: async (input) => ({ results: [], totalCount: 0 }),
});

// Register both versions — older agents use v1, newer agents use v2
server.registerTool(searchToolV1);
server.registerTool(searchToolV2);
```

## Summary

MCP contracts are the enforcement layer for multi-agent tool usage:

1. **Tool definitions** combine name, description, input schema, and output schema
2. **Contract enforcement middleware** validates every call and result
3. **Pre-execution validators** check business rules before tool execution
4. **Contract tests** verify tools produce schema-conformant output
5. **The MCP server** orchestrates tool registration, middleware, and execution
6. **Agent-to-agent exposure** allows agents to consume each other's capabilities
7. **Versioned contracts** enable backward-compatible evolution

Every tool call is a contract. Every contract is enforced at runtime.
No unvalidated data crosses the boundary.
