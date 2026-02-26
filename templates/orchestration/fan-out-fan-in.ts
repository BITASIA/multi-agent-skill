/**
 * Fan-Out / Fan-In Orchestration
 *
 * Distributes work to parallel agents, collects results, and aggregates
 * them using configurable strategies. Handles timeouts and partial
 * failures gracefully. All functions are pure / immutable.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const AgentTask = z.object({
  taskId: z.string().uuid(),
  agentId: z.string().min(1),
  payload: z.unknown(),
});

export type AgentTask = z.infer<typeof AgentTask>;

export const AgentResult = z.object({
  taskId: z.string().uuid(),
  agentId: z.string().min(1),
  status: z.enum(["success", "failure", "timeout"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonneg(),
});

export type AgentResult = z.infer<typeof AgentResult>;

export const FanOutConfig = z.object({
  timeoutMs: z.number().int().positive().default(30_000),
  /** Minimum successful results required to consider the fan-in valid. */
  minSuccessCount: z.number().int().nonneg().default(1),
  /** If true, fail the entire operation when any agent fails. */
  failFast: z.boolean().default(false),
});

export type FanOutConfig = z.infer<typeof FanOutConfig>;

// ---------------------------------------------------------------------------
// Agent executor interface (framework-agnostic)
// ---------------------------------------------------------------------------

export type AgentExecutor = (task: AgentTask) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Fan-out: distribute work
// ---------------------------------------------------------------------------

/**
 * Execute tasks in parallel with per-task timeout.
 * Returns ALL results, including failures and timeouts.
 */
export async function fanOut(
  tasks: ReadonlyArray<AgentTask>,
  executor: AgentExecutor,
  config: FanOutConfig
): Promise<ReadonlyArray<AgentResult>> {
  const promises = tasks.map((task) => executeWithTimeout(task, executor, config.timeoutMs));
  return Promise.all(promises);
}

async function executeWithTimeout(
  task: AgentTask,
  executor: AgentExecutor,
  timeoutMs: number
): Promise<AgentResult> {
  const start = Date.now();

  const timeoutPromise = new Promise<AgentResult>((resolve) => {
    setTimeout(() => {
      resolve({
        taskId: task.taskId,
        agentId: task.agentId,
        status: "timeout",
        error: `Agent timed out after ${timeoutMs}ms`,
        durationMs: Date.now() - start,
      });
    }, timeoutMs);
  });

  const executionPromise = (async (): Promise<AgentResult> => {
    try {
      const data = await executor(task);
      return {
        taskId: task.taskId,
        agentId: task.agentId,
        status: "success",
        data,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        taskId: task.taskId,
        agentId: task.agentId,
        status: "failure",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  })();

  return Promise.race([executionPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Fan-in: aggregate results
// ---------------------------------------------------------------------------

export interface AggregatedResult<T> {
  readonly strategy: string;
  readonly value: T;
  readonly successCount: number;
  readonly failureCount: number;
  readonly timeoutCount: number;
  readonly results: ReadonlyArray<AgentResult>;
}

/**
 * Partition results by status. Pure function, no mutation.
 */
export function partitionResults(results: ReadonlyArray<AgentResult>) {
  return {
    successes: results.filter((r) => r.status === "success"),
    failures: results.filter((r) => r.status === "failure"),
    timeouts: results.filter((r) => r.status === "timeout"),
  };
}

// ---------------------------------------------------------------------------
// Aggregation strategies
// ---------------------------------------------------------------------------

/**
 * Merge: combine all successful results into an array.
 */
export function mergeStrategy<T>(
  results: ReadonlyArray<AgentResult>
): AggregatedResult<ReadonlyArray<T>> {
  const { successes, failures, timeouts } = partitionResults(results);
  return {
    strategy: "merge",
    value: successes.map((r) => r.data as T),
    successCount: successes.length,
    failureCount: failures.length,
    timeoutCount: timeouts.length,
    results,
  };
}

/**
 * Vote: return the most common result (majority wins).
 * Uses JSON serialization for equality comparison.
 */
export function voteStrategy<T>(
  results: ReadonlyArray<AgentResult>
): AggregatedResult<T | null> {
  const { successes, failures, timeouts } = partitionResults(results);

  if (successes.length === 0) {
    return {
      strategy: "vote",
      value: null,
      successCount: 0,
      failureCount: failures.length,
      timeoutCount: timeouts.length,
      results,
    };
  }

  const votes = new Map<string, { count: number; value: unknown }>();
  for (const r of successes) {
    const key = JSON.stringify(r.data);
    const existing = votes.get(key);
    votes.set(key, {
      count: (existing?.count ?? 0) + 1,
      value: r.data,
    });
  }

  let winner: { count: number; value: unknown } = { count: 0, value: null };
  for (const entry of votes.values()) {
    if (entry.count > winner.count) {
      winner = entry;
    }
  }

  return {
    strategy: "vote",
    value: winner.value as T,
    successCount: successes.length,
    failureCount: failures.length,
    timeoutCount: timeouts.length,
    results,
  };
}

/**
 * First-wins: return the first successful result.
 */
export function firstWinsStrategy<T>(
  results: ReadonlyArray<AgentResult>
): AggregatedResult<T | null> {
  const { successes, failures, timeouts } = partitionResults(results);
  return {
    strategy: "first-wins",
    value: successes.length > 0 ? (successes[0].data as T) : null,
    successCount: successes.length,
    failureCount: failures.length,
    timeoutCount: timeouts.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Full fan-out/fan-in orchestration
// ---------------------------------------------------------------------------

/**
 * Run the complete fan-out, execute, fan-in cycle.
 * Validates minimum success count before returning.
 */
export async function fanOutFanIn<T>(
  tasks: ReadonlyArray<AgentTask>,
  executor: AgentExecutor,
  config: FanOutConfig,
  aggregate: (results: ReadonlyArray<AgentResult>) => AggregatedResult<T>
): Promise<AggregatedResult<T>> {
  const results = await fanOut(tasks, executor, config);
  const aggregated = aggregate(results);

  if (aggregated.successCount < config.minSuccessCount) {
    throw new Error(
      `Insufficient successes: got ${aggregated.successCount}, ` +
        `need ${config.minSuccessCount}`
    );
  }

  return aggregated;
}

// ---------------------------------------------------------------------------
// Example: parallel analysis with consensus
// ---------------------------------------------------------------------------

export async function exampleParallelAnalysis(): Promise<void> {
  const tasks: ReadonlyArray<AgentTask> = [
    { taskId: crypto.randomUUID(), agentId: "analyzer-1", payload: { text: "hello world" } },
    { taskId: crypto.randomUUID(), agentId: "analyzer-2", payload: { text: "hello world" } },
    { taskId: crypto.randomUUID(), agentId: "analyzer-3", payload: { text: "hello world" } },
  ];

  const mockExecutor: AgentExecutor = async () => ({ sentiment: "positive" });

  const config = FanOutConfig.parse({ timeoutMs: 5000, minSuccessCount: 2 });

  const result = await fanOutFanIn(
    tasks,
    mockExecutor,
    config,
    voteStrategy
  );

  // result.value is the consensus answer (or null if no successes)
  // result.successCount tells how many agents agreed
}
