# Typed Schemas: Zod at Agent Boundaries

## Why Untyped Data Causes Silent Failures

TypeScript's type system is compile-time only. At runtime, data crossing
agent boundaries is `unknown`. An agent's output is a string that gets
parsed into a JavaScript object with no type guarantees. Without runtime
validation, every data exchange is a silent failure waiting to happen.

```typescript
// TypeScript types vanish at runtime
interface TaskResult {
  score: number;
  summary: string;
}

// This function accepts ANY input at runtime — the type annotation is a lie
function processResult(result: TaskResult) {
  // If result.score is actually a string "85", this computes "851" not 86
  const adjusted = result.score + 1;
  return adjusted;
}

// What actually arrives from an agent:
const agentOutput = JSON.parse('{"score": "85", "summary": "ok"}');
processResult(agentOutput); // No error, wrong result: "851"
```

Zod solves this by performing runtime validation that matches your types.
The schema IS the type, and it IS the validator.

## Zod Schema Fundamentals for Agent Boundaries

### Basic Schemas

```typescript
import { z } from "zod";

// Primitive schemas
const AgentId = z.string().uuid();
const Confidence = z.number().min(0).max(1);
const Timestamp = z.string().datetime();
const TokenCount = z.number().int().nonnegative();

// Object schema — the workhorse of agent communication
const AgentMessageSchema = z.object({
  id: z.string().uuid(),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  timestamp: z.string().datetime(),
  payload: z.unknown(), // Will be refined per message type
  metadata: z.object({
    correlationId: z.string().uuid(),
    tokenCount: z.number().int().nonnegative(),
    latencyMs: z.number().nonnegative(),
  }),
});

// Infer TypeScript types from schemas — single source of truth
type AgentMessage = z.infer<typeof AgentMessageSchema>;
```

### Enum and Literal Schemas

```typescript
// Use enums for finite sets of known values
const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
]);

// Use literals for discriminated unions (covered in 03-action-schemas)
const ApproveActionSchema = z.object({
  type: z.literal("approve"),
  reason: z.string(),
});

// Union of literals for flexible but constrained values
const PrioritySchema = z.union([
  z.literal("critical"),
  z.literal("high"),
  z.literal("medium"),
  z.literal("low"),
]);
```

### Array and Record Schemas

```typescript
// Arrays with constraints
const FindingsSchema = z.array(
  z.object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    message: z.string(),
    location: z.string(),
  })
).min(0).max(100);

// Records for dynamic keys with typed values
const AgentMetricsSchema = z.record(
  z.string(), // agent name
  z.object({
    callCount: z.number().int().nonnegative(),
    avgLatencyMs: z.number().nonnegative(),
    errorRate: z.number().min(0).max(1),
  })
);
```

## Schema Composition Patterns

### Merge: Combining Two Schemas

```typescript
const BaseEntitySchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const TaskDataSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000),
  priority: z.enum(["critical", "high", "medium", "low"]),
  assignedTo: z.string().uuid().optional(),
});

// Merge combines all fields from both schemas
const TaskSchema = BaseEntitySchema.merge(TaskDataSchema);
type Task = z.infer<typeof TaskSchema>;
// { id, createdAt, updatedAt, title, description, priority, assignedTo }
```

### Extend: Adding Fields to a Schema

```typescript
const AgentResponseSchema = z.object({
  status: z.enum(["success", "failure"]),
  data: z.unknown(),
});

// Extend adds fields to an existing schema
const DetailedResponseSchema = AgentResponseSchema.extend({
  errorMessage: z.string().optional(),
  retryable: z.boolean().default(false),
  tokenUsage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
});

type DetailedResponse = z.infer<typeof DetailedResponseSchema>;
```

### Pick and Omit: Selecting Fields

```typescript
const FullUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  name: z.string(),
  hashedPassword: z.string(),
  role: z.enum(["admin", "user", "agent"]),
  createdAt: z.string().datetime(),
});

// Pick: only include specified fields (for agent-visible data)
const PublicUserSchema = FullUserSchema.pick({
  id: true,
  name: true,
  role: true,
});

// Omit: exclude specified fields (remove sensitive data)
const SafeUserSchema = FullUserSchema.omit({
  hashedPassword: true,
});

// Use pick/omit to control what crosses agent boundaries
// Never send hashedPassword to an agent
```

