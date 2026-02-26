# Orchestration Patterns

## Overview

Orchestration determines how agents are coordinated, how data flows between
them, and how failures are handled. Each pattern suits different workload
characteristics. Choosing the wrong pattern is a common source of
unnecessary complexity.

All patterns below use pure TypeScript with Zod schemas. No frameworks.

## Pattern 1: Sequential Pipeline

Agents execute in a fixed order. Each agent's output becomes the next
agent's input. The pipeline stops if any agent fails.

**Use when:** Tasks have a natural linear progression (research, then
analyze, then summarize). Order matters. Each step depends on the previous.

```typescript
import { z } from "zod";

// Each pipeline stage has typed input and output
interface PipelineStage<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
}

// Pipeline executor
async function runPipeline<TInitialInput>(
  stages: PipelineStage<unknown, unknown>[],
  initialInput: TInitialInput,
): Promise<{
  success: boolean;
  finalOutput: unknown;
  stageResults: Array<{
    name: string;
    status: "success" | "failure";
    output?: unknown;
    error?: string;
    durationMs: number;
  }>;
}> {
  const stageResults: Array<{
    name: string;
    status: "success" | "failure";
    output?: unknown;
    error?: string;
    durationMs: number;
  }> = [];

  let currentInput: unknown = initialInput;

  for (const stage of stages) {
    const startTime = Date.now();

    try {
      // Validate input
      const validInput = stage.inputSchema.parse(currentInput);

      // Execute stage
      const rawOutput = await stage.execute(validInput);

      // Validate output
      const validOutput = stage.outputSchema.parse(rawOutput);

      stageResults.push({
        name: stage.name,
        status: "success",
        output: validOutput,
        durationMs: Date.now() - startTime,
      });

      currentInput = validOutput;
    } catch (error) {
      stageResults.push({
        name: stage.name,
        status: "failure",
        error: error instanceof Error ? error.message : "Unknown error",
        durationMs: Date.now() - startTime,
      });

      return {
        success: false,
        finalOutput: undefined,
        stageResults,
      };
    }
  }

  return {
    success: true,
    finalOutput: currentInput,
    stageResults,
  };
}

// Example: Research → Analyze → Summarize pipeline
const ResearchOutputSchema = z.object({
  sources: z.array(z.object({
    title: z.string(),
    content: z.string(),
    url: z.string().url(),
    relevance: z.number().min(0).max(1),
  })),
  query: z.string(),
});

const AnalysisOutputSchema = z.object({
  themes: z.array(z.object({
    name: z.string(),
    evidence: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })),
  gaps: z.array(z.string()),
});

const SummaryOutputSchema = z.object({
  summary: z.string(),
  keyFindings: z.array(z.string()),
  recommendations: z.array(z.string()),
});

const researchStage: PipelineStage<{ query: string }, z.infer<typeof ResearchOutputSchema>> = {
  name: "research",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: ResearchOutputSchema,
  execute: async (input) => {
    // Agent implementation
    return { sources: [], query: input.query };
  },
};

const analysisStage: PipelineStage<
  z.infer<typeof ResearchOutputSchema>,
  z.infer<typeof AnalysisOutputSchema>
> = {
  name: "analysis",
  inputSchema: ResearchOutputSchema,
  outputSchema: AnalysisOutputSchema,
  execute: async (input) => {
    return { themes: [], gaps: [] };
  },
};

const summaryStage: PipelineStage<
  z.infer<typeof AnalysisOutputSchema>,
  z.infer<typeof SummaryOutputSchema>
> = {
  name: "summary",
  inputSchema: AnalysisOutputSchema,
  outputSchema: SummaryOutputSchema,
  execute: async (input) => {
    return { summary: "", keyFindings: [], recommendations: [] };
  },
};

// Run the pipeline
// const result = await runPipeline(
//   [researchStage, analysisStage, summaryStage],
//   { query: "multi-agent best practices" }
// );
```

## Pattern 2: Fan-Out/Fan-In

Multiple agents execute in parallel on different parts of the work.
A final agent aggregates their results.

**Use when:** Work can be divided into independent chunks. Latency matters.
Each chunk can be processed without knowledge of the others.

