/**
 * MCP Validation Middleware
 *
 * Composable middleware chain for pre- and post-execution validation.
 * Uses an immutable pipe pattern – each middleware returns a new context,
 * never mutates the existing one.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Context flowing through the middleware chain
// ---------------------------------------------------------------------------

export interface MiddlewareContext {
  readonly requestId: string;
  readonly correlationId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly startedAt: number;
}

/**
 * Create an initial context for a new request. Immutable from the start.
 */
export function createContext(
  requestId: string,
  correlationId: string,
  toolName: string,
  input: unknown
): MiddlewareContext {
  return Object.freeze({
    requestId,
    correlationId,
    toolName,
    input,
    metadata: {},
    startedAt: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Middleware type
// ---------------------------------------------------------------------------

/**
 * A middleware receives a context and returns a (possibly new) context.
 * Returning a context with `error` set short-circuits the chain.
 */
export type Middleware = (
  ctx: MiddlewareContext
) => Promise<MiddlewareContext> | MiddlewareContext;

// ---------------------------------------------------------------------------
// Pipe composition (immutable)
// ---------------------------------------------------------------------------

/**
 * Compose an ordered array of middleware into a single function.
 * Execution stops early when any middleware sets `ctx.error`.
 */
export function pipe(...middlewares: ReadonlyArray<Middleware>): Middleware {
  return async (ctx: MiddlewareContext): Promise<MiddlewareContext> => {
    let current = ctx;
    for (const mw of middlewares) {
      if (current.error) break;
      current = await mw(current);
    }
    return current;
  };
}

// ---------------------------------------------------------------------------
// Input validation middleware
// ---------------------------------------------------------------------------

/**
 * Validates `ctx.input` against the provided Zod schema.
 * On failure, sets `ctx.error` with a formatted message.
 */
export function inputValidation(schema: z.ZodTypeAny): Middleware {
  return (ctx) => {
    const result = schema.safeParse(ctx.input);
    if (!result.success) {
      return {
        ...ctx,
        error: formatValidationError("Input validation failed", result.error),
      };
    }
    // Replace input with the parsed (coerced/defaulted) value
    return { ...ctx, input: result.data };
  };
}

// ---------------------------------------------------------------------------
// Output validation middleware
// ---------------------------------------------------------------------------

/**
 * Validates `ctx.output` against the provided Zod schema.
 * Should run after the tool execution step.
 */
export function outputValidation(schema: z.ZodTypeAny): Middleware {
  return (ctx) => {
    if (ctx.output === undefined) return ctx;

    const result = schema.safeParse(ctx.output);
    if (!result.success) {
      return {
        ...ctx,
        error: formatValidationError("Output validation failed", result.error),
      };
    }
    return { ...ctx, output: result.data };
  };
}

// ---------------------------------------------------------------------------
// Rate limiting middleware
// ---------------------------------------------------------------------------

interface RateLimitState {
  readonly tokens: number;
  readonly lastRefill: number;
}

/**
 * Token-bucket rate limiter. State is kept in a closure but each
 * check produces a new state object (no mutation).
 */
export function rateLimiting(
  maxTokens: number,
  refillRatePerSecond: number
): Middleware {
  let state: RateLimitState = {
    tokens: maxTokens,
    lastRefill: Date.now(),
  };

  return (ctx) => {
    const now = Date.now();
    const elapsed = (now - state.lastRefill) / 1000;
    const refilled = Math.min(maxTokens, state.tokens + elapsed * refillRatePerSecond);

    if (refilled < 1) {
      return {
        ...ctx,
        error: `Rate limit exceeded for tool "${ctx.toolName}". Try again shortly.`,
      };
    }

    // Produce new state
    state = { tokens: refilled - 1, lastRefill: now };
    return ctx;
  };
}

// ---------------------------------------------------------------------------
// Logging middleware with correlation IDs
// ---------------------------------------------------------------------------

export type LogFn = (entry: Readonly<Record<string, unknown>>) => void;

/**
 * Logs request and response details with correlation IDs for tracing.
 */
export function logging(log: LogFn): Middleware {
  return (ctx) => {
    log({
      level: ctx.error ? "error" : "info",
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
      tool: ctx.toolName,
      durationMs: Date.now() - ctx.startedAt,
      hasError: Boolean(ctx.error),
    });
    return ctx;
  };
}

// ---------------------------------------------------------------------------
// Error formatting
// ---------------------------------------------------------------------------

export const ValidationErrorResponse = z.object({
  code: z.literal("VALIDATION_ERROR"),
  message: z.string(),
  issues: z.array(
    z.object({
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
      code: z.string(),
    })
  ),
});

export type ValidationErrorResponse = z.infer<typeof ValidationErrorResponse>;

function formatValidationError(prefix: string, error: z.ZodError): string {
  const response: ValidationErrorResponse = {
    code: "VALIDATION_ERROR",
    message: prefix,
    issues: error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
      code: issue.code,
    })),
  };
  return JSON.stringify(response);
}

// ---------------------------------------------------------------------------
// Usage example: composing a full middleware chain
// ---------------------------------------------------------------------------

export function exampleUsage(): Middleware {
  const InputSchema = z.object({
    query: z.string().min(1),
    limit: z.number().int().positive().default(10),
  });

  const OutputSchema = z.object({
    results: z.array(z.unknown()),
    count: z.number().int().nonneg(),
  });

  const consoleLog: LogFn = (entry) => {
    // In production, replace with structured logger
    process.stdout.write(JSON.stringify(entry) + "\n");
  };

  return pipe(
    rateLimiting(100, 10),
    inputValidation(InputSchema),
    // ... tool execution would happen here (injected by the server) ...
    outputValidation(OutputSchema),
    logging(consoleLog)
  );
}
