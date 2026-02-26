# Failure Modes Catalog

Each failure mode is documented with: description, symptoms, root cause,
prevention, detection, and recovery.

---

## 1. Schema Drift

### Description
The data shape produced by one agent gradually diverges from what downstream
agents expect. This happens when agents are updated independently without
coordinating schema changes.

### Symptoms
- Downstream agents receive `undefined` for expected fields
- Type coercion produces wrong values (e.g., `"42" + 1 = "421"`)
- Agents produce outputs with extra or missing fields
- Pipeline works in testing but fails with different agent versions

### Root Cause
No shared schema definition between agents. Each agent has its own
implicit assumption about data shapes. When one agent's output format
changes, downstream agents are not updated.

### Prevention
```typescript
import { z } from "zod";

// Single source of truth: shared schema package
// Both producer and consumer import from the same definition
const TaskResultSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["completed", "failed", "partial"]),
  score: z.number().min(0).max(100),
  summary: z.string(),
});

// Producer validates output
function produceResult(raw: unknown) {
  return TaskResultSchema.parse(raw); // Throws if shape changed
}

// Consumer validates input
function consumeResult(raw: unknown) {
  return TaskResultSchema.parse(raw); // Throws if shape changed
}
```

### Detection
```typescript
// Contract test: verify producer output matches consumer expectation
function testSchemaConformance(producerOutput: unknown): {
  conforms: boolean;
  errors: string[];
} {
  const result = TaskResultSchema.safeParse(producerOutput);
  if (result.success) {
    return { conforms: true, errors: [] };
  }
  return {
    conforms: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join(".")}: ${i.message}`,
    ),
  };
}
```

### Recovery
1. Identify which agent's output changed
2. Add versioned schemas (v1, v2) with migration
3. Update downstream agents to accept both versions
4. Migrate all agents to the new schema
5. Deprecate the old version

---

## 2. Action Ambiguity

### Description
An agent produces an action that the system cannot unambiguously route or
handle. The action type is vague, misspelled, or not in the known set.

### Symptoms
- Actions fall through to default/catch-all handlers
- Duplicate actions with slightly different names do different things
- Log entries show "unknown action type" warnings
- Intermittent behavior depending on LLM output variation

### Root Cause
Actions are free-form strings or untyped objects instead of a constrained
discriminated union.

### Prevention
```typescript
import { z } from "zod";

// Constrained action space — no room for ambiguity
const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve"), taskId: z.string().uuid() }),
  z.object({ type: z.literal("reject"), taskId: z.string().uuid(), reason: z.string() }),
  z.object({ type: z.literal("escalate"), taskId: z.string().uuid(), to: z.string() }),
]);

// Parsing rejects anything not in the set
// "approved", "APPROVE", "accept" all fail with clear error:
// "Invalid discriminator value. Expected 'approve' | 'reject' | 'escalate'"
```

### Detection
Log and alert on action parsing failures. A spike in parsing failures
indicates the agent is producing actions outside the constrained set.

### Recovery
1. Review the LLM prompt to ensure it lists valid actions explicitly
2. Add examples of valid actions to the prompt
3. Consider adding the invalid action to the schema if it represents
   a legitimate new capability

---

## 3. State Corruption

### Description
Shared state becomes inconsistent due to concurrent modifications,
partial updates, or invalid state transitions.

### Symptoms
- Task marked as "completed" but has no result
- Counter values are impossible (negative counts, counts exceeding total)
- State machine is in a state that has no valid transitions
- Different agents see contradictory views of the same data

### Root Cause
Mutable shared state without concurrency control. Multiple agents
read-modify-write the same data without coordination.

### Prevention
```typescript
// Immutable state with optimistic concurrency
class SafeStateStore {
  private state: WorkflowState;

  update(
    expectedVersion: number,
    updater: (s: WorkflowState) => WorkflowState,
  ): { success: boolean; state: WorkflowState } {
    if (this.state.version !== expectedVersion) {
      return { success: false, state: this.state };
    }
    const newState = updater(this.state);
    // Validate the new state is internally consistent
    WorkflowStateSchema.parse(newState);
    this.state = newState;
    return { success: true, state: this.state };
  }