### Partial and Required

```typescript
const TaskUpdateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000),
  priority: z.enum(["critical", "high", "medium", "low"]),
  status: z.enum(["pending", "in_progress", "completed"]),
});

// Partial: all fields become optional (for PATCH-style updates)
const TaskPatchSchema = TaskUpdateSchema.partial();
// { title?: string, description?: string, ... }

// Required: all fields become required
const TaskCreateSchema = TaskUpdateSchema.required();
// Useful when a schema has optional fields but creation needs all of them
```

## Versioned Schemas for Backward Compatibility

When agent schemas evolve, you need backward compatibility. Old agents may
still produce v1 data while new agents expect v2.

```typescript
// Version 1: original schema
const TaskResultV1Schema = z.object({
  version: z.literal(1),
  taskId: z.string().uuid(),
  status: z.enum(["completed", "failed"]),
  summary: z.string(),
});

// Version 2: added score and artifacts
const TaskResultV2Schema = z.object({
  version: z.literal(2),
  taskId: z.string().uuid(),
  status: z.enum(["completed", "failed", "partial"]),
  summary: z.string(),
  score: z.number().min(0).max(100),
  artifacts: z.array(z.string().url()).default([]),
});

// Versioned union: accepts either version
const TaskResultSchema = z.discriminatedUnion("version", [
  TaskResultV1Schema,
  TaskResultV2Schema,
]);

type TaskResult = z.infer<typeof TaskResultSchema>;

// Migration function: upgrade v1 to v2
function migrateTaskResult(result: TaskResult): z.infer<typeof TaskResultV2Schema> {
  if (result.version === 2) {
    return result;
  }
  return {
    ...result,
    version: 2 as const,
    status: result.status === "completed" ? "completed" : "failed",
    score: result.status === "completed" ? 100 : 0,
    artifacts: [],
  };
}
```

### Schema Registry

```typescript
// Central registry for all schemas used across agents
const SchemaRegistry = {
  "task.result": {
    current: TaskResultV2Schema,
    versions: {
      1: TaskResultV1Schema,
      2: TaskResultV2Schema,
    },
    migrate: migrateTaskResult,
  },
  "agent.message": {
    current: AgentMessageSchema,
    versions: {
      1: AgentMessageSchema,
    },
    migrate: (msg: z.infer<typeof AgentMessageSchema>) => msg,
  },
} as const;

// Lookup and validate with automatic migration
function validateWithMigration<K extends keyof typeof SchemaRegistry>(
  schemaKey: K,
  data: unknown,
): z.infer<(typeof SchemaRegistry)[K]["current"]> {
  const entry = SchemaRegistry[schemaKey];

  // Try current version first
  const currentResult = entry.current.safeParse(data);
  if (currentResult.success) {
    return currentResult.data;
  }

  // Try older versions and migrate
  for (const [, versionSchema] of Object.entries(entry.versions)) {
    const versionResult = (versionSchema as z.ZodType).safeParse(data);
    if (versionResult.success) {
      return entry.migrate(versionResult.data as never);
    }
  }

  throw new Error(
    `Data does not match any version of schema "${schemaKey}": ` +
    currentResult.error.message
  );
}
```

## Validation Patterns

### parse vs safeParse

```typescript
const InputSchema = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().min(1).max(50),
});

// parse: throws ZodError on failure
// Use when invalid data should halt execution
function strictValidation(input: unknown) {
  const validated = InputSchema.parse(input); // throws if invalid
  return validated;
}

// safeParse: returns { success, data?, error? }
// Use when you want to handle errors gracefully
function gracefulValidation(input: unknown) {
  const result = InputSchema.safeParse(input);
  if (!result.success) {
    return {
      valid: false,
      errors: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })),
    };
  }
  return { valid: true, data: result.data };
}
```

### Error Formatting