```typescript
import { z } from "zod";

interface FanOutTask<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
}

interface FanOutConfig<TInput, TFanOutput, TAggOutput> {
  // Split input into parallel tasks
  split: (input: TInput) => Array<{ taskName: string; input: unknown }>;
  // Tasks to execute in parallel
  tasks: Record<string, FanOutTask<unknown, unknown>>;
  // Aggregate results from all tasks
  aggregate: (results: Record<string, unknown>) => Promise<TAggOutput>;
  // Schema for the aggregated output
  aggregateOutputSchema: z.ZodType<TAggOutput>;
  // Maximum concurrent tasks
  concurrency: number;
}

async function fanOutFanIn<TInput, TFanOutput, TAggOutput>(
  config: FanOutConfig<TInput, TFanOutput, TAggOutput>,
  input: TInput,
): Promise<{
  aggregatedResult: TAggOutput;
  taskResults: Record<string, {
    status: "success" | "failure";
    output?: unknown;
    error?: string;
    durationMs: number;
  }>;
}> {
  const taskInputs = config.split(input);
  const taskResults: Record<string, {
    status: "success" | "failure";
    output?: unknown;
    error?: string;
    durationMs: number;
  }> = {};

  // Execute tasks in parallel with concurrency limit
  const chunks: typeof taskInputs[] = [];
  for (let i = 0; i < taskInputs.length; i += config.concurrency) {
    chunks.push(taskInputs.slice(i, i + config.concurrency));
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async ({ taskName, input: taskInput }) => {
      const task = config.tasks[taskName];
      if (!task) {
        taskResults[taskName] = {
          status: "failure",
          error: `Unknown task: ${taskName}`,
          durationMs: 0,
        };
        return;
      }

      const startTime = Date.now();
      try {
        const validInput = task.inputSchema.parse(taskInput);
        const rawOutput = await task.execute(validInput);
        const validOutput = task.outputSchema.parse(rawOutput);
        taskResults[taskName] = {
          status: "success",
          output: validOutput,
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        taskResults[taskName] = {
          status: "failure",
          error: error instanceof Error ? error.message : "Unknown",
          durationMs: Date.now() - startTime,
        };
      }
    });

    await Promise.all(promises);
  }

  // Collect successful results for aggregation
  const successResults: Record<string, unknown> = {};
  for (const [name, result] of Object.entries(taskResults)) {
    if (result.status === "success") {
      successResults[name] = result.output;
    }
  }

  const aggregatedResult = await config.aggregate(successResults);
  const validAggregated = config.aggregateOutputSchema.parse(aggregatedResult);

  return { aggregatedResult: validAggregated, taskResults };
}

// Example: Parallel code review (security, performance, quality)
const SecurityReviewOutput = z.object({
  vulnerabilities: z.array(z.object({
    severity: z.enum(["critical", "high", "medium", "low"]),
    description: z.string(),
  })),
});

const PerformanceReviewOutput = z.object({
  issues: z.array(z.object({
    impact: z.enum(["high", "medium", "low"]),
    description: z.string(),
  })),
});

const QualityReviewOutput = z.object({
  suggestions: z.array(z.object({
    category: z.string(),
    description: z.string(),
  })),
});

const AggregatedReviewOutput = z.object({
  overallScore: z.number().min(0).max(100),
  criticalIssues: z.number().int().nonnegative(),
  allFindings: z.array(z.object({
    source: z.string(),
    description: z.string(),
  })),
});
```

## Pattern 3: Supervisor-Worker

A supervisor agent dynamically delegates tasks to worker agents based on
the current state and requirements.

**Use when:** Task decomposition is dynamic and cannot be predetermined.
The supervisor needs to make routing decisions based on intermediate results.