  constructor(initial: WorkflowState) {
    this.state = initial;
  }
}
```

### Detection
Add invariant checks that run after every state update:
```typescript
function checkInvariants(state: WorkflowState): string[] {
  const violations: string[] = [];
  for (const [id, task] of Object.entries(state.tasks)) {
    if (task.status === "completed" && task.result === undefined) {
      violations.push(`Task ${id}: completed but no result`);
    }
    if (task.attempts < 0) {
      violations.push(`Task ${id}: negative attempt count`);
    }
  }
  return violations;
}
```

### Recovery
1. Stop the workflow
2. Restore from the last known-good snapshot
3. Replay events from the snapshot point
4. Fix the code that allowed the corruption

---

## 4. Cascade Failure

### Description
One agent's failure propagates through the entire system. Every downstream
agent either fails or processes garbage data.

### Symptoms
- All agents after the failed agent produce errors or nonsense
- Error logs show a chain of failures originating from one agent
- System latency spikes as retries pile up
- Total system failure from a single agent issue

### Root Cause
No failure isolation between agents. No circuit breakers. No validation
of intermediate results.

### Prevention
```typescript
// Circuit breaker prevents cascade
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private threshold: number,
    private resetTimeMs: number,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.state = "closed";
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) {
        this.state = "open";
      }
      throw error;
    }
  }
}
```

### Detection
Monitor error rates per agent. If one agent's error rate spikes and
downstream agents follow, you have a cascade.

### Recovery
1. Open circuit breakers to isolate the failed agent
2. Fix or restart the failed agent
3. Replay failed tasks from the queue
4. Gradually close circuit breakers

---

## 5. Ordering Violation

### Description
Events or messages arrive at an agent in the wrong order. Agent processes
a "task completed" event before the "task started" event.

### Symptoms
- State transitions fail with "invalid transition" errors
- Results appear before the task was assigned
- Aggregate counts are temporarily negative
- Intermittent failures that are hard to reproduce

### Root Cause
Parallel execution without ordered message delivery. Network-level
reordering in distributed environments.

### Prevention
```typescript
// Include sequence numbers and validate ordering
const OrderedMessageSchema = z.object({
  sequenceNumber: z.number().int().nonnegative(),
  workflowId: z.string().uuid(),
  payload: z.unknown(),
  timestamp: z.string().datetime(),
});

class OrderedMessageBuffer {
  private nextExpected = 0;
  private buffer: Map<number, z.infer<typeof OrderedMessageSchema>> = new Map();

  receive(
    msg: z.infer<typeof OrderedMessageSchema>,
  ): Array<z.infer<typeof OrderedMessageSchema>> {
    this.buffer.set(msg.sequenceNumber, msg);

    // Deliver messages in order
    const delivered: Array<z.infer<typeof OrderedMessageSchema>> = [];
    while (this.buffer.has(this.nextExpected)) {
      const next = this.buffer.get(this.nextExpected);
      if (next) {
        delivered.push(next);
        this.buffer.delete(this.nextExpected);
        this.nextExpected++;
      }
    }
    return delivered;
  }
}
```

### Detection
Log sequence numbers. Alert when messages are processed out of order.

### Recovery
Reprocess messages in correct order from the event log.

---

## 6. Silent Data Loss

### Description
Data is dropped between agents without any error. The system continues
operating with incomplete information.

### Symptoms
- Aggregations undercount
- Some tasks are never processed
- Final output is missing sections or information
- No error logs despite incorrect results

### Root Cause
Fire-and-forget messaging. No acknowledgment. No delivery confirmation.
Optional fields that silently accept `undefined`.

### Prevention
```typescript
import { z } from "zod";

// Require acknowledgment for every message
const MessageWithAckSchema = z.object({
  messageId: z.string().uuid(),
  payload: z.unknown(),
  sentAt: z.string().datetime(),
  requiresAck: z.literal(true),
});

