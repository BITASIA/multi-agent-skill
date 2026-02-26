# Anti-Patterns Catalog

Each anti-pattern is documented with: description, symptoms, consequences,
fix, and code example.

---

## 1. God Agent

### Description
A single agent that handles everything: routing, processing, validation,
error handling, state management. It has an enormous prompt, accesses all
tools, and makes all decisions.

### Symptoms
- Prompt exceeds 3000 tokens of instructions
- Agent has access to 20+ tools
- Single point of failure for the entire system
- Changes to one capability break unrelated capabilities
- Debugging requires understanding the entire agent

### Consequences
- Quality degrades as prompt complexity increases
- No failure isolation
- Cannot scale specific capabilities independently
- Impossible to test individual behaviors

### Fix
Decompose into specialized agents with clear responsibilities. Each agent
should have a focused prompt, a limited tool set, and typed input/output
schemas.

```typescript
// ANTI-PATTERN: God Agent
const godAgent = {
  tools: [
    "search", "analyze", "write", "review", "deploy", "notify",
    "create_ticket", "update_database", "send_email", "generate_report",
    "approve", "reject", "escalate", "archive", "schedule",
  ],
  prompt: `You are an all-purpose assistant that handles everything...
    (3000+ tokens of instructions covering 15 different capabilities)`,
};

// FIX: Specialized agents with focused responsibilities
import { z } from "zod";

const ResearchAgentConfig = {
  tools: ["search"],
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxSources: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    sources: z.array(z.object({
      title: z.string(),
      content: z.string(),
      relevance: z.number().min(0).max(1),
    })),
  }),
};

const AnalysisAgentConfig = {
  tools: ["analyze"],
  inputSchema: z.object({
    sources: z.array(z.object({
      title: z.string(),
      content: z.string(),
      relevance: z.number(),
    })),
  }),
  outputSchema: z.object({
    findings: z.array(z.object({
      theme: z.string(),
      confidence: z.number().min(0).max(1),
      evidence: z.array(z.string()),
    })),
  }),
};

// Each agent has 1-3 tools, a focused prompt, and typed contracts
```

---

## 2. Implicit Contract

### Description
Agents communicate with assumed data shapes. No schemas are defined.
The producer and consumer have independent, undocumented expectations
about the data format.

### Symptoms
- No shared type definitions between agents
- Data shapes are defined in comments or documentation, not code
- Changes to one agent's output silently break downstream agents
- "It works on my machine" — different environments produce different shapes

### Consequences
- Silent data corruption
- Impossible to detect contract violations at runtime
- Debugging requires comparing actual data to each agent's expectations
- No automated contract testing

### Fix
Define explicit Zod schemas for every agent boundary. Both producer and
consumer import and validate against the same schema.

```typescript
// ANTI-PATTERN: Implicit contract
async function researchAgent(query: string) {
  const result = await callLLM(`Research: ${query}`);
  return JSON.parse(result); // Shape is whatever the LLM produces
}

async function analysisAgent(researchData: any) {
  // Assumes researchData has .sources array with .content field
  // No validation. No guarantee. Breaks silently.
  const themes = researchData.sources.map((s: any) => s.content);
  return { themes };
}

// FIX: Explicit contract with shared schema
const ResearchOutputSchema = z.object({
  sources: z.array(z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    url: z.string().url(),
    relevance: z.number().min(0).max(1),
  })),
  query: z.string(),
});

async function researchAgentFixed(query: string) {
  const result = await callLLM(`Research: ${query}`);
  return ResearchOutputSchema.parse(JSON.parse(result));
  // Throws immediately if shape is wrong
}

async function analysisAgentFixed(raw: unknown) {
  const research = ResearchOutputSchema.parse(raw);
  // research.sources is guaranteed to have .content
  const themes = research.sources.map((s) => s.content);
  return { themes };
}
```

---

## 3. Fire and Forget

### Description
An agent sends a message or delegates a task without confirming receipt
or tracking completion. The sender assumes the receiver processed it.

### Symptoms
- Tasks silently disappear
- No completion tracking
- "I sent the message" but no proof of delivery
- Inconsistent state: sender thinks task is in progress, receiver never got it

