# Foundations: Why Multi-Agent Systems Fail

## The Distributed Systems Analogy

Multi-agent systems are distributed systems. Every principle that applies to
microservices, message queues, and networked services applies to agents. The
moment you have two or more agents exchanging data, you inherit every problem
that distributed computing has spent decades solving.

Each agent is an unreliable network service:

- It may return malformed data
- It may take longer than expected
- It may fail silently
- It may succeed but produce nonsensical output
- It may interpret the same input differently over time

```typescript
// An agent call is fundamentally no different from an HTTP request
// to an unreliable service. Treat it that way.

type AgentCall = {
  input: unknown;    // Could be anything
  output: unknown;   // Could be anything
  latency: number;   // Unpredictable
  succeeded: boolean; // Never guaranteed
};

// The Fallacies of Distributed Computing, applied to agents:
// 1. The agent is reliable
// 2. Latency is zero
// 3. Output is always well-formed
// 4. The agent's interpretation is consistent
// 5. There is one agent (no coordination needed)
// 6. Context is free (tokens cost money)
// 7. The agent is deterministic
// 8. State is always fresh
```

The critical insight: when you build a multi-agent system without contracts,
you are building a distributed system without protocols. No engineer would
ship a microservice architecture where services exchange untyped JSON blobs
with no API contracts. Yet this is exactly how most multi-agent systems are
built.

## Common Failure Categories

### 1. Data Integrity Failures

Agents pass data to each other with no validation. The receiving agent
interprets the data differently than the sender intended.

```typescript
// Agent A produces a "task result"
const agentAOutput = {
  status: "done",
  result: { score: 85, summary: "Looks good" },
};

// Agent B expects a different shape
// It reads `result.rating` (undefined) instead of `result.score`
// No error is thrown. The pipeline continues with undefined values.
function agentBProcess(input: any) {
  const rating = input.result.rating; // undefined — silent failure
  const passed = rating > 70;         // false — wrong conclusion
  return { passed, rating };
}
```

This is the most common failure mode. It produces no errors, no crashes,
just wrong results that propagate through the entire system.

### 2. Action Ambiguity

Agents take actions, but the set of valid actions is unconstrained. An agent
may invent actions that no downstream system knows how to handle.

```typescript
// Without constrained actions, an agent might produce:
const action = {
  type: "update_user",  // or "updateUser"? or "PATCH_USER"?
  data: { name: "Alice" },
};

// Is "update_user" a valid action? Who handles it?
// What if the agent invents "modify_user" instead?
// There is no compile-time or runtime check.
```

### 3. State Management Failures

Multiple agents read and write shared state without coordination. Race
conditions, stale reads, and lost updates are inevitable.

```typescript
// Two agents read the same task list simultaneously
// Agent A: reads tasks, adds task #4
// Agent B: reads tasks (before A writes), adds task #5
// Agent A writes: [1, 2, 3, 4]
// Agent B writes: [1, 2, 3, 5]  ← task #4 is lost

let sharedState = { tasks: [1, 2, 3] }; // Mutable shared state = bugs
```

### 4. Cascade Failures

One agent fails and the failure propagates through the entire pipeline.
No circuit breakers, no fallbacks, no isolation.

```typescript
// Pipeline: Research → Analyze → Summarize → Deliver
// If "Analyze" fails, the entire pipeline fails.
// Worse: if "Analyze" returns garbage, every downstream agent
// processes garbage with full confidence.

async function naivePipeline(input: string) {
  const research = await researchAgent(input);
  const analysis = await analyzeAgent(research);   // Returns garbage
  const summary = await summarizeAgent(analysis);   // Summarizes garbage
  const delivery = await deliverAgent(summary);     // Delivers garbage
  return delivery; // Confidently wrong
}
```

## The Three Core Patterns

Every reliable multi-agent system is built on three patterns. They are
not optional. They are the minimum viable contract system.

### Pattern 1: Typed Schemas (Zod)

Every piece of data that crosses an agent boundary has a schema. The schema
is defined once, shared between sender and receiver, and validated at runtime.

