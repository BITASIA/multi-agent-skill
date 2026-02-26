/**
 * Retry with Circuit Breaker and Escalation
 *
 * Production-grade resilience: exponential backoff with jitter,
 * a three-state circuit breaker, an escalation chain, idempotency
 * tracking, and dead-letter handling. All state transitions are
 * immutable – every function returns a NEW state object.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration schemas
// ---------------------------------------------------------------------------

export const RetryConfig = z.object({
  maxRetries: z.number().int().positive().default(3),
  baseDelayMs: z.number().int().positive().default(1000),
  maxDelayMs: z.number().int().positive().default(30_000),
  /** Multiplier for exponential growth. */
  backoffFactor: z.number().positive().default(2),
  /** Maximum random jitter added to delay (ms). */
  jitterMs: z.number().int().nonneg().default(500),
});

export type RetryConfig = z.infer<typeof RetryConfig>;

export const CircuitBreakerConfig = z.object({
  failureThreshold: z.number().int().positive().default(5),
  resetTimeoutMs: z.number().int().positive().default(60_000),
  halfOpenMaxAttempts: z.number().int().positive().default(1),
});

export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerConfig>;

// ---------------------------------------------------------------------------
// Circuit breaker state (immutable)
// ---------------------------------------------------------------------------

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreaker {
  readonly state: CircuitState;
  readonly failureCount: number;
  readonly lastFailureAt: number | null;
  readonly halfOpenAttempts: number;
  readonly config: CircuitBreakerConfig;
}

export function createCircuitBreaker(config: CircuitBreakerConfig): CircuitBreaker {
  return {
    state: "closed",
    failureCount: 0,
    lastFailureAt: null,
    halfOpenAttempts: 0,
    config,
  };
}

export function recordSuccess(cb: CircuitBreaker): CircuitBreaker {
  return { ...cb, state: "closed", failureCount: 0, halfOpenAttempts: 0 };
}

export function recordFailure(cb: CircuitBreaker): CircuitBreaker {
  const failures = cb.failureCount + 1;
  const shouldOpen = failures >= cb.config.failureThreshold;
  return {
    ...cb,
    failureCount: failures,
    lastFailureAt: Date.now(),
    state: shouldOpen ? "open" : cb.state,
  };
}

/**
 * Evaluate whether the breaker should transition based on elapsed time.
 * Returns a NEW breaker – never mutates.
 */
export function evaluateCircuit(cb: CircuitBreaker): CircuitBreaker {
  if (cb.state !== "open" || cb.lastFailureAt === null) return cb;

  const elapsed = Date.now() - cb.lastFailureAt;
  if (elapsed >= cb.config.resetTimeoutMs) {
    return { ...cb, state: "half-open", halfOpenAttempts: 0 };
  }
  return cb;
}

export function isCallAllowed(cb: CircuitBreaker): boolean {
  if (cb.state === "closed") return true;
  if (cb.state === "open") return false;
  // half-open: allow limited attempts
  return cb.halfOpenAttempts < cb.config.halfOpenMaxAttempts;
}

function incrementHalfOpen(cb: CircuitBreaker): CircuitBreaker {
  return { ...cb, halfOpenAttempts: cb.halfOpenAttempts + 1 };
}

// ---------------------------------------------------------------------------
// Backoff calculation (pure)
// ---------------------------------------------------------------------------

export function calculateDelay(attempt: number, config: RetryConfig): number {
  const exponential = config.baseDelayMs * Math.pow(config.backoffFactor, attempt);
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = Math.floor(Math.random() * config.jitterMs);
  return capped + jitter;
}

// ---------------------------------------------------------------------------
// Escalation chain
// ---------------------------------------------------------------------------

export type EscalationLevel = "retry" | "fallback" | "human";