### Consequences
- Silent data loss (see failure mode #6)
- Impossible to detect dropped messages
- No retry capability — you do not know what was lost
- Customer-visible failures with no error trail

### Fix
Require acknowledgment for every inter-agent message. Track pending
messages and alert on unacknowledged ones.

```typescript
// ANTI-PATTERN: Fire and forget
async function delegateTask(agentName: string, task: unknown) {
  await sendMessage(agentName, task);
  // No confirmation. No tracking. Hope for the best.
}

// FIX: Acknowledged messaging
import { z } from "zod";

const TaskDelegationSchema = z.object({
  delegationId: z.string().uuid(),
  task: z.unknown(),
  delegatedTo: z.string(),
  delegatedAt: z.string().datetime(),
  acknowledged: z.boolean().default(false),
  acknowledgedAt: z.string().datetime().optional(),
});

class TrackedDelegation {
  private pending: Map<string, z.infer<typeof TaskDelegationSchema>> = new Map();

  async delegate(
    agentName: string,
    task: unknown,
    sendFn: (agent: string, msg: unknown) => Promise<{ ack: boolean }>,
  ): Promise<string> {
    const delegationId = crypto.randomUUID();
    const delegation = TaskDelegationSchema.parse({
      delegationId,
      task,
      delegatedTo: agentName,
      delegatedAt: new Date().toISOString(),
    });

    this.pending.set(delegationId, delegation);

    const response = await sendFn(agentName, {
      delegationId,
      task,
    });

    if (response.ack) {
      this.pending.set(delegationId, {
        ...delegation,
        acknowledged: true,
        acknowledgedAt: new Date().toISOString(),
      });
    }

    return delegationId;
  }

  getUnacknowledged(): Array<z.infer<typeof TaskDelegationSchema>> {
    return Array.from(this.pending.values()).filter((d) => !d.acknowledged);
  }
}
```

---

## 4. Shared Mutable State

### Description
Multiple agents read and write the same mutable object or variable.
No concurrency control, no versioning, no immutability.

### Symptoms
- Race conditions: different results depending on timing
- Lost updates: one agent's write overwrites another's
- Inconsistent reads: an agent reads a partially updated state
- Non-reproducible bugs

### Consequences
- State corruption (see failure mode #3)
- Impossible to reason about system behavior
- Debugging requires reproducing exact timing
- No safe rollback or recovery

### Fix
Use immutable state with versioned updates and optimistic concurrency.

```typescript
// ANTI-PATTERN: Shared mutable state
const globalState = {
  tasks: [] as Array<{ id: string; status: string }>,
  counters: { processed: 0, failed: 0 },
};

async function agentA() {
  globalState.tasks.push({ id: "1", status: "done" }); // Mutation
  globalState.counters.processed += 1;                   // Race condition
}

async function agentB() {
  globalState.tasks.push({ id: "2", status: "done" }); // Mutation
  globalState.counters.processed += 1;                   // Race condition
}

// FIX: Immutable state with version control
import { z } from "zod";

const StateSchema = z.object({
  version: z.number().int().nonnegative(),
  tasks: z.array(z.object({
    id: z.string(),
    status: z.string(),
  })),
  counters: z.object({
    processed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

type AppState = z.infer<typeof StateSchema>;

function addTask(state: AppState, task: { id: string; status: string }): AppState {
  return {
    ...state,
    version: state.version + 1,
    tasks: [...state.tasks, task],
    counters: {
      ...state.counters,
      processed: state.counters.processed + 1,
    },
  };
}
// State is never mutated. Each update produces a new state.
// Version numbers enable optimistic concurrency control.
```

---

## 5. Retry Storm

### Description
Failed operations are retried immediately, without backoff, without limit.
Multiple agents retry simultaneously, amplifying the load on an already
failing service.

### Symptoms
- Exponentially increasing load on failing services
- API rate limits hit repeatedly
- Token budget exhausted by retries
- System recovery is delayed because retries prevent the failing service from recovering

### Consequences
- Resource exhaustion (see failure mode #7)
- Cascade failure (see failure mode #4)
- Extended outage duration
- Costly token/API usage with no progress

### Fix
Use exponential backoff with jitter, maximum retry limits, and circuit
breakers.

```typescript
// ANTI-PATTERN: Unlimited immediate retries
async function callAgentBad(input: unknown): Promise<unknown> {
  while (true) {
    try {
      return await agent.run(input);
    } catch {
      // Retry immediately, forever. This is a DDoS on your own service.
    }
  }
}

// FIX: Bounded retries with backoff and circuit breaker
async function callAgentGood(input: unknown): Promise<unknown> {
  const maxAttempts = 3;
  const baseDelayMs = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await agent.run(input);
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        throw new Error(
          `Agent failed after ${maxAttempts} attempts: ` +
          `${error instanceof Error ? error.message : "Unknown"}`
        );
      }

      // Exponential backoff with jitter
      const delay = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.random() * delay * 0.1;
      await new Promise((resolve) =>
        setTimeout(resolve, delay + jitter)
      );
    }
  }

  throw new Error("Unreachable");
}
```

---

## 6. Log Nothing

### Description
No structured logging, no correlation IDs, no intermediate state capture.
When something goes wrong, there is no trail to follow.

### Symptoms
- "Something failed but I do not know what"
- Debugging requires adding temporary log statements and re-running
- No way to reconstruct what happened in a past workflow
- Incidents take hours to diagnose

### Consequences
- Extended mean-time-to-resolution (MTTR)
- Unable to detect silent failures
- No data for performance optimization
- Compliance and audit failures

### Fix
Structured logging with correlation IDs at every agent boundary.

```typescript
// ANTI-PATTERN: No logging
async function processTask(task: unknown) {
  const result = await agentA(task);
  const analysis = await agentB(result);
  return await agentC(analysis);
  // If agentB returns garbage, you will never know.
  // If agentC fails, you cannot see what agentB produced.
}

// FIX: Structured logging at every boundary
import { z } from "zod";

async function processTaskLogged(
  task: unknown,
  correlationId: string,
  logger: StructuredLogger,
) {
  logger.info("Pipeline started", { correlationId, taskType: typeof task });

  const result = await logger.timed("agent_a_execution", async () => {
    const output = await agentA(task);
    logger.info("Agent A completed", {
      correlationId,
      outputFields: Object.keys(output as Record<string, unknown>),
    });
    return output;
  });

  const analysis = await logger.timed("agent_b_execution", async () => {
    const output = await agentB(result);
    logger.info("Agent B completed", {
      correlationId,
      analysisThemes: (output as { themes?: unknown[] }).themes?.length ?? 0,
    });
    return output;
  });

  const final = await logger.timed("agent_c_execution", async () => {
    const output = await agentC(analysis);
    logger.info("Agent C completed", { correlationId });
    return output;
  });

  logger.info("Pipeline completed", { correlationId });
  return final;
}

// Reference types for the example
interface StructuredLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  timed<T>(label: string, fn: () => Promise<T>): Promise<T>;
}
declare function agentA(input: unknown): Promise<unknown>;
declare function agentB(input: unknown): Promise<unknown>;
declare function agentC(input: unknown): Promise<unknown>;
```

---

## 7. Premature Multi-Agent

### Description
Using a multi-agent architecture when a single agent with a good prompt
would suffice. Adding coordination overhead, schema definitions, and
orchestration logic for a problem that does not require it.

### Symptoms
- 3+ agents but each agent's prompt is under 200 tokens
- Most agents do the same thing with minor prompt variations
- The orchestration code is longer than the agent prompts
- End-to-end latency is dominated by inter-agent communication
- Token usage is 3-5x what a single agent would consume

### Consequences
- Unnecessary complexity in development and maintenance
- Higher cost (tokens, latency, infrastructure)
- More failure modes to handle
- Harder to onboard new developers

### Fix
Use the scoring rubric (see 11-single-vs-multi-decision.md). Start with
a single agent. Only split when a specific dimension demands it.

```typescript
// ANTI-PATTERN: Multi-agent for a simple task
// Three agents to generate a blog post:

const outlineAgent = { prompt: "Generate an outline for: {topic}" };
const draftAgent = { prompt: "Write a draft from this outline: {outline}" };
const editAgent = { prompt: "Edit this draft for clarity: {draft}" };

// Each agent call: ~500ms latency, ~1000 tokens context
// Total: ~1500ms, ~3000 tokens, plus orchestration code

// FIX: Single agent with a structured prompt
const blogAgent = {
  prompt: `Generate a blog post about: {topic}

    Steps:
    1. Create an outline with 3-5 sections
    2. Write each section with 2-3 paragraphs
    3. Edit for clarity and flow

    Output the final blog post.`,
};

// Single call: ~500ms, ~1000 tokens, no orchestration needed
// Same quality. Lower cost. Simpler code.
```

---

## 8. Chatty Agents

### Description
Agents exchange many small messages instead of fewer, well-structured
ones. Each round-trip adds latency and token overhead.

### Symptoms
- Agent A sends a question, Agent B responds, Agent A asks a follow-up...
  (multiple round-trips for what could be one exchange)
- 10+ messages between agents for a single task
- Most of the execution time is message passing, not processing
- Token usage is dominated by repeated context in each message

### Consequences
- High latency from accumulated round-trips
- Excessive token usage from repeated context
- Harder to trace and debug
- Fragile: any message failure breaks the conversation

### Fix
Design agent interfaces to exchange complete, self-contained messages.
One request, one response. Include all necessary context in each message.

```typescript
// ANTI-PATTERN: Chatty exchange
// Message 1: "What files should I review?"
// Message 2: "Review auth.ts and login.ts"
// Message 3: "What should I focus on?"
// Message 4: "Focus on security issues"
// Message 5: "Here are my findings for auth.ts..."
// Message 6: "Now review login.ts"
// Message 7: "Here are my findings for login.ts..."
// 7 messages, 7 round-trips, repeated context in each

// FIX: Self-contained request and response
import { z } from "zod";

const ReviewRequestSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    content: z.string(),
    language: z.string(),
  })),
  focusAreas: z.array(z.enum(["security", "performance", "quality"])),
  context: z.string().optional(),
});

const ReviewResponseSchema = z.object({
  findings: z.array(z.object({
    file: z.string(),
    line: z.number().int().positive(),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.string(),
    message: z.string(),
    suggestedFix: z.string().optional(),
  })),
  overallScore: z.number().min(0).max(100),
  summary: z.string(),
});

// One request. One response. All context included.
// 1 round-trip instead of 7.
```

---

## 9. Missing Circuit Breaker

### Description
No mechanism to stop calling a failing agent. When an agent starts
failing, every caller keeps trying, amplifying the problem.

### Symptoms
- A failing agent receives increasing load from retries
- Downstream agents queue up waiting for the failing agent
- System resources are consumed by doomed requests
- Recovery is delayed because the failing agent cannot stabilize

### Consequences
- Cascade failure (see failure mode #4)
- Extended outage duration
- Resource exhaustion across the system
- Total system failure from a single agent's issue

### Fix
Wrap every agent call in a circuit breaker. When failures exceed a
threshold, stop calling and fail fast.

```typescript
// ANTI-PATTERN: No circuit breaker
async function callAnalysisAgent(input: unknown) {
  // If the analysis agent is down, every caller retries indefinitely,
  // overwhelming the agent and preventing recovery.
  return await retryForever(async () => {
    return await analysisAgent.run(input);
  });
}

async function retryForever<T>(fn: () => Promise<T>): Promise<T> {
  while (true) {
    try { return await fn(); } catch { /* keep trying */ }
  }
}

// FIX: Circuit breaker protects the failing agent
class SimpleCircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private threshold: number = 5,
    private resetMs: number = 30_000,
  ) {}

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit open: agent is unavailable");
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

// Usage
const analysisBreaker = new SimpleCircuitBreaker(5, 30_000);

async function callAnalysisAgentSafe(input: unknown) {
  return await analysisBreaker.call(async () => {
    return await analysisAgent.run(input);
  });
}

declare const analysisAgent: { run: (input: unknown) => Promise<unknown> };
```

---

## 10. Schema Bypass

### Description
Skipping validation "for speed" or "because we trust the data." Passing
raw, unvalidated data between agents to avoid the overhead of schema
parsing.

### Symptoms
- `as any` or `as unknown` casts at agent boundaries
- "We'll add validation later" (later never comes)
- Intermittent type errors in production
- Bugs that only appear with certain data patterns

### Consequences
- Every failure mode in the catalog becomes possible
- Silent data corruption
- No compile-time or runtime safety
- Debugging requires manual data inspection

### Fix
Always validate. The performance cost of Zod parsing is negligible
compared to the debugging cost of unvalidated data. If performance is
truly a concern, validate at boundaries only (not at every function call).

```typescript
// ANTI-PATTERN: Schema bypass "for performance"
async function fastPipeline(input: unknown) {
  // "We trust the research agent's output, skip validation"
  const research = await researchAgent(input) as any;
  // "Analysis agent always produces the right shape"
  const analysis = await analysisAgent(research) as any;
  // "Just ship it"
  return analysis.summary;
  // When research agent changes its output format → silent failure
  // When analysis.summary is undefined → returns undefined to the user
}

// FIX: Validate at every boundary
import { z } from "zod";

const ResearchOutput = z.object({
  sources: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })),
});

const AnalysisOutput = z.object({
  summary: z.string().min(1),
  themes: z.array(z.string()),
});

async function safePipeline(input: unknown) {
  const rawResearch = await researchAgent(input);
  const research = ResearchOutput.parse(rawResearch);
  // If shape is wrong: immediate, clear error with path and message

  const rawAnalysis = await analysisAgent(research);
  const analysis = AnalysisOutput.parse(rawAnalysis);
  // If summary is missing: "summary: Required" — instantly debuggable

  return analysis.summary;
  // Guaranteed to be a non-empty string
}

declare function researchAgent(input: unknown): Promise<unknown>;
declare function analysisAgent(input: unknown): Promise<unknown>;
```

### Performance Reality Check

```typescript
// Zod parse performance for a typical agent output schema:
// - Simple object (5 fields): ~0.01ms
// - Complex object (20 fields, nested): ~0.05ms
// - Large array (100 items): ~0.5ms

// Agent LLM call:
// - Typical latency: 500-5000ms
// - Token cost: $0.001-$0.01 per call

// Validation overhead: <0.1% of total pipeline time
// Debugging time saved: hours to days per incident avoided
// The math is clear: always validate.
```

---

## Anti-Pattern Detection Checklist

Use this checklist to audit an existing multi-agent system:

```typescript
const antiPatternAudit = {
  "God Agent": {
    check: "Does any agent have access to more than 5 tools?",
    check2: "Is any agent's prompt longer than 1500 tokens?",
  },
  "Implicit Contract": {
    check: "Is every agent boundary covered by a Zod schema?",
    check2: "Do producer and consumer import the same schema?",
  },
  "Fire and Forget": {
    check: "Is every inter-agent message acknowledged?",
    check2: "Can you list all undelivered messages at any time?",
  },
  "Shared Mutable State": {
    check: "Is there any `let` or mutation at the module level?",
    check2: "Are all state updates producing new objects?",
  },
  "Retry Storm": {
    check: "Does every retry have a maximum attempt count?",
    check2: "Is exponential backoff used for all retries?",
  },
  "Log Nothing": {
    check: "Does every agent boundary log structured data?",
    check2: "Is a correlation ID propagated through the workflow?",
  },
  "Premature Multi-Agent": {
    check: "Would a single prompt produce acceptable quality?",
    check2: "Is the scoring rubric total above 12?",
  },
  "Chatty Agents": {
    check: "Are agent exchanges self-contained (one request, one response)?",
    check2: "Are there fewer than 3 round-trips per task?",
  },
  "Missing Circuit Breaker": {
    check: "Is every external agent call wrapped in a circuit breaker?",
    check2: "Do circuit breakers have configured thresholds?",
  },
  "Schema Bypass": {
    check: "Are there any `as any` casts at agent boundaries?",
    check2: "Is `.parse()` or `.safeParse()` called at every boundary?",
  },
};
```

## Summary

The ten anti-patterns fall into three categories:

**Design anti-patterns** (1, 7, 8): God Agent, Premature Multi-Agent,
Chatty Agents. Fix by choosing the right architecture and designing
clean agent interfaces.

**Contract anti-patterns** (2, 3, 10): Implicit Contract, Fire and Forget,
Schema Bypass. Fix by defining explicit schemas, requiring acknowledgment,
and always validating.

**Resilience anti-patterns** (4, 5, 6, 9): Shared Mutable State, Retry
Storm, Log Nothing, Missing Circuit Breaker. Fix by using immutable state,
bounded retries, structured logging, and circuit breakers.

Every anti-pattern has a concrete, implementable fix. The cost of fixing
them upfront is a fraction of the cost of debugging them in production.
