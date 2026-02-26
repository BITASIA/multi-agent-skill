/**
 * Discriminated Union Action Schemas
 *
 * Actions are the verbs of a multi-agent system. Every request from one
 * agent to another is modeled as an Action with a discriminant `type` field.
 * Exhaustive handlers guarantee every action variant is covered at compile time.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Base action fields shared by every action variant
// ---------------------------------------------------------------------------

const BaseAction = z.object({
  id: z.string().uuid(),
  timestamp: z.string().datetime(),
  correlationId: z.string().uuid(),
  initiator: z.string().min(1),
});

// ---------------------------------------------------------------------------
// CRUD actions
// ---------------------------------------------------------------------------

const CreateAction = BaseAction.extend({
  type: z.literal("create"),
  resource: z.string().min(1),
  payload: z.record(z.unknown()),
});

const ReadAction = BaseAction.extend({
  type: z.literal("read"),
  resource: z.string().min(1),
  filters: z.record(z.unknown()).default({}),
});

const UpdateAction = BaseAction.extend({
  type: z.literal("update"),
  resource: z.string().min(1),
  resourceId: z.string().min(1),
  patch: z.record(z.unknown()),
});

const DeleteAction = BaseAction.extend({
  type: z.literal("delete"),
  resource: z.string().min(1),
  resourceId: z.string().min(1),
  soft: z.boolean().default(true),
});

export const CrudAction = z.discriminatedUnion("type", [
  CreateAction,
  ReadAction,
  UpdateAction,
  DeleteAction,
]);

export type CrudAction = z.infer<typeof CrudAction>;

// ---------------------------------------------------------------------------
// Workflow actions
// ---------------------------------------------------------------------------

const StartAction = BaseAction.extend({
  type: z.literal("start"),
  workflowId: z.string().uuid(),
  input: z.unknown(),
});

const PauseAction = BaseAction.extend({
  type: z.literal("pause"),
  workflowId: z.string().uuid(),
  reason: z.string().min(1),
});

const ResumeAction = BaseAction.extend({
  type: z.literal("resume"),
  workflowId: z.string().uuid(),
});

const CancelAction = BaseAction.extend({
  type: z.literal("cancel"),
  workflowId: z.string().uuid(),
  reason: z.string().min(1),
});

const CompleteAction = BaseAction.extend({
  type: z.literal("complete"),
  workflowId: z.string().uuid(),
  result: z.unknown(),
});

export const WorkflowAction = z.discriminatedUnion("type", [
  StartAction,
  PauseAction,
  ResumeAction,
  CancelAction,
  CompleteAction,
]);

export type WorkflowAction = z.infer<typeof WorkflowAction>;

// ---------------------------------------------------------------------------
// Escalation actions
// ---------------------------------------------------------------------------

const RetryAction = BaseAction.extend({
  type: z.literal("retry"),
  originalActionId: z.string().uuid(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
});

const FallbackAction = BaseAction.extend({
  type: z.literal("fallback"),
  originalActionId: z.string().uuid(),
  fallbackStrategy: z.string().min(1),
  context: z.record(z.unknown()).default({}),
});

const HumanEscalateAction = BaseAction.extend({
  type: z.literal("human-escalate"),
  originalActionId: z.string().uuid(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1),
  suggestedAction: z.string().optional(),
});

export const EscalationAction = z.discriminatedUnion("type", [
  RetryAction,
  FallbackAction,
  HumanEscalateAction,
]);

export type EscalationAction = z.infer<typeof EscalationAction>;

// ---------------------------------------------------------------------------
// Action result – returned after any action is executed
// ---------------------------------------------------------------------------

export const ActionResult = z.object({
  actionId: z.string().uuid(),
  status: z.enum(["accepted", "completed", "rejected", "failed"]),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  completedAt: z.string().datetime(),
});

export type ActionResult = z.infer<typeof ActionResult>;

// ---------------------------------------------------------------------------
// Validate-then-execute helper
// ---------------------------------------------------------------------------

/**
 * Validates an action against its schema before passing it to the handler.
 * Returns an ActionResult shaped object so callers get a uniform interface.
 */
export function validateAndExecute<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
  handler: (action: z.infer<T>) => ActionResult
): ActionResult {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      actionId: (raw as Record<string, unknown>)?.id as string ?? "unknown",
      status: "rejected",
      error: {
        code: "VALIDATION_ERROR",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
      completedAt: new Date().toISOString(),
    };
  }
  return handler(parsed.data);
}

// ---------------------------------------------------------------------------
// Exhaustive CRUD action handler (compile-time completeness check)
// ---------------------------------------------------------------------------

/**
 * Demonstrates exhaustive handling of every CRUD variant.
 * The `never` default ensures TypeScript errors if a variant is added
 * but not handled.
 */
export function handleCrudAction(action: CrudAction): string {
  switch (action.type) {
    case "create":
      return `Creating ${action.resource}`;
    case "read":
      return `Reading ${action.resource}`;
    case "update":
      return `Updating ${action.resource}/${action.resourceId}`;
    case "delete":
      return `Deleting ${action.resource}/${action.resourceId}`;
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled action type: ${(_exhaustive as CrudAction).type}`);
    }
  }
}

/**
 * Exhaustive handler for escalation actions.
 */
export function handleEscalation(action: EscalationAction): string {
  switch (action.type) {
    case "retry":
      return `Retrying action ${action.originalActionId} (attempt ${action.attempt}/${action.maxAttempts})`;
    case "fallback":
      return `Falling back with strategy: ${action.fallbackStrategy}`;
    case "human-escalate":
      return `Escalating to human – severity: ${action.severity}`;
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unhandled escalation: ${(_exhaustive as EscalationAction).type}`);
    }
  }
}
