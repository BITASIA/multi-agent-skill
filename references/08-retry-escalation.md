# Retry Strategies and Circuit Breakers

## Retry Taxonomy

Not all retries are created equal. The retry strategy must match the
failure characteristics of the agent or service being called.

### Immediate Retry

Retry instantly. Only appropriate for transient failures that are likely
to resolve on the next attempt (e.g., a race condition on a lock).

```typescript
async function immediateRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === maxAttempts) break;
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

class RetryExhaustedError extends Error {
  constructor(
    public readonly attempts: number,
    public readonly lastError?: Error,
  ) {
    super(
      `All ${attempts} retry attempts exhausted. ` +
      `Last error: ${lastError?.message ?? "unknown"}`,
    );
    this.name = "RetryExhaustedError";
  }
}
```

### Fixed Delay

Wait a constant amount of time between retries. Use when the failure
needs a specific recovery period (e.g., a cache refresh cycle).

```typescript
async function fixedDelayRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delayMs: number,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}
```

### Exponential Backoff

Double the delay between each retry. The standard approach for rate-limited
APIs and overloaded services.

```typescript
async function exponentialBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number = 100,
  maxDelayMs: number = 30_000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}
```

### Exponential Backoff with Jitter

Add randomness to prevent thundering herd problems (many agents retrying
at the same time).

```typescript
async function exponentialBackoffWithJitter<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number = 100,
  maxDelayMs: number = 30_000,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        const exponentialDelay = Math.min(
          baseDelayMs * Math.pow(2, attempt),
          maxDelayMs,
        );
        // Full jitter: random between 0 and the exponential delay
        const jitter = Math.random() * exponentialDelay;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}
```

### Configurable Retry Policy

```typescript
import { z } from "zod";

const RetryPolicySchema = z.object({
  strategy: z.enum(["immediate", "fixed", "exponential", "exponential_jitter"]),
  maxAttempts: z.number().int().min(1).max(10),
  baseDelayMs: z.number().int().min(0).max(60_000).default(100),
  maxDelayMs: z.number().int().min(0).max(300_000).default(30_000),
  retryableErrors: z.array(z.string()).default([]),
  nonRetryableErrors: z.array(z.string()).default([]),
});

type RetryPolicy = z.infer<typeof RetryPolicySchema>;

function isRetryable(error: Error, policy: RetryPolicy): boolean {
  const errorName = error.name;
  const errorMessage = error.message;

  // Check non-retryable list first (takes priority)
  if (policy.nonRetryableErrors.length > 0) {
    for (const pattern of policy.nonRetryableErrors) {
      if (errorName.includes(pattern) || errorMessage.includes(pattern)) {
        return false;
      }
    }
  }

  // If retryable list is specified, error must match
  if (policy.retryableErrors.length > 0) {
    for (const pattern of policy.retryableErrors) {
      if (errorName.includes(pattern) || errorMessage.includes(pattern)) {
        return true;
      }
    }
    return false;
  }

  // Default: all errors are retryable
  return true;
}

async function retryWithPolicy<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
): Promise<{ result: T; attempts: number }> {
  const validated = RetryPolicySchema.parse(policy);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < validated.maxAttempts; attempt++) {
    try {
      const result = await fn();
      return { result, attempts: attempt + 1 };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (!isRetryable(lastError, validated)) {
        throw lastError;
      }

      if (attempt < validated.maxAttempts - 1) {
        const delay = computeDelay(validated, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new RetryExhaustedError(validated.maxAttempts, lastError);
}

function computeDelay(policy: RetryPolicy, attempt: number): number {
  switch (policy.strategy) {
    case "immediate":
      return 0;
    case "fixed":
      return policy.baseDelayMs;
    case "exponential":
      return Math.min(
        policy.baseDelayMs * Math.pow(2, attempt),
        policy.maxDelayMs,
      );
    case "exponential_jitter": {
      const exponential = Math.min(
        policy.baseDelayMs * Math.pow(2, attempt),
        policy.maxDelayMs,
      );
      return Math.random() * exponential;
    }
  }
}
```

## Circuit Breaker Pattern

The circuit breaker prevents cascade failures by stopping calls to a
failing agent after a threshold of failures.

States:
- **Closed**: Normal operation. Calls pass through.
- **Open**: Agent is considered failed. All calls are immediately rejected.
- **Half-Open**: After a timeout, allow one test call through. If it
  succeeds, close. If it fails, open again.

