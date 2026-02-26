/**
 * Standardized Event Envelope for Agent Communication
 *
 * Every message between agents is wrapped in an EventEnvelope.
 * The envelope carries routing metadata (correlation ID, source, target)
 * plus the typed event payload as a discriminated union.
 * All builder functions are immutable – they return new objects.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Event metadata – attached to every envelope
// ---------------------------------------------------------------------------

export const EventMetadata = z.object({
  /** Wall-clock time the event was created. */
  createdAt: z.string().datetime(),
  /** Monotonic sequence within a single producer (ordering hint). */
  sequenceNumber: z.number().int().nonneg().optional(),
  /** Free-form key/value pairs for tracing, feature flags, etc. */
  tags: z.record(z.string()).default({}),
  /** TTL in milliseconds; consumers may discard stale events. */
  ttlMs: z.number().int().positive().optional(),
});

export type EventMetadata = z.infer<typeof EventMetadata>;

// ---------------------------------------------------------------------------
// Event type discriminated union
// ---------------------------------------------------------------------------

const TaskAssigned = z.object({
  type: z.literal("task.assigned"),
  taskId: z.string().uuid(),
  payload: z.unknown(),
});

const TaskCompleted = z.object({
  type: z.literal("task.completed"),
  taskId: z.string().uuid(),
  result: z.unknown(),
});

const TaskFailed = z.object({
  type: z.literal("task.failed"),
  taskId: z.string().uuid(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const StateChanged = z.object({
  type: z.literal("state.changed"),
  stateId: z.string().uuid(),
  previousPhase: z.string(),
  newPhase: z.string(),
});

const HeartbeatEvent = z.object({
  type: z.literal("system.heartbeat"),
  uptimeMs: z.number().nonneg(),
  load: z.number().nonneg().optional(),
});

export const EventPayload = z.discriminatedUnion("type", [
  TaskAssigned,
  TaskCompleted,
  TaskFailed,
  StateChanged,
  HeartbeatEvent,
]);

export type EventPayload = z.infer<typeof EventPayload>;

// ---------------------------------------------------------------------------
// EventEnvelope – the top-level wrapper
// ---------------------------------------------------------------------------

export const EventEnvelope = z.object({
  /** Globally unique event ID. */
  eventId: z.string().uuid(),
  /** Ties related events across a workflow for distributed tracing. */
  correlationId: z.string().uuid(),
  /** Optional parent event ID for causal chains. */
  causationId: z.string().uuid().optional(),
  /** Agent that produced this event. */
  sourceAgent: z.string().min(1),
  /** Intended recipient; "*" means broadcast. */
  targetAgent: z.string().min(1).default("*"),
  /** The typed event body. */
  payload: EventPayload,
  /** Envelope-level metadata. */
  metadata: EventMetadata,
});

export type EventEnvelope = z.infer<typeof EventEnvelope>;

// ---------------------------------------------------------------------------
// Serialization / deserialization
// ---------------------------------------------------------------------------

/**
 * Serialize an EventEnvelope to a JSON string.
 * Validates before serializing so only well-formed events leave the process.
 */
export function serializeEvent(envelope: EventEnvelope): string {
  const validated = EventEnvelope.parse(envelope);
  return JSON.stringify(validated);
}

/**
 * Deserialize and validate a JSON string into an EventEnvelope.
 * Returns a Zod SafeParseResult so callers decide how to handle errors.
 */
export function deserializeEvent(
  json: string
): z.SafeParseReturnType<unknown, EventEnvelope> {
  const raw: unknown = JSON.parse(json);
  return EventEnvelope.safeParse(raw);
}

// ---------------------------------------------------------------------------
// Immutable builder helpers
// ---------------------------------------------------------------------------

interface EnvelopeOptions {
  readonly eventId: string;
  readonly correlationId: string;
  readonly sourceAgent: string;
  readonly targetAgent?: string;
  readonly causationId?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly ttlMs?: number;
}

/**
 * Build a new EventEnvelope. Every call returns a fresh object.
 */
export function buildEnvelope(
  options: Readonly<EnvelopeOptions>,
  payload: EventPayload
): EventEnvelope {
  return EventEnvelope.parse({
    eventId: options.eventId,
    correlationId: options.correlationId,
    causationId: options.causationId,
    sourceAgent: options.sourceAgent,
    targetAgent: options.targetAgent ?? "*",
    payload,
    metadata: {
      createdAt: new Date().toISOString(),
      tags: { ...options.tags },
      ttlMs: options.ttlMs,
    },
  });
}

/**
 * Derive a reply envelope from an existing envelope.
 * Swaps source/target, keeps correlationId, sets causationId.
 */
export function buildReply(
  original: Readonly<EventEnvelope>,
  replyEventId: string,
  replySourceAgent: string,
  payload: EventPayload
): EventEnvelope {
  return buildEnvelope(
    {
      eventId: replyEventId,
      correlationId: original.correlationId,
      causationId: original.eventId,
      sourceAgent: replySourceAgent,
      targetAgent: original.sourceAgent,
    },
    payload
  );
}

/**
 * Add or override metadata tags on an envelope (immutable).
 */
export function withTags(
  envelope: Readonly<EventEnvelope>,
  newTags: Readonly<Record<string, string>>
): EventEnvelope {
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      tags: { ...envelope.metadata.tags, ...newTags },
    },
  };
}

/**
 * Set the target agent on an existing envelope (immutable).
 */
export function withTarget(
  envelope: Readonly<EventEnvelope>,
  targetAgent: string
): EventEnvelope {
  return { ...envelope, targetAgent };
}
