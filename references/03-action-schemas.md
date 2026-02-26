# Action Schemas: Constraining Agent Behavior

## Why Agents Need Constrained Action Spaces

An unconstrained agent can produce any action. "Send an email." "Delete the
database." "Approve the PR." Without a defined action space, there is no way
to validate, route, or handle what an agent decides to do.

Constrained action spaces provide:
- **Exhaustive handling** — every possible action has a handler
- **Compile-time safety** — TypeScript catches unhandled action types
- **Runtime validation** — Zod ensures action payloads are well-formed
- **Auditability** — every action is structured and loggable
- **Security** — agents cannot invent actions outside the allowed set

```typescript
// UNCONSTRAINED: agent can produce anything
const action = await agent.run(input);
// action = { do: "something", with: "unknown shape" }
// How do you route this? Validate it? Handle every case?

// CONSTRAINED: agent produces one of N defined actions
const action = ActionSchema.parse(await agent.run(input));
// action.type is "approve" | "reject" | "escalate"
// Every type has a defined payload. Every type has a handler.
```

## Discriminated Unions in TypeScript/Zod

A discriminated union is a union of object types that share a common
"discriminator" field (usually `type`). Each variant has a unique literal
value for the discriminator and its own specific fields.

```typescript
import { z } from "zod";

// Each action variant is a separate schema with a literal `type`
const ApproveAction = z.object({
  type: z.literal("approve"),
  taskId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  approvedBy: z.string().min(1),
});

const RejectAction = z.object({
  type: z.literal("reject"),
  taskId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  rejectedBy: z.string().min(1),
  suggestedFixes: z.array(z.string()).min(1),
});

const EscalateAction = z.object({
  type: z.literal("escalate"),
  taskId: z.string().uuid(),
  escalateTo: z.enum(["senior_agent", "team_lead", "human"]),
  urgency: z.enum(["low", "medium", "high", "critical"]),
  context: z.string().min(1).max(2000),
});

const RequestInfoAction = z.object({
  type: z.literal("request_info"),
  taskId: z.string().uuid(),
  questions: z.array(z.string().min(1)).min(1).max(5),
  blockedUntilResolved: z.boolean().default(true),
});

// The discriminated union: one schema to rule them all
const ReviewActionSchema = z.discriminatedUnion("type", [
  ApproveAction,
  RejectAction,
  EscalateAction,
  RequestInfoAction,
]);

type ReviewAction = z.infer<typeof ReviewActionSchema>;
```

### Why discriminatedUnion Over Regular union

```typescript
// z.union tries every schema in order — slow and error messages are poor
const badUnion = z.union([ApproveAction, RejectAction, EscalateAction]);
// Error: "Invalid input" — unhelpful

// z.discriminatedUnion checks the discriminator first — fast and clear
const goodUnion = z.discriminatedUnion("type", [
  ApproveAction,
  RejectAction,
  EscalateAction,
]);
// Error: "Invalid discriminator value. Expected 'approve' | 'reject' |
//         'escalate', received 'update'" — actionable
```

## Action Schema Design Patterns

### Pattern 1: Domain-Specific Actions

Group actions by domain. Each domain has its own action schema.

```typescript
// Document management actions
const DocumentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_document"),
    title: z.string().min(1).max(200),
    content: z.string(),
    tags: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("update_document"),
    documentId: z.string().uuid(),
    changes: z.object({
      title: z.string().min(1).max(200).optional(),
      content: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }),
  }),
  z.object({
    type: z.literal("delete_document"),
    documentId: z.string().uuid(),
    reason: z.string().min(1),
    softDelete: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("archive_document"),
    documentId: z.string().uuid(),
    archiveReason: z.enum(["outdated", "superseded", "completed"]),
  }),
]);

type DocumentAction = z.infer<typeof DocumentActionSchema>;
```

### Pattern 2: Actions with Results

Pair each action with its expected result type.