```typescript
import { z } from "zod";

const WorkerResultSchema = z.object({
  workerId: z.string(),
  taskId: z.string().uuid(),
  status: z.enum(["completed", "failed", "needs_help"]),
  result: z.unknown(),
  metadata: z.object({
    tokensUsed: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
});

const SupervisorDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("delegate"),
    workerId: z.string(),
    task: z.object({
      id: z.string().uuid(),
      type: z.string(),
      input: z.unknown(),
      constraints: z.object({
        maxTokens: z.number().int().positive().optional(),
        timeoutMs: z.number().int().positive().optional(),
      }).optional(),
    }),
  }),
  z.object({
    action: z.literal("aggregate"),
    taskIds: z.array(z.string().uuid()),
    strategy: z.enum(["merge", "best_of", "vote"]),
  }),
  z.object({
    action: z.literal("complete"),
    finalResult: z.unknown(),
    summary: z.string(),
  }),
  z.object({
    action: z.literal("fail"),
    reason: z.string(),
    partialResults: z.array(WorkerResultSchema).default([]),
  }),
]);

type SupervisorDecision = z.infer<typeof SupervisorDecisionSchema>;
type WorkerResult = z.infer<typeof WorkerResultSchema>;

interface Worker {
  id: string;
  capabilities: string[];
  execute: (task: unknown) => Promise<unknown>;
}

class SupervisorOrchestrator {
  private workers: Map<string, Worker>;
  private results: Map<string, WorkerResult>;

  constructor(workers: Worker[]) {
    this.workers = new Map(workers.map((w) => [w.id, w]));
    this.results = new Map();
  }

  async run(
    supervisorDecide: (
      state: { results: WorkerResult[]; pendingTasks: number },
    ) => Promise<SupervisorDecision>,
  ): Promise<{ finalResult: unknown; allResults: WorkerResult[] }> {
    let pendingTasks = 0;
    const maxIterations = 50; // Safety limit

    for (let i = 0; i < maxIterations; i++) {
      const currentResults = Array.from(this.results.values());
      const decision = SupervisorDecisionSchema.parse(
        await supervisorDecide({ results: currentResults, pendingTasks }),
      );

      switch (decision.action) {
        case "delegate": {
          const worker = this.workers.get(decision.workerId);
          if (!worker) {
            throw new Error(`Worker not found: ${decision.workerId}`);
          }
          pendingTasks++;
          try {
            const rawResult = await worker.execute(decision.task.input);
            const result: WorkerResult = {
              workerId: decision.workerId,
              taskId: decision.task.id,
              status: "completed",
              result: rawResult,
              metadata: { tokensUsed: 0, durationMs: 0 },
            };
            this.results.set(decision.task.id, WorkerResultSchema.parse(result));
          } catch (error) {
            const result: WorkerResult = {
              workerId: decision.workerId,
              taskId: decision.task.id,
              status: "failed",
              result: error instanceof Error ? error.message : "Unknown",
              metadata: { tokensUsed: 0, durationMs: 0 },
            };
            this.results.set(decision.task.id, result);
          }
          pendingTasks--;
          break;
        }
        case "aggregate": {
          // Supervisor aggregates results from specified tasks
          break;
        }
        case "complete": {
          return {
            finalResult: decision.finalResult,
            allResults: Array.from(this.results.values()),
          };
        }
        case "fail": {
          throw new Error(
            `Supervisor failed: ${decision.reason}`,
          );
        }
      }
    }

    throw new Error("Supervisor exceeded maximum iterations");
  }
}
```

## Pattern 4: Router Pattern

A router agent examines the input and routes it to the most appropriate
specialized agent. Similar to an API gateway.

**Use when:** Different inputs require fundamentally different processing.
Specialized agents handle specific categories better than a generalist.