export interface EscalationResult {
  readonly level: EscalationLevel;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export type FallbackFn = (error: Error) => Promise<unknown>;
export type HumanEscalateFn = (error: Error, context: unknown) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Idempotency tracking
// ---------------------------------------------------------------------------

export interface IdempotencyStore {
  readonly processed: ReadonlyMap<string, unknown>;
}

export function createIdempotencyStore(): IdempotencyStore {
  return { processed: new Map() };
}

export function hasBeenProcessed(store: IdempotencyStore, key: string): boolean {
  return store.processed.has(key);
}

export function markProcessed(
  store: IdempotencyStore,
  key: string,
  result: unknown
): IdempotencyStore {
  return { processed: new Map([...store.processed, [key, result]]) };
}

export function getProcessedResult(store: IdempotencyStore, key: string): unknown {
  return store.processed.get(key);
}

// ---------------------------------------------------------------------------
// Dead letter
// ---------------------------------------------------------------------------

export const DeadLetterEntry = z.object({
  id: z.string().uuid(),
  operation: z.string(),
  input: z.unknown(),
  error: z.string(),
  attempts: z.number().int().nonneg(),
  failedAt: z.string().datetime(),
  idempotencyKey: z.string().optional(),
});

export type DeadLetterEntry = z.infer<typeof DeadLetterEntry>;

export interface DeadLetterQueue {
  readonly entries: ReadonlyArray<DeadLetterEntry>;
}

export function createDeadLetterQueue(): DeadLetterQueue {
  return { entries: [] };
}

export function addToDeadLetter(
  dlq: DeadLetterQueue,
  entry: DeadLetterEntry
): DeadLetterQueue {
  return { entries: [...dlq.entries, entry] };
}

// ---------------------------------------------------------------------------
// Resilient executor: retry -> circuit breaker -> escalation
// ---------------------------------------------------------------------------

export interface ResilientConfig {
  readonly retry: RetryConfig;
  readonly circuitBreaker: CircuitBreakerConfig;
  readonly fallback?: FallbackFn;
  readonly humanEscalate?: HumanEscalateFn;
}

/**
 * Execute an operation with full retry, circuit breaker, and escalation.
 * Returns the result and updated circuit breaker state.
 */
export async function executeResilient<T>(
  operation: () => Promise<T>,
  config: ResilientConfig,
  breaker: CircuitBreaker,
  idempotencyKey?: string,
  store?: IdempotencyStore
): Promise<{
  readonly result: EscalationResult;
  readonly breaker: CircuitBreaker;
  readonly store: IdempotencyStore;
  readonly deadLetter?: DeadLetterEntry;
}> {
  const currentStore = store ?? createIdempotencyStore();

  // Check idempotency
  if (idempotencyKey && hasBeenProcessed(currentStore, idempotencyKey)) {
    return {
      result: { level: "retry", success: true, data: getProcessedResult(currentStore, idempotencyKey) },
      breaker,
      store: currentStore,
    };
  }

  // Retry loop
  let currentBreaker = evaluateCircuit(breaker);
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 0; attempt <= config.retry.maxRetries; attempt++) {
    if (!isCallAllowed(currentBreaker)) break;

    if (currentBreaker.state === "half-open") {
      currentBreaker = incrementHalfOpen(currentBreaker);
    }

    try {
      const data = await operation();
      currentBreaker = recordSuccess(currentBreaker);
      const nextStore = idempotencyKey
        ? markProcessed(currentStore, idempotencyKey, data)
        : currentStore;
      return {
        result: { level: "retry", success: true, data },
        breaker: currentBreaker,
        store: nextStore,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      currentBreaker = recordFailure(currentBreaker);

      if (attempt < config.retry.maxRetries) {
        const delay = calculateDelay(attempt, config.retry);
        await sleep(delay);
      }
    }
  }

  // Fallback
  if (config.fallback) {
    try {
      const data = await config.fallback(lastError);
      return {
        result: { level: "fallback", success: true, data },
        breaker: currentBreaker,
        store: currentStore,
      };
    } catch {
      // Fallback failed, continue to human escalation
    }
  }

  // Human escalation
  if (config.humanEscalate) {
    try {
      const data = await config.humanEscalate(lastError, { idempotencyKey });
      return {
        result: { level: "human", success: true, data },
        breaker: currentBreaker,
        store: currentStore,
      };
    } catch {
      // All escalation levels exhausted
    }
  }

  // Dead letter
  const deadLetter: DeadLetterEntry = {
    id: crypto.randomUUID(),
    operation: "unknown",
    input: null,
    error: lastError.message,
    attempts: config.retry.maxRetries + 1,
    failedAt: new Date().toISOString(),
    idempotencyKey,
  };

  return {
    result: { level: "human", success: false, error: lastError.message },
    breaker: currentBreaker,
    store: currentStore,
    deadLetter,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Example: API call with full resilience
// ---------------------------------------------------------------------------

export async function exampleResilientApiCall(): Promise<void> {
  const config: ResilientConfig = {
    retry: RetryConfig.parse({ maxRetries: 3, baseDelayMs: 500 }),
    circuitBreaker: CircuitBreakerConfig.parse({ failureThreshold: 5 }),
    fallback: async () => ({ cached: true, data: "stale result" }),
    humanEscalate: async (error) => {
      // In production: send to ticketing system, Slack, PagerDuty, etc.
      throw new Error(`Human review needed: ${error.message}`);
    },
  };

  const breaker = createCircuitBreaker(config.circuitBreaker);

  const { result, breaker: updatedBreaker, deadLetter } = await executeResilient(
    async () => {
      // Simulate flaky API
      if (Math.random() < 0.5) throw new Error("Connection timeout");
      return { status: "ok", value: 42 };
    },
    config,
    breaker,
    "idempotency-key-abc"
  );

  if (deadLetter) {
    // Persist to dead letter queue for manual inspection
  }
}