```typescript
// Action-Result pairs
const ActionResultMap = {
  create_document: z.object({
    documentId: z.string().uuid(),
    createdAt: z.string().datetime(),
    url: z.string().url(),
  }),
  update_document: z.object({
    documentId: z.string().uuid(),
    updatedAt: z.string().datetime(),
    version: z.number().int().positive(),
  }),
  delete_document: z.object({
    documentId: z.string().uuid(),
    deletedAt: z.string().datetime(),
    recoverable: z.boolean(),
  }),
  archive_document: z.object({
    documentId: z.string().uuid(),
    archivedAt: z.string().datetime(),
  }),
} as const;

// Type-safe result lookup
type ActionType = DocumentAction["type"];

function getResultSchema(actionType: ActionType) {
  return ActionResultMap[actionType];
}
```

### Pattern 3: Permission-Gated Actions

Some actions require elevated permissions.

```typescript
const PermissionLevel = z.enum(["read", "write", "admin", "system"]);

const GatedActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read_data"),
    resourceId: z.string().uuid(),
    requiredPermission: z.literal("read").default("read"),
  }),
  z.object({
    type: z.literal("modify_data"),
    resourceId: z.string().uuid(),
    changes: z.record(z.string(), z.unknown()),
    requiredPermission: z.literal("write").default("write"),
  }),
  z.object({
    type: z.literal("delete_resource"),
    resourceId: z.string().uuid(),
    requiredPermission: z.literal("admin").default("admin"),
  }),
  z.object({
    type: z.literal("system_override"),
    command: z.string(),
    requiredPermission: z.literal("system").default("system"),
  }),
]);

type GatedAction = z.infer<typeof GatedActionSchema>;

// Validate permissions before execution
function checkPermission(
  action: GatedAction,
  agentPermissions: z.infer<typeof PermissionLevel>[],
): boolean {
  const levels: Record<string, number> = {
    read: 1,
    write: 2,
    admin: 3,
    system: 4,
  };
  const required = levels[action.requiredPermission] ?? 0;
  const highest = Math.max(
    ...agentPermissions.map((p) => levels[p] ?? 0)
  );
  return highest >= required;
}
```

## Exhaustive Action Handling

TypeScript's `never` type ensures every action variant is handled.

```typescript
// Exhaustive switch with TypeScript's never check
function executeAction(action: ReviewAction): string {
  switch (action.type) {
    case "approve":
      return `Task ${action.taskId} approved by ${action.approvedBy}`;
    case "reject":
      return `Task ${action.taskId} rejected: ${action.suggestedFixes.join(", ")}`;
    case "escalate":
      return `Task ${action.taskId} escalated to ${action.escalateTo}`;
    case "request_info":
      return `Task ${action.taskId}: ${action.questions.length} questions pending`;
    default: {
      // TypeScript error if any case is missing
      const exhaustiveCheck: never = action;
      throw new Error(`Unhandled action type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

// Helper function for exhaustive checks
function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}

// Cleaner version
function executeActionClean(action: ReviewAction): string {
  switch (action.type) {
    case "approve":
      return `Approved: ${action.reason}`;
    case "reject":
      return `Rejected: ${action.reason}`;
    case "escalate":
      return `Escalated to ${action.escalateTo}`;
    case "request_info":
      return `Questions: ${action.questions.join("; ")}`;
    default:
      return assertNever(action);
  }
}
```

## Action Validation Before Execution

Validate actions against the current system state before executing them.

```typescript
type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

// Pre-execution validators for each action type
const actionValidators: Record<
  ReviewAction["type"],
  (action: ReviewAction, state: WorkflowState) => ValidationResult
> = {
  approve: (action, state) => {
    if (action.type !== "approve") return { valid: false, reason: "Type mismatch" };
    const task = state.tasks[action.taskId];
    if (!task) return { valid: false, reason: `Task ${action.taskId} not found` };
    if (task.status !== "running") {
      return { valid: false, reason: `Task is ${task.status}, not running` };
    }
    return { valid: true };
  },
  reject: (action, state) => {
    if (action.type !== "reject") return { valid: false, reason: "Type mismatch" };
    const task = state.tasks[action.taskId];
    if (!task) return { valid: false, reason: `Task ${action.taskId} not found` };
    if (task.status !== "running") {
      return { valid: false, reason: `Task is ${task.status}, not running` };
    }
    return { valid: true };
  },
  escalate: (action, state) => {
    if (action.type !== "escalate") return { valid: false, reason: "Type mismatch" };
    const task = state.tasks[action.taskId];
    if (!task) return { valid: false, reason: `Task ${action.taskId} not found` };
    if (task.attempts < 1) {
      return { valid: false, reason: "Must attempt task before escalating" };
    }
    return { valid: true };
  },
  request_info: (action, state) => {
    if (action.type !== "request_info") return { valid: false, reason: "Type mismatch" };
    const task = state.tasks[action.taskId];
    if (!task) return { valid: false, reason: `Task ${action.taskId} not found` };
    return { valid: true };
  },
};