```typescript
import { z } from "zod";

const RouteDecisionSchema = z.object({
  targetAgent: z.string(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  transformedInput: z.unknown().optional(),
});

type RouteDecision = z.infer<typeof RouteDecisionSchema>;

interface SpecializedAgent<TInput, TOutput> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
}

class AgentRouter {
  private agents: Map<string, SpecializedAgent<unknown, unknown>>;
  private routingFn: (
    input: unknown,
    availableAgents: Array<{ name: string; description: string }>,
  ) => Promise<RouteDecision>;

  constructor(
    agents: SpecializedAgent<unknown, unknown>[],
    routingFn: (
      input: unknown,
      agents: Array<{ name: string; description: string }>,
    ) => Promise<RouteDecision>,
  ) {
    this.agents = new Map(agents.map((a) => [a.name, a]));
    this.routingFn = routingFn;
  }

  async route(input: unknown): Promise<{
    routeDecision: RouteDecision;
    result: unknown;
    agentUsed: string;
  }> {
    const agentList = Array.from(this.agents.values()).map((a) => ({
      name: a.name,
      description: a.description,
    }));

    // Router decides which agent handles this input
    const decision = RouteDecisionSchema.parse(
      await this.routingFn(input, agentList),
    );

    const agent = this.agents.get(decision.targetAgent);
    if (!agent) {
      throw new Error(`Routed to unknown agent: ${decision.targetAgent}`);
    }

    // Validate and execute
    const agentInput = decision.transformedInput ?? input;
    const validInput = agent.inputSchema.parse(agentInput);
    const rawOutput = await agent.execute(validInput);
    const validOutput = agent.outputSchema.parse(rawOutput);

    return {
      routeDecision: decision,
      result: validOutput,
      agentUsed: decision.targetAgent,
    };
  }
}

// Example: Route customer queries to specialized agents
const billingAgent: SpecializedAgent<
  { query: string; accountId: string },
  { answer: string; actions: string[] }
> = {
  name: "billing",
  description: "Handles billing inquiries, invoices, payment issues",
  inputSchema: z.object({
    query: z.string(),
    accountId: z.string(),
  }),
  outputSchema: z.object({
    answer: z.string(),
    actions: z.array(z.string()),
  }),
  execute: async (input) => ({
    answer: `Billing response for ${input.accountId}`,
    actions: [],
  }),
};

const technicalAgent: SpecializedAgent<
  { query: string; systemInfo: Record<string, string> },
  { answer: string; steps: string[] }
> = {
  name: "technical",
  description: "Handles technical issues, debugging, system configuration",
  inputSchema: z.object({
    query: z.string(),
    systemInfo: z.record(z.string(), z.string()),
  }),
  outputSchema: z.object({
    answer: z.string(),
    steps: z.array(z.string()),
  }),
  execute: async (input) => ({
    answer: `Technical response for: ${input.query}`,
    steps: [],
  }),
};
```

## Pattern 5: Saga Pattern

Long-running workflows with compensating transactions. If a step fails,
previously completed steps are rolled back.

**Use when:** The workflow modifies external state. Partial completion
is worse than full failure. You need transactional guarantees across
agent boundaries.