const AckSchema = z.object({
  messageId: z.string().uuid(),
  receivedBy: z.string(),
  status: z.enum(["accepted", "rejected"]),
  rejectionReason: z.string().optional(),
  ackedAt: z.string().datetime(),
});

// Track unacknowledged messages
class ReliableMessenger {
  private pending: Map<string, z.infer<typeof MessageWithAckSchema>> = new Map();

  send(message: z.infer<typeof MessageWithAckSchema>): void {
    this.pending.set(message.messageId, message);
  }

  acknowledge(ack: z.infer<typeof AckSchema>): void {
    AckSchema.parse(ack);
    this.pending.delete(ack.messageId);
  }

  getUnacknowledged(olderThanMs: number): Array<z.infer<typeof MessageWithAckSchema>> {
    const cutoff = Date.now() - olderThanMs;
    return Array.from(this.pending.values()).filter(
      (m) => new Date(m.sentAt).getTime() < cutoff,
    );
  }
}
```

### Detection
Periodically check for unacknowledged messages. Count messages sent vs
messages received per agent pair.

### Recovery
Resend unacknowledged messages. If the receiver has already processed them,
idempotency keys prevent duplicate processing.

---

## 7. Resource Exhaustion

### Description
Agents consume more resources than available: token budgets, memory,
API rate limits, or concurrent execution slots.

### Symptoms
- API calls return rate limit errors (429)
- Token budget exceeded mid-workflow
- Memory usage grows until out-of-memory
- Agents queue indefinitely

### Root Cause
No resource budgeting. No limits on agent execution. No monitoring of
consumption rates.

### Prevention
```typescript
// Resource budget tracker
class ResourceBudget {
  private consumed: Record<string, number> = {};

  constructor(private limits: Record<string, number>) {}

  consume(resource: string, amount: number): {
    allowed: boolean;
    remaining: number;
  } {
    const limit = this.limits[resource] ?? Infinity;
    const current = this.consumed[resource] ?? 0;
    const newTotal = current + amount;

    if (newTotal > limit) {
      return { allowed: false, remaining: limit - current };
    }

    this.consumed = { ...this.consumed, [resource]: newTotal };
    return { allowed: true, remaining: limit - newTotal };
  }

  getUsage(): Record<string, { consumed: number; limit: number; percentage: number }> {
    const usage: Record<string, { consumed: number; limit: number; percentage: number }> = {};
    for (const [resource, limit] of Object.entries(this.limits)) {
      const consumed = this.consumed[resource] ?? 0;
      usage[resource] = {
        consumed,
        limit,
        percentage: (consumed / limit) * 100,
      };
    }
    return usage;
  }
}

// Usage
const budget = new ResourceBudget({
  tokens: 100_000,
  apiCalls: 500,
  concurrentAgents: 10,
});
```

### Detection
Monitor resource consumption. Alert at 80% of budget.

### Recovery
1. Pause non-critical agents
2. Complete in-flight work
3. Increase budget or reduce scope
4. Resume with adjusted limits

---

## 8. Deadlock/Livelock

### Description
**Deadlock:** Two or more agents wait for each other to complete, and none
can proceed. **Livelock:** Agents keep retrying the same operation without
making progress.

### Symptoms
- Deadlock: workflow hangs indefinitely, no errors, no progress
- Livelock: agents are active (logs show retries) but no tasks complete
- Timeout errors after long waits
- CPU/token usage but no forward progress

### Root Cause
Deadlock: circular dependencies between agent tasks.
Livelock: agents fail and retry in a way that causes repeated failure.

### Prevention
```typescript
// Deadlock prevention: detect circular waits
class DependencyTracker {
  private waitingFor: Map<string, string> = new Map();

  // Agent `waiter` is now waiting for agent `holder`
  registerWait(waiter: string, holder: string): {
    allowed: boolean;
    cycle?: string[];
  } {
    // Check for cycle before registering
    const visited = new Set<string>();
    let current: string | undefined = holder;

    while (current) {
      if (current === waiter) {
        // Cycle detected
        return {
          allowed: false,
          cycle: [...visited, current],
        };
      }
      if (visited.has(current)) break;
      visited.add(current);
      current = this.waitingFor.get(current);
    }

    this.waitingFor.set(waiter, holder);
    return { allowed: true };
  }