interface WorkflowState {
  tasks: Record<string, { status: string; attempts: number }>;
}

// Execute with validation
async function executeValidatedAction(
  rawAction: unknown,
  state: WorkflowState,
): Promise<{ success: boolean; result?: string; error?: string }> {
  // Step 1: Schema validation
  const parseResult = ReviewActionSchema.safeParse(rawAction);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid action schema: ${parseResult.error.message}`,
    };
  }

  const action = parseResult.data;

  // Step 2: Business logic validation
  const validator = actionValidators[action.type];
  const validation = validator(action, state);
  if (!validation.valid) {
    return { success: false, error: `Validation failed: ${validation.reason}` };
  }

  // Step 3: Execute
  try {
    const result = executeAction(action);
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: `Execution failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
```

## Action Composition

### Sequences: Ordered Actions

```typescript
const ActionSequenceSchema = z.object({
  sequenceId: z.string().uuid(),
  actions: z.array(ReviewActionSchema).min(1).max(20),
  executionMode: z.literal("sequential"),
  stopOnFailure: z.boolean().default(true),
});

type ActionSequence = z.infer<typeof ActionSequenceSchema>;

// Execute actions in order, collecting results
async function executeSequence(
  sequence: ActionSequence,
  state: WorkflowState,
): Promise<Array<{ action: ReviewAction; result: string; success: boolean }>> {
  const results: Array<{ action: ReviewAction; result: string; success: boolean }> = [];

  for (const action of sequence.actions) {
    const outcome = await executeValidatedAction(action, state);
    results.push({
      action,
      result: outcome.result ?? outcome.error ?? "Unknown",
      success: outcome.success,
    });

    if (!outcome.success && sequence.stopOnFailure) {
      break;
    }
  }

  return results;
}
```

### Alternatives: Fallback Actions

```typescript
const ActionAlternativesSchema = z.object({
  alternativesId: z.string().uuid(),
  primary: ReviewActionSchema,
  fallbacks: z.array(ReviewActionSchema).min(1).max(5),
  description: z.string(),
});

type ActionAlternatives = z.infer<typeof ActionAlternativesSchema>;

// Try primary action, fall back to alternatives on failure
async function executeWithFallbacks(
  alternatives: ActionAlternatives,
  state: WorkflowState,
): Promise<{ action: ReviewAction; result: string; attemptIndex: number }> {
  const allActions = [alternatives.primary, ...alternatives.fallbacks];

  for (let i = 0; i < allActions.length; i++) {
    const outcome = await executeValidatedAction(allActions[i], state);
    if (outcome.success) {
      return {
        action: allActions[i],
        result: outcome.result ?? "",
        attemptIndex: i,
      };
    }
  }

  throw new Error(
    `All actions failed for alternatives: ${alternatives.description}`
  );
}
```

## CRUD Action Example

```typescript
import { z } from "zod";

// Generic CRUD action schema factory
function createCrudActionSchema<T extends string>(
  resource: T,
  fieldsSchema: z.ZodObject<z.ZodRawShape>,
) {
  return z.discriminatedUnion("type", [
    z.object({
      type: z.literal(`create_${resource}` as const),
      data: fieldsSchema,
    }),
    z.object({
      type: z.literal(`read_${resource}` as const),
      id: z.string().uuid(),
    }),
    z.object({
      type: z.literal(`update_${resource}` as const),
      id: z.string().uuid(),
      changes: fieldsSchema.partial(),
    }),
    z.object({
      type: z.literal(`delete_${resource}` as const),
      id: z.string().uuid(),
      reason: z.string().optional(),
    }),
  ]);
}

// Usage: create a CRUD schema for "ticket"
const TicketFieldsSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000),
  priority: z.enum(["critical", "high", "medium", "low"]),
  assignee: z.string().uuid().optional(),
});