```typescript
import { z } from "zod";

const CircuitBreakerConfigSchema = z.object({
  failureThreshold: z.number().int().min(1).max(100).default(5),
  resetTimeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
  halfOpenMaxAttempts: z.number().int().min(1).max(5).default(1),
  monitorWindowMs: z.number().int().min(1000).max(600_000).default(60_000),
});

type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfigSchema>;
type CircuitState = "closed" | "open" | "half-open";

class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures: number[] = []; // timestamps of failures
  private lastStateChange: number = Date.now();
  private halfOpenAttempts = 0;
  private config: CircuitBreakerConfig;

  constructor(
    private name: string,
    config: CircuitBreakerConfig,
  ) {
    this.config = CircuitBreakerConfigSchema.parse(config);
  }

  get currentState(): CircuitState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // Check if we should transition from open to half-open
    if (this.state === "open") {
      const elapsed = Date.now() - this.lastStateChange;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.transitionTo("half-open");
      } else {
        throw new CircuitOpenError(this.name, this.config.resetTimeoutMs - elapsed);
      }
    }

    // In half-open, limit attempts
    if (this.state === "half-open") {
      if (this.halfOpenAttempts >= this.config.halfOpenMaxAttempts) {
        throw new CircuitOpenError(this.name, 0);
      }
      this.halfOpenAttempts++;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half-open") {
      this.transitionTo("closed");
    }
    // Remove old failures outside the monitoring window
    const cutoff = Date.now() - this.config.monitorWindowMs;
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  private onFailure(): void {
    this.failures = [...this.failures, Date.now()];

    if (this.state === "half-open") {
      this.transitionTo("open");
      return;
    }

    // Count recent failures
    const cutoff = Date.now() - this.config.monitorWindowMs;
    const recentFailures = this.failures.filter((t) => t > cutoff);

    if (recentFailures.length >= this.config.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;
    this.lastStateChange = Date.now();

    if (newState === "half-open") {
      this.halfOpenAttempts = 0;
    }

    if (newState === "closed") {
      this.failures = [];
    }

    // Log the transition (structured logging in production)
    console.info(
      `[CircuitBreaker:${this.name}] ${oldState} → ${newState}`,
    );
  }

  getStatus(): {
    name: string;
    state: CircuitState;
    recentFailures: number;
    lastStateChange: string;
  } {
    const cutoff = Date.now() - this.config.monitorWindowMs;
    return {
      name: this.name,
      state: this.state,
      recentFailures: this.failures.filter((t) => t > cutoff).length,
      lastStateChange: new Date(this.lastStateChange).toISOString(),
    };
  }
}

class CircuitOpenError extends Error {
  constructor(
    public readonly circuitName: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Circuit breaker "${circuitName}" is open. ` +
      `Retry after ${retryAfterMs}ms.`,
    );
    this.name = "CircuitOpenError";
  }
}
```

## Escalation Chains

When retries fail, escalate to progressively more capable handlers.

```typescript
import { z } from "zod";

const EscalationLevelSchema = z.object({
  name: z.string(),
  handler: z.function()
    .args(z.unknown())
    .returns(z.promise(z.unknown())),
  retryPolicy: RetryPolicySchema,
  timeoutMs: z.number().int().positive(),
});

const EscalationChainSchema = z.object({
  name: z.string(),
  levels: z.array(z.object({
    name: z.string(),
    retryPolicy: RetryPolicySchema,
    timeoutMs: z.number().int().positive(),
  })).min(1),
});

interface EscalationLevel {
  name: string;
  handler: (input: unknown) => Promise<unknown>;
  retryPolicy: RetryPolicy;
  timeoutMs: number;
}

interface EscalationResult {
  success: boolean;
  result?: unknown;
  resolvedByLevel: string;
  attemptsByLevel: Record<string, number>;
  totalDurationMs: number;
  error?: string;
}