  releaseWait(waiter: string): void {
    this.waitingFor.delete(waiter);
  }
}

// Livelock prevention: maximum retry with exponential backoff
function withMaxRetries<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number = 100,
): Promise<T> {
  return retryWithBackoff(fn, maxRetries, baseDelayMs);
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * delay * 0.1;
        await new Promise((r) => setTimeout(r, delay + jitter));
      }
    }
  }

  throw lastError;
}
```

### Detection
- Set timeouts on all agent operations
- Monitor the dependency graph for cycles
- Track retry counts per operation; alert when excessive

### Recovery
- Deadlock: kill one agent in the cycle, release its resources
- Livelock: break the retry loop, escalate to a different strategy

---

## 9. Partial Completion

### Description
A multi-step workflow completes some steps but fails partway through,
leaving the system in an inconsistent state.

### Symptoms
- External systems have partial changes (e.g., payment charged but order not created)
- Database has orphaned records
- Some agents completed their tasks but the workflow is marked as failed
- Manual intervention required to clean up

### Root Cause
No compensating transactions. No saga pattern. Individual steps succeed
or fail independently with no coordination.

### Prevention
Use the saga pattern (see 05-orchestration-patterns.md):
```typescript
// Each step has a compensate function
interface SagaStep<TIn, TOut> {
  execute: (input: TIn) => Promise<TOut>;
  compensate: (input: TIn, output: TOut) => Promise<void>;
}
```

### Detection
Track the completion status of each step. Alert when a workflow has
mixed completed/failed steps.

### Recovery
Run compensation for all completed steps in reverse order.

---

## 10. Version Mismatch

### Description
Different agents in the same workflow use different versions of shared
schemas, tools, or protocols. Their data is structurally incompatible.

### Symptoms
- Validation errors that reference unknown fields
- Agents crash on schemas that used to work
- New agent versions break old agent versions
- Different behavior in staging vs production

### Root Cause
No version coordination between agents. Agents are deployed independently
without compatibility checks.

### Prevention
```typescript
import { z } from "zod";

// Version header on all messages
const VersionedMessageSchema = z.object({
  protocolVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  schemaVersion: z.number().int().positive(),
  payload: z.unknown(),
});

// Compatibility check before processing
function isCompatible(
  senderVersion: string,
  receiverVersion: string,
): boolean {
  const [sMajor] = senderVersion.split(".").map(Number);
  const [rMajor] = receiverVersion.split(".").map(Number);
  // Major version must match
  return sMajor === rMajor;
}

// Schema registry with compatibility matrix
const COMPATIBILITY: Record<number, number[]> = {
  3: [2, 3],    // v3 can read v2 and v3
  2: [1, 2],    // v2 can read v1 and v2
  1: [1],       // v1 can only read v1
};

function canRead(
  readerVersion: number,
  writerVersion: number,
): boolean {
  return COMPATIBILITY[readerVersion]?.includes(writerVersion) ?? false;
}
```

### Detection
Log schema versions on every message. Alert when incompatible versions
communicate.

### Recovery
1. Identify the version mismatch
2. Deploy compatibility adapters or migration functions
3. Coordinate a version upgrade across all agents
4. Remove backward compatibility only after all agents are upgraded

---

## Summary

The ten failure modes fall into three categories:

**Data failures** (1, 2, 6): Schema drift, action ambiguity, silent data loss.
Prevented by typed schemas and discriminated unions.

**State failures** (3, 5, 9, 10): State corruption, ordering violations,
partial completion, version mismatch. Prevented by immutable state, event
sourcing, sagas, and versioning.

**System failures** (4, 7, 8): Cascade failure, resource exhaustion,
deadlock/livelock. Prevented by circuit breakers, resource budgets, and
dependency tracking.

Every failure mode has a prevention strategy rooted in the three core
patterns: typed schemas, action schemas, and MCP contracts.