const TicketActionSchema = createCrudActionSchema("ticket", TicketFieldsSchema);
type TicketAction = z.infer<typeof TicketActionSchema>;

// The resulting type is:
// | { type: "create_ticket"; data: { title, description, priority, assignee? } }
// | { type: "read_ticket"; id: string }
// | { type: "update_ticket"; id: string; changes: Partial<...> }
// | { type: "delete_ticket"; id: string; reason?: string }
```

## Workflow Action Example

```typescript
const WorkflowActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start_workflow"),
    workflowId: z.string().uuid(),
    initialInput: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("pause_workflow"),
    workflowId: z.string().uuid(),
    reason: z.string(),
    resumeCondition: z.string().optional(),
  }),
  z.object({
    type: z.literal("resume_workflow"),
    workflowId: z.string().uuid(),
    additionalInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("cancel_workflow"),
    workflowId: z.string().uuid(),
    reason: z.string(),
    compensate: z.boolean().default(true),
  }),
  z.object({
    type: z.literal("retry_step"),
    workflowId: z.string().uuid(),
    stepId: z.string(),
    modifiedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("skip_step"),
    workflowId: z.string().uuid(),
    stepId: z.string(),
    justification: z.string().min(1),
  }),
]);

type WorkflowAction = z.infer<typeof WorkflowActionSchema>;
```

## The Action Pipeline: action -> validation -> execution -> result

```typescript
import { z } from "zod";

// The complete action pipeline
const ActionResultSchema = z.object({
  actionId: z.string().uuid(),
  action: ReviewActionSchema,
  validation: z.object({
    passed: z.boolean(),
    errors: z.array(z.string()).default([]),
    checkedAt: z.string().datetime(),
  }),
  execution: z.object({
    started: z.boolean(),
    completed: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
  }),
  timestamp: z.string().datetime(),
});

type ActionResult = z.infer<typeof ActionResultSchema>;

// Full pipeline execution
async function actionPipeline(
  rawAction: unknown,
  state: WorkflowState,
): Promise<ActionResult> {
  const actionId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Step 1: Parse action
  const parseResult = ReviewActionSchema.safeParse(rawAction);
  if (!parseResult.success) {
    return {
      actionId,
      action: rawAction as ReviewAction,
      validation: {
        passed: false,
        errors: parseResult.error.issues.map((i) => i.message),
        checkedAt: timestamp,
      },
      execution: { started: false, completed: false },
      timestamp,
    };
  }

  const action = parseResult.data;

  // Step 2: Validate against state
  const validator = actionValidators[action.type];
  const validation = validator(action, state);
  if (!validation.valid) {
    return {
      actionId,
      action,
      validation: {
        passed: false,
        errors: [validation.reason],
        checkedAt: timestamp,
      },
      execution: { started: false, completed: false },
      timestamp,
    };
  }

  // Step 3: Execute
  const startTime = Date.now();
  try {
    const result = executeAction(action);
    return {
      actionId,
      action,
      validation: { passed: true, errors: [], checkedAt: timestamp },
      execution: {
        started: true,
        completed: true,
        result,
        durationMs: Date.now() - startTime,
      },
      timestamp,
    };
  } catch (error) {
    return {
      actionId,
      action,
      validation: { passed: true, errors: [], checkedAt: timestamp },
      execution: {
        started: true,
        completed: false,
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startTime,
      },
      timestamp,
    };
  }
}
```

## Summary

Action schemas constrain agent behavior to a finite, typed, validated set
of actions. The key principles:

1. **Discriminated unions** define the action space
2. **Exhaustive handling** ensures every action has a handler
3. **Pre-execution validation** catches invalid actions before damage
4. **Action composition** enables sequences and fallbacks
5. **The pipeline pattern** (parse, validate, execute, record) provides
   a consistent execution model

Never let an agent produce an unconstrained action. The action space is
the agent's API contract with the rest of the system.