async function executeWithEscalation(
  input: unknown,
  levels: EscalationLevel[],
): Promise<EscalationResult> {
  const startTime = Date.now();
  const attemptsByLevel: Record<string, number> = {};

  for (const level of levels) {
    try {
      // Wrap handler with timeout
      const timedHandler = () =>
        Promise.race([
          level.handler(input),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout after ${level.timeoutMs}ms`)),
              level.timeoutMs,
            )
          ),
        ]);

      // Apply retry policy
      const { result, attempts } = await retryWithPolicy(
        timedHandler,
        level.retryPolicy,
      );

      attemptsByLevel[level.name] = attempts;

      return {
        success: true,
        result,
        resolvedByLevel: level.name,
        attemptsByLevel,
        totalDurationMs: Date.now() - startTime,
      };
    } catch (error) {
      attemptsByLevel[level.name] = level.retryPolicy.maxAttempts;
      // Continue to next escalation level
    }
  }

  return {
    success: false,
    resolvedByLevel: "none",
    attemptsByLevel,
    totalDurationMs: Date.now() - startTime,
    error: "All escalation levels exhausted",
  };
}

// Example: retry → fallback agent → human escalation
const escalationChain: EscalationLevel[] = [
  {
    name: "primary_agent",
    handler: async (input) => {
      // Primary agent attempt
      return { answer: "..." };
    },
    retryPolicy: {
      strategy: "exponential_jitter",
      maxAttempts: 3,
      baseDelayMs: 200,
      maxDelayMs: 5000,
      retryableErrors: [],
      nonRetryableErrors: ["ValidationError"],
    },
    timeoutMs: 30_000,
  },
  {
    name: "fallback_agent",
    handler: async (input) => {
      // Simpler, more reliable agent
      return { answer: "..." };
    },
    retryPolicy: {
      strategy: "fixed",
      maxAttempts: 2,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      retryableErrors: [],
      nonRetryableErrors: [],
    },
    timeoutMs: 60_000,
  },
  {
    name: "human_escalation",
    handler: async (input) => {
      // Queue for human review, return ticket ID
      return {
        escalated: true,
        ticketId: crypto.randomUUID(),
        message: "Queued for human review",
      };
    },
    retryPolicy: {
      strategy: "immediate",
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      retryableErrors: [],
      nonRetryableErrors: [],
    },
    timeoutMs: 5_000,
  },
];
```

## Timeout Management

```typescript
// Composable timeout wrapper
function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  operationName: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

class TimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number,
  ) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

// Layered timeouts: per-agent + per-workflow
// Agent timeout: 30 seconds
// Workflow timeout: 5 minutes
// If an agent takes too long, it fails and the workflow continues
// If the workflow takes too long, the entire thing is aborted
```

## Idempotency for Safe Retries

Retries are only safe if the operation is idempotent. An idempotent
operation produces the same result regardless of how many times it runs.

```typescript
import { z } from "zod";

// Idempotency key tracks operations that have already been processed
class IdempotencyStore {
  private processed: Map<string, { result: unknown; processedAt: string }> =
    new Map();

  async executeOnce<T>(
    idempotencyKey: string,
    fn: () => Promise<T>,
  ): Promise<{ result: T; wasRetry: boolean }> {
    // Check if already processed
    const existing = this.processed.get(idempotencyKey);
    if (existing) {
      return { result: existing.result as T, wasRetry: true };
    }

    // Execute and store result
    const result = await fn();
    this.processed.set(idempotencyKey, {
      result,
      processedAt: new Date().toISOString(),
    });

    return { result, wasRetry: false };
  }

  isProcessed(idempotencyKey: string): boolean {
    return this.processed.has(idempotencyKey);
  }

  // Clean up old entries
  cleanup(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    const entries = Array.from(this.processed.entries());

    for (const [key, value] of entries) {
      if (new Date(value.processedAt).getTime() < cutoff) {
        this.processed.delete(key);
        removed++;
      }
    }

    return removed;
  }
}

// Usage: ensure task processing is idempotent
const idempotency = new IdempotencyStore();

async function processTask(taskId: string, input: unknown) {
  const key = `process-task-${taskId}`;
  const { result, wasRetry } = await idempotency.executeOnce(key, async () => {
    // Actual processing logic
    return { processed: true, taskId };
  });

  if (wasRetry) {
    console.info(`Task ${taskId} was already processed (idempotent retry)`);
  }

  return result;
}
```

## Dead Letter Queues

Messages that fail all retry attempts go to a dead letter queue for
manual inspection and replay.

```typescript
import { z } from "zod";

const DeadLetterEntrySchema = z.object({
  id: z.string().uuid(),
  originalMessage: z.unknown(),
  targetAgent: z.string(),
  error: z.string(),
  attempts: z.number().int().positive(),
  firstAttemptAt: z.string().datetime(),
  lastAttemptAt: z.string().datetime(),
  deadLetteredAt: z.string().datetime(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

type DeadLetterEntry = z.infer<typeof DeadLetterEntrySchema>;

class DeadLetterQueue {
  private entries: DeadLetterEntry[] = [];

  add(entry: Omit<DeadLetterEntry, "id" | "deadLetteredAt">): string {
    const id = crypto.randomUUID();
    const deadLetterEntry: DeadLetterEntry = {
      ...entry,
      id,
      deadLetteredAt: new Date().toISOString(),
    };
    this.entries = [...this.entries, DeadLetterEntrySchema.parse(deadLetterEntry)];
    return id;
  }

  list(filter?: {
    targetAgent?: string;
    since?: string;
  }): ReadonlyArray<DeadLetterEntry> {
    let filtered = this.entries;
    if (filter?.targetAgent) {
      filtered = filtered.filter((e) => e.targetAgent === filter.targetAgent);
    }
    if (filter?.since) {
      const sinceDate = new Date(filter.since).getTime();
      filtered = filtered.filter(
        (e) => new Date(e.deadLetteredAt).getTime() >= sinceDate,
      );
    }
    return filtered;
  }

  async replay(
    id: string,
    handler: (message: unknown) => Promise<unknown>,
  ): Promise<{ success: boolean; result?: unknown; error?: string }> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) {
      return { success: false, error: `Dead letter ${id} not found` };
    }

    try {
      const result = await handler(entry.originalMessage);
      // Remove from DLQ on success
      this.entries = this.entries.filter((e) => e.id !== id);
      return { success: true, result };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown",
      };
    }
  }

  count(): number {
    return this.entries.length;
  }

  countByAgent(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) {
      counts[entry.targetAgent] = (counts[entry.targetAgent] ?? 0) + 1;
    }
    return counts;
  }
}
```

## Combining Retry, Circuit Breaker, and Escalation

```typescript
// Full resilience stack for an agent call
async function resilientAgentCall<T>(
  agentName: string,
  input: unknown,
  handler: (input: unknown) => Promise<T>,
  config: {
    retryPolicy: RetryPolicy;
    circuitBreaker: CircuitBreaker;
    escalationLevels: EscalationLevel[];
    deadLetterQueue: DeadLetterQueue;
    idempotencyKey?: string;
    timeoutMs: number;
  },
): Promise<T> {
  // Layer 1: Idempotency check
  if (config.idempotencyKey) {
    const store = new IdempotencyStore();
    const { result, wasRetry } = await store.executeOnce(
      config.idempotencyKey,
      async () => innerCall(),
    );
    return result;
  }

  return innerCall();

  async function innerCall(): Promise<T> {
    try {
      // Layer 2: Circuit breaker
      return await config.circuitBreaker.execute(async () => {
        // Layer 3: Timeout
        return await withTimeout(
          // Layer 4: Retry
          () => retryWithPolicy(() => handler(input), config.retryPolicy)
            .then((r) => r.result as T),
          config.timeoutMs,
          agentName,
        );
      });
    } catch (error) {
      // Layer 5: Escalation
      const escalationResult = await executeWithEscalation(
        input,
        config.escalationLevels,
      );

      if (escalationResult.success) {
        return escalationResult.result as T;
      }

      // Layer 6: Dead letter queue
      config.deadLetterQueue.add({
        originalMessage: input,
        targetAgent: agentName,
        error: error instanceof Error ? error.message : "Unknown",
        attempts: config.retryPolicy.maxAttempts,
        firstAttemptAt: new Date().toISOString(),
        lastAttemptAt: new Date().toISOString(),
      });

      throw error;
    }
  }
}
```

## Summary

The resilience stack, from innermost to outermost:

1. **Idempotency** — ensure safe retries
2. **Timeout** — prevent indefinite waits
3. **Retry with backoff** — handle transient failures
4. **Circuit breaker** — prevent cascade failures
5. **Escalation chain** — fallback to progressively more capable handlers
6. **Dead letter queue** — capture permanently failed messages for review

Each layer addresses a different failure mode. Together, they make the
multi-agent system resilient to the full spectrum of failures.
