/**
 * Typed Data Schemas for Agent Boundaries
 *
 * Zod schemas that define the data contracts between agents.
 * All data flowing across agent boundaries must conform to these schemas.
 * Uses immutable patterns throughout - no object mutation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitive building blocks
// ---------------------------------------------------------------------------

const AgentId = z.string().min(1).describe("Unique identifier for an agent");
const TaskId = z.string().uuid().describe("UUID for task tracking");
const Timestamp = z.string().datetime().describe("ISO-8601 timestamp");

const Priority = z.enum(["critical", "high", "medium", "low"]);
type Priority = z.infer<typeof Priority>;

// ---------------------------------------------------------------------------
// ErrorReport – structured error passed between agents
// ---------------------------------------------------------------------------

export const ErrorReport = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  source: AgentId,
  timestamp: Timestamp,
  retryable: z.boolean(),
  context: z.record(z.unknown()).optional(),
  stack: z.string().optional(),
});

export type ErrorReport = z.infer<typeof ErrorReport>;

// ---------------------------------------------------------------------------
// AgentOutput – standardized response every agent must return
// ---------------------------------------------------------------------------

export const AgentOutput = z.object({
  agentId: AgentId,
  taskId: TaskId,
  status: z.enum(["success", "partial", "failure"]),
  data: z.unknown().optional(),
  errors: z.array(ErrorReport).default([]),
  metadata: z.record(z.string()).default({}),
  completedAt: Timestamp,
});

export type AgentOutput = z.infer<typeof AgentOutput>;

// ---------------------------------------------------------------------------
// TaskHandoff – data passed when one agent delegates to another
// ---------------------------------------------------------------------------

export const TaskHandoff = z.object({
  taskId: TaskId,
  sourceAgent: AgentId,
  targetAgent: AgentId,
  priority: Priority,
  payload: z.unknown(),
  instructions: z.string().min(1),
  deadline: Timestamp.optional(),
  parentTaskId: TaskId.optional(),
  createdAt: Timestamp,
  attempt: z.number().int().nonneg().default(0),
});

export type TaskHandoff = z.infer<typeof TaskHandoff>;

// ---------------------------------------------------------------------------
// Schema composition – merge & extend
// ---------------------------------------------------------------------------

/** Extend TaskHandoff with audit fields for compliance-sensitive workflows. */
export const AuditedTaskHandoff = TaskHandoff.merge(
  z.object({
    initiatedBy: z.string().email(),
    approvalRef: z.string().min(1).optional(),
    classification: z.enum(["public", "internal", "confidential"]),
  })
);

export type AuditedTaskHandoff = z.infer<typeof AuditedTaskHandoff>;

/** Extend AgentOutput with timing information. */
export const TimedAgentOutput = AgentOutput.extend({
  startedAt: Timestamp,
  durationMs: z.number().nonneg(),
});

export type TimedAgentOutput = z.infer<typeof TimedAgentOutput>;

// ---------------------------------------------------------------------------
// Versioned schema pattern
// ---------------------------------------------------------------------------

/**
 * Wraps any schema in a versioned envelope so consumers can detect
 * incompatible payloads without crashing.
 */
export function versioned<T extends z.ZodTypeAny>(
  version: number,
  schema: T
) {
  return z.object({
    schemaVersion: z.literal(version),
    payload: schema,
  });
}

/** Example: version 1 of the handoff schema. */
export const TaskHandoffV1 = versioned(1, TaskHandoff);
export type TaskHandoffV1 = z.infer<typeof TaskHandoffV1>;

// ---------------------------------------------------------------------------
// Parse helpers – safe wrappers around Zod parsing
// ---------------------------------------------------------------------------

/**
 * Strictly parse unknown data against a schema.
 * Throws a descriptive ZodError on failure.
 */
export function parseStrict<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): z.infer<T> {
  return schema.parse(data);
}

/**
 * Safely parse unknown data, returning a discriminated result
 * instead of throwing. Callers can pattern-match on `success`.
 */
export function parseSafe<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown
): z.SafeParseReturnType<unknown, z.infer<T>> {
  return schema.safeParse(data);
}

// ---------------------------------------------------------------------------
// Usage examples (illustrative, not executed at import time)
// ---------------------------------------------------------------------------

export function exampleUsage(): void {
  // --- strict parse ---
  const handoff = parseStrict(TaskHandoff, {
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    sourceAgent: "planner",
    targetAgent: "researcher",
    priority: "high",
    payload: { query: "multi-agent best practices" },
    instructions: "Research and summarize top 5 patterns",
    createdAt: new Date().toISOString(),
  });

  // TypeScript knows `handoff` is TaskHandoff
  console.info("Parsed handoff for task:", handoff.taskId);

  // --- safe parse ---
  const result = parseSafe(AgentOutput, { invalid: true });
  if (!result.success) {
    console.error("Validation failed:", result.error.flatten());
  }

  // --- versioned parse ---
  const v1Result = parseSafe(TaskHandoffV1, {
    schemaVersion: 1,
    payload: handoff,
  });
  if (v1Result.success) {
    console.info("Versioned payload OK");
  }
}