```typescript
import { z } from "zod";

interface SagaStep<TInput, TOutput> {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  execute: (input: TInput) => Promise<TOutput>;
  compensate: (input: TInput, output: TOutput) => Promise<void>;
}

interface SagaResult {
  success: boolean;
  completedSteps: string[];
  failedStep?: string;
  error?: string;
  compensatedSteps: string[];
  finalOutput?: unknown;
}

async function runSaga(
  steps: SagaStep<unknown, unknown>[],
  initialInput: unknown,
): Promise<SagaResult> {
  const completedSteps: Array<{
    step: SagaStep<unknown, unknown>;
    input: unknown;
    output: unknown;
  }> = [];

  let currentInput: unknown = initialInput;

  for (const step of steps) {
    try {
      const validInput = step.inputSchema.parse(currentInput);
      const rawOutput = await step.execute(validInput);
      const validOutput = step.outputSchema.parse(rawOutput);

      completedSteps.push({
        step,
        input: validInput,
        output: validOutput,
      });

      currentInput = validOutput;
    } catch (error) {
      // Step failed — compensate all completed steps in reverse order
      const compensatedSteps: string[] = [];

      for (let i = completedSteps.length - 1; i >= 0; i--) {
        const { step: completedStep, input, output } = completedSteps[i];
        try {
          await completedStep.compensate(input, output);
          compensatedSteps.push(completedStep.name);
        } catch (compError) {
          // Compensation failure is critical — log and continue
          console.error(
            `Compensation failed for step "${completedStep.name}":`,
            compError,
          );
        }
      }

      return {
        success: false,
        completedSteps: completedSteps.map((s) => s.step.name),
        failedStep: step.name,
        error: error instanceof Error ? error.message : "Unknown error",
        compensatedSteps,
      };
    }
  }

  return {
    success: true,
    completedSteps: completedSteps.map((s) => s.step.name),
    compensatedSteps: [],
    finalOutput: currentInput,
  };
}

// Example: Order processing saga
const reserveInventory: SagaStep<
  { orderId: string; items: Array<{ sku: string; quantity: number }> },
  { reservationId: string; orderId: string }
> = {
  name: "reserve_inventory",
  inputSchema: z.object({
    orderId: z.string().uuid(),
    items: z.array(z.object({
      sku: z.string(),
      quantity: z.number().int().positive(),
    })),
  }),
  outputSchema: z.object({
    reservationId: z.string().uuid(),
    orderId: z.string().uuid(),
  }),
  execute: async (input) => ({
    reservationId: crypto.randomUUID(),
    orderId: input.orderId,
  }),
  compensate: async (_input, output) => {
    // Release the inventory reservation
    console.info(`Releasing reservation ${output.reservationId}`);
  },
};

const processPayment: SagaStep<
  { reservationId: string; orderId: string },
  { paymentId: string; reservationId: string; orderId: string }
> = {
  name: "process_payment",
  inputSchema: z.object({
    reservationId: z.string().uuid(),
    orderId: z.string().uuid(),
  }),
  outputSchema: z.object({
    paymentId: z.string().uuid(),
    reservationId: z.string().uuid(),
    orderId: z.string().uuid(),
  }),
  execute: async (input) => ({
    paymentId: crypto.randomUUID(),
    reservationId: input.reservationId,
    orderId: input.orderId,
  }),
  compensate: async (_input, output) => {
    // Refund the payment
    console.info(`Refunding payment ${output.paymentId}`);
  },
};

// Run the saga
// const sagaResult = await runSaga(
//   [reserveInventory, processPayment],
//   { orderId: crypto.randomUUID(), items: [{ sku: "ABC", quantity: 2 }] }
// );
```

## When to Use Each Pattern

| Pattern | Best For | Avoid When |
|---------|----------|------------|
| Sequential Pipeline | Linear workflows with clear stage dependencies | Tasks can run in parallel |
| Fan-Out/Fan-In | Independent parallel tasks with final aggregation | Tasks depend on each other |
| Supervisor-Worker | Dynamic task decomposition, adaptive workflows | Task structure is known upfront |
| Router | Categorizing inputs to specialized handlers | All inputs need the same processing |
| Saga | Workflows that modify external state and need rollback | Read-only workflows |

### Decision Matrix

```
Is the task decomposition known upfront?
├── YES: Are tasks independent?
│   ├── YES → Fan-Out/Fan-In
│   └── NO → Sequential Pipeline
└── NO: Does the workflow modify external state?
    ├── YES → Saga Pattern
    └── NO: Are there distinct input categories?
        ├── YES → Router Pattern
        └── NO → Supervisor-Worker
```

## Combining Patterns

Patterns compose. A supervisor can use fan-out for parallel subtasks.
A pipeline stage can internally use a router. A saga step can be a
full fan-out/fan-in operation.

```typescript
// Example: Supervisor delegates to a fan-out stage
// Supervisor → decides what to analyze
//   └── Fan-Out → security review, perf review, quality review
//       └── Fan-In → aggregate all reviews
//           └── Supervisor → decides next step based on aggregate

// The key is that each pattern boundary has typed schemas.
// The supervisor's output schema defines the fan-out input.
// The fan-in's output schema defines the supervisor's next input.
// Contracts at every boundary.
```

## Summary

Each orchestration pattern addresses a specific coordination need:

1. **Sequential Pipeline** — ordered chain, stop on failure
2. **Fan-Out/Fan-In** — parallel execution, aggregate results
3. **Supervisor-Worker** — dynamic delegation, adaptive routing
4. **Router** — input classification to specialized agents
5. **Saga** — compensating transactions for stateful workflows

The choice depends on task dependencies, parallelism opportunity, state
modification needs, and whether decomposition is static or dynamic.
All patterns enforce typed schemas at every agent boundary.