```typescript
import { z } from "zod";

// Custom error formatting for agent-friendly error messages
function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "root";
      return `[${path}] ${issue.message} (${issue.code})`;
    })
    .join("\n");
}

// Example usage in agent boundary validation
function validateAgentInput(schema: z.ZodType, input: unknown): {
  valid: boolean;
  data?: unknown;
  errorReport?: string;
} {
  const result = schema.safeParse(input);
  if (result.success) {
    return { valid: true, data: result.data };
  }
  return {
    valid: false,
    errorReport: formatZodError(result.error),
  };
}

// Produces clear, structured error messages:
// [query] String must contain at least 1 character(s) (too_small)
// [maxResults] Expected number, received string (invalid_type)
```

### Custom Refinements

```typescript
// Refinements add custom validation logic
const DateRangeSchema = z.object({
  startDate: z.string().datetime(),
  endDate: z.string().datetime(),
}).refine(
  (data) => new Date(data.endDate) > new Date(data.startDate),
  { message: "endDate must be after startDate", path: ["endDate"] }
);

// Transform: validate and transform in one step
const ConfidenceInputSchema = z
  .union([z.number(), z.string()])
  .transform((val) => {
    const num = typeof val === "string" ? parseFloat(val) : val;
    if (isNaN(num) || num < 0 || num > 1) {
      throw new Error("Confidence must be a number between 0 and 1");
    }
    return num;
  });

// Coercion: automatically convert types
const CoercedInputSchema = z.object({
  count: z.coerce.number().int().nonnegative(),
  active: z.coerce.boolean(),
  createdAt: z.coerce.date(),
});
```

## Schema Evolution Strategies

### Strategy 1: Additive Changes (Non-Breaking)

```typescript
// Adding optional fields is always safe
const V1 = z.object({ name: z.string() });
const V2 = V1.extend({ email: z.string().email().optional() });
// V1 data passes V2 validation (email defaults to undefined)
```

### Strategy 2: Default Values (Non-Breaking)

```typescript
// Adding fields with defaults is safe
const V1 = z.object({ name: z.string() });
const V2 = V1.extend({ role: z.enum(["user", "admin"]).default("user") });
// V1 data passes V2 validation (role defaults to "user")
```

### Strategy 3: Widening Types (Non-Breaking)

```typescript
// Accepting more values is safe
const V1Status = z.enum(["active", "inactive"]);
const V2Status = z.enum(["active", "inactive", "suspended"]);
// All V1 values are valid V2 values
```

### Strategy 4: Breaking Changes (Requires Migration)

```typescript
// Renaming fields, narrowing types, or removing fields requires migration
const V1 = z.object({
  userName: z.string(), // renamed to 'name' in V2
  age: z.number(),      // removed in V2
});

const V2 = z.object({
  name: z.string(),
  birthYear: z.number().int(), // replaced 'age'
});

// Migration function handles the transformation
function migrateV1ToV2(v1: z.infer<typeof V1>): z.infer<typeof V2> {
  const currentYear = new Date().getFullYear();
  return {
    name: v1.userName,
    birthYear: currentYear - v1.age,
  };
}
```

## Runtime Validation at Agent Boundaries

### Boundary Validator

```typescript
import { z } from "zod";

// Generic boundary validator for any agent
function createBoundaryValidator<TInput, TOutput>(config: {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
}) {
  return {
    validateInput(raw: unknown): TInput {
      const result = config.inputSchema.safeParse(raw);
      if (!result.success) {
        throw new BoundaryValidationError(
          `Agent "${config.name}" received invalid input`,
          result.error,
          "input"
        );
      }
      return result.data;
    },

    validateOutput(raw: unknown): TOutput {
      const result = config.outputSchema.safeParse(raw);
      if (!result.success) {
        throw new BoundaryValidationError(
          `Agent "${config.name}" produced invalid output`,
          result.error,
          "output"
        );
      }
      return result.data;
    },
  };
}

class BoundaryValidationError extends Error {
  constructor(
    message: string,
    public readonly zodError: z.ZodError,
    public readonly boundary: "input" | "output",
  ) {
    super(`${message}: ${zodError.issues.map(i => i.message).join(", ")}`);
    this.name = "BoundaryValidationError";
  }
}
```

### Applying Boundary Validation