```typescript
import { z } from "zod";

// Define the contract once
const TaskResultSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(["completed", "failed", "partial"]),
  score: z.number().min(0).max(100),
  summary: z.string().min(1).max(2000),
  artifacts: z.array(z.string().url()).default([]),
  completedAt: z.string().datetime(),
});

type TaskResult = z.infer<typeof TaskResultSchema>;

// Agent A: validate output before sending
function agentAComplete(raw: unknown): TaskResult {
  return TaskResultSchema.parse(raw); // Throws if invalid
}

// Agent B: validate input before processing
function agentBReceive(raw: unknown): TaskResult {
  return TaskResultSchema.parse(raw); // Throws if invalid
}
```

### Pattern 2: Action Schemas (Discriminated Unions)

Every action an agent can take is defined as a discriminated union. The set
of valid actions is finite, typed, and exhaustively handled.

```typescript
import { z } from "zod";

const AgentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("approve"),
    taskId: z.string().uuid(),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("reject"),
    taskId: z.string().uuid(),
    reason: z.string(),
    suggestedFixes: z.array(z.string()),
  }),
  z.object({
    type: z.literal("escalate"),
    taskId: z.string().uuid(),
    escalateTo: z.enum(["senior_agent", "human"]),
    context: z.string(),
  }),
]);

type AgentAction = z.infer<typeof AgentActionSchema>;

// Exhaustive handling — TypeScript ensures every case is covered
function handleAction(action: AgentAction): string {
  switch (action.type) {
    case "approve":
      return `Approved task ${action.taskId}: ${action.reason}`;
    case "reject":
      return `Rejected task ${action.taskId}: ${action.suggestedFixes.join(", ")}`;
    case "escalate":
      return `Escalated task ${action.taskId} to ${action.escalateTo}`;
  }
}
```

### Pattern 3: MCP Contracts (Model Context Protocol)

Every tool an agent can call has a typed contract that is validated before
execution. MCP provides the protocol; Zod provides the enforcement.

```typescript
import { z } from "zod";

// Tool contract: defines what the tool accepts and returns
const SearchToolContract = {
  name: "search_documents",
  description: "Search the document store by query",
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(50).default(10),
    filters: z.object({
      dateAfter: z.string().datetime().optional(),
      category: z.enum(["technical", "business", "legal"]).optional(),
    }).optional(),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      id: z.string(),
      title: z.string(),
      snippet: z.string(),
      relevance: z.number().min(0).max(1),
    })),
    totalCount: z.number().int().min(0),
  }),
};

// Validation middleware — runs before and after every tool call
async function executeWithContract<I, O>(
  contract: { inputSchema: z.ZodType<I>; outputSchema: z.ZodType<O> },
  input: unknown,
  handler: (validInput: I) => Promise<unknown>,
): Promise<O> {
  const validInput = contract.inputSchema.parse(input);
  const rawOutput = await handler(validInput);
  return contract.outputSchema.parse(rawOutput);
}
```

## Mental Model Shift

### From: Agents Chat

The naive model treats agents as participants in a conversation. They send
messages back and forth, interpreting each other's natural language output.

Problems with this model:
- Natural language is ambiguous
- Interpretation varies between runs
- No way to validate understanding
- Errors are semantic, not syntactic (hardest to detect)
- Debugging requires reading conversations

### To: Services with Contracts

The correct model treats agents as services with typed APIs. They exchange
structured data that is validated at every boundary.

Benefits of this model:
- Data shape is guaranteed
- Invalid data is caught immediately
- Errors are structural (easy to detect and fix)
- Debugging uses structured logs
- Agents are independently testable

```typescript
// BEFORE: Agents chat
// Agent A → "I found 3 issues. The most critical is the SQL injection
//            in the login handler. Priority: high."
// Agent B → (parses natural language, maybe gets it right, maybe not)

// AFTER: Services with contracts
const FindingSchema = z.object({
  id: z.string().uuid(),
  severity: z.enum(["critical", "high", "medium", "low"]),
  category: z.string(),
  location: z.object({
    file: z.string(),
    line: z.number().int().positive(),
  }),
  description: z.string(),
  suggestedFix: z.string().optional(),
});

const ReviewResultSchema = z.object({
  findings: z.array(FindingSchema),
  overallRisk: z.enum(["critical", "high", "medium", "low", "none"]),
  reviewedFiles: z.array(z.string()),
  timestamp: z.string().datetime(),
});

// Agent A produces validated structured output
// Agent B receives validated structured input
// No ambiguity. No interpretation. No silent failures.
```

## The Cost of Not Having Contracts

### Example 1: The Phantom Field

Agent A returns `{ confidence: 0.95 }`. Agent B reads `{ score: undefined }`
because it expects a different field name. Agent B proceeds with a default
score of 0. The pipeline reports that every task failed quality checks.
Three hours of debugging later: a field name mismatch.

### Example 2: The Type Coercion

Agent A returns `{ count: "42" }` (string). Agent B computes
`count + 1 = "421"` (string concatenation instead of addition). The
aggregation agent reports 421 items instead of 43. The error is only
caught when a human notices the number is implausible.

### Example 3: The Missing Enum

Agent A returns `{ status: "in_progress" }`. Agent B's switch statement
handles "pending", "completed", and "failed". The "in_progress" status
falls through to the default case, which logs a warning and skips the task.
The task is silently dropped.

```typescript
// All three examples are prevented by a single Zod schema:
const TaskStatusSchema = z.object({
  confidence: z.number().min(0).max(1),
  count: z.number().int().nonnegative(),
  status: z.enum(["pending", "completed", "failed", "in_progress"]),
});

// Field names are enforced. Types are enforced. Enums are enforced.
// Any mismatch throws immediately with a clear error message.
```

### Example 4: The Cascade of Garbage

A research agent hallucinates a citation. The analysis agent treats it as
fact. The summary agent highlights it. The delivery agent sends it to the
user. Four agents processed a hallucination with full confidence because
none of them validated the data.

```typescript
// With contracts, the research agent's output is validated:
const CitationSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  publishedDate: z.string().datetime(),
  source: z.string().min(1),
  // The schema cannot prevent hallucination, but it can:
  // 1. Ensure the URL is syntactically valid
  // 2. Enable a validation step that checks the URL resolves
  // 3. Provide structure for a fact-checking agent to verify
});
```

## When Multi-Agent Is Overkill vs. Necessary

### Multi-Agent Is Overkill When:

1. **The task is a single skill.** Summarization, translation, code
   generation — one agent with good prompting suffices.
2. **There is no genuine specialization.** If every agent uses the same
   prompt with minor variations, you have one agent pretending to be many.
3. **The data flow is linear with no branching.** A simple prompt chain
   (do A, then B, then C) does not need agent infrastructure.
4. **The overhead exceeds the benefit.** Multi-agent adds coordination
   cost, latency, token cost, and debugging complexity.

### Multi-Agent Is Necessary When:

1. **Tasks require genuinely different capabilities.** A code reviewer
   needs different context and skills than a test writer.
2. **Failure isolation is critical.** You need one agent's failure to
   not cascade to others.
3. **Tasks can run in parallel.** Multiple agents working simultaneously
   reduce total latency.
4. **State is complex enough to require explicit management.** When the
   workflow has branches, loops, and recovery paths.
5. **Scale requires it.** Processing 1000 items in parallel needs
   independent agent instances.

```typescript
// Decision heuristic:
// If you can describe the entire workflow in a single prompt
// and the output quality is acceptable, use a single agent.

// If you find yourself writing:
//   "First, act as a researcher. Then, act as an analyst.
//    Then, act as a writer."
// You MIGHT need multi-agent. But only if:
// - Each role genuinely benefits from separate context
// - You need failure isolation between roles
// - You need to scale roles independently
// - The combined prompt exceeds context limits
```

## Summary

Multi-agent systems fail for the same reasons distributed systems fail:
unvalidated data, ambiguous interfaces, unmanaged state, and cascading
failures. The three core patterns — typed schemas, action schemas, and
MCP contracts — are the minimum viable contract system. They transform
agents from unreliable chat participants into testable, composable services.

The rest of this reference series builds on these foundations. Every pattern,
every testing strategy, every observability technique is grounded in this
core principle: agents are services, and services need contracts.