```typescript
// Define schemas for a code review agent
const CodeReviewInputSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    language: z.enum(["typescript", "javascript", "python", "go"]),
  })).min(1).max(50),
  context: z.string().max(2000).optional(),
  reviewType: z.enum(["security", "performance", "quality", "all"]),
});

const CodeReviewOutputSchema = z.object({
  findings: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive(),
    severity: z.enum(["critical", "high", "medium", "low", "info"]),
    category: z.string(),
    message: z.string(),
    suggestedFix: z.string().optional(),
  })),
  overallScore: z.number().min(0).max(100),
  summary: z.string().max(3000),
  reviewedAt: z.string().datetime(),
});

const codeReviewValidator = createBoundaryValidator({
  name: "code-review",
  inputSchema: CodeReviewInputSchema,
  outputSchema: CodeReviewOutputSchema,
});

// Usage in agent wrapper
async function runCodeReview(rawInput: unknown): Promise<z.infer<typeof CodeReviewOutputSchema>> {
  const input = codeReviewValidator.validateInput(rawInput);

  // Agent processes the validated input...
  const rawOutput = await callLLM(input);

  const output = codeReviewValidator.validateOutput(rawOutput);
  return output;
}
```

## Code Examples

### Task Handoff Schema

```typescript
const TaskHandoffSchema = z.object({
  // Identity
  taskId: z.string().uuid(),
  correlationId: z.string().uuid(),

  // Routing
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),

  // Task definition
  task: z.object({
    type: z.string().min(1),
    description: z.string().max(5000),
    inputs: z.record(z.string(), z.unknown()),
    constraints: z.object({
      maxTokens: z.number().int().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
      requiredOutputFields: z.array(z.string()).optional(),
    }).optional(),
  }),

  // Context from previous agents
  priorResults: z.array(z.object({
    agentName: z.string(),
    summary: z.string(),
    data: z.unknown(),
    completedAt: z.string().datetime(),
  })).default([]),

  // Metadata
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  createdAt: z.string().datetime(),
  deadline: z.string().datetime().optional(),
});

type TaskHandoff = z.infer<typeof TaskHandoffSchema>;
```

### Agent Output Schema

```typescript
const AgentOutputSchema = z.object({
  // Execution metadata
  agentName: z.string().min(1),
  taskId: z.string().uuid(),
  executionId: z.string().uuid(),

  // Result
  status: z.enum(["success", "partial_success", "failure"]),
  result: z.object({
    data: z.unknown(),
    summary: z.string().max(3000),
    confidence: z.number().min(0).max(1),
    artifacts: z.array(z.object({
      type: z.enum(["text", "code", "json", "url"]),
      content: z.string(),
      label: z.string().optional(),
    })).default([]),
  }),

  // Error information (present when status is not "success")
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }).optional(),

  // Performance
  metrics: z.object({
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    tokensUsed: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }),
    llmCalls: z.number().int().nonnegative(),
  }),
});

type AgentOutput = z.infer<typeof AgentOutputSchema>;
```

### Shared State Schema

```typescript
const WorkflowStateSchema = z.object({
  // Identity
  workflowId: z.string().uuid(),
  version: z.number().int().nonnegative(),

  // Status
  status: z.enum([
    "initialized",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ]),

  // Task tracking
  tasks: z.record(
    z.string(), // taskId
    z.object({
      status: z.enum(["pending", "assigned", "running", "completed", "failed"]),
      assignedTo: z.string().optional(),
      result: z.unknown().optional(),
      attempts: z.number().int().nonnegative().default(0),
      lastAttemptAt: z.string().datetime().optional(),
    })
  ),

  // Shared context accessible to all agents
  sharedContext: z.record(z.string(), z.unknown()),

  // Audit trail
  history: z.array(z.object({
    timestamp: z.string().datetime(),
    agent: z.string(),
    action: z.string(),
    details: z.unknown().optional(),
  })),

  // Metadata
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

type WorkflowState = z.infer<typeof WorkflowStateSchema>;
```

## Summary

Typed schemas with Zod are the foundation of reliable multi-agent systems.
They provide:

1. **Runtime validation** — catches data errors at agent boundaries
2. **Single source of truth** — schema IS the type IS the validator
3. **Composability** — merge, extend, pick, omit for schema reuse
4. **Evolution** — versioned schemas with migration paths
5. **Clear errors** — structured error messages for debugging
6. **Boundary enforcement** — every agent validates input and output

The rule is simple: if data crosses an agent boundary, it has a Zod schema.
No exceptions.
