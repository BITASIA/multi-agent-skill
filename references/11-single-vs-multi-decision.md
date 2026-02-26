# Decision Framework: Single vs Multi-Agent

## The 5-Dimension Scoring Rubric

Score each dimension from 1 to 5. Sum the scores to determine whether
a multi-agent approach is justified.

### Dimension 1: Task Decomposability (1-5)

Can the task be broken into independent sub-tasks?

| Score | Description | Example |
|-------|-------------|---------|
| 1 | Monolithic — cannot be meaningfully decomposed | Translating a sentence |
| 2 | Sequential — steps exist but each depends entirely on the previous | Summarize, then format |
| 3 | Partially decomposable — some steps can be isolated | Research + write (research is independent) |
| 4 | Highly decomposable — most steps are independent | Analyze code for security, performance, quality |
| 5 | Fully decomposable — all sub-tasks are independent | Process 100 customer tickets independently |

```typescript
// Score 1: Cannot decompose — one agent, one prompt
async function translateSentence(text: string, targetLang: string) {
  return await callAgent("translate", { text, targetLang });
}

// Score 5: Fully decomposable — each ticket is independent
async function processTickets(tickets: Ticket[]) {
  // Each ticket can be processed by a separate agent instance
  return await Promise.all(
    tickets.map((ticket) => callAgent("ticket-processor", ticket))
  );
}
```

### Dimension 2: Skill Specialization (1-5)

Do sub-tasks require genuinely different capabilities?

| Score | Description | Example |
|-------|-------------|---------|
| 1 | Uniform — all tasks use the same skill | Batch text classification |
| 2 | Minor variation — same skill with different parameters | Summarize at different lengths |
| 3 | Moderate — some tasks benefit from different prompts | Research vs. writing |
| 4 | High — tasks need different tools or models | Code analysis + natural language summary |
| 5 | Extreme — tasks need fundamentally different capabilities | SQL queries + image analysis + legal review |

```typescript
// Score 1: Same skill, just batched — one agent is enough
const classifications = items.map((item) =>
  classifyAgent.run(item)
);

// Score 5: Fundamentally different skills
const sqlResult = await sqlAgent.run(query);          // Needs SQL expertise
const imageResult = await visionAgent.run(image);      // Needs vision model
const legalResult = await legalAgent.run(contract);    // Needs legal knowledge
```

### Dimension 3: State Complexity (1-5)

How complex is the shared state between sub-tasks?

| Score | Description | Example |
|-------|-------------|---------|
| 1 | Stateless — no shared state between tasks | Independent classifications |
| 2 | Simple handoff — output of one is input to next | Pipeline with no branching |
| 3 | Shared context — tasks read common context | Multiple agents reference same document |
| 4 | Shared mutable state — tasks modify common state | Collaborative editing, task boards |
| 5 | Complex state machine — branching, loops, recovery | Order processing with rollback |

### Dimension 4: Failure Isolation Needs (1-5)

How important is it that one sub-task's failure does not affect others?

| Score | Description | Example |
|-------|-------------|---------|
| 1 | No isolation needed — fail together is fine | Quick one-shot generation |
| 2 | Minor — retry the whole thing on failure | Short pipeline, cheap to restart |
| 3 | Moderate — some tasks should survive others' failures | Optional enrichment steps |
| 4 | High — failures must be contained | Financial transactions, external API calls |
| 5 | Critical — cascade failure is catastrophic | Production systems, customer-facing workflows |

### Dimension 5: Scaling Requirements (1-5)

Does the system need to scale sub-tasks independently?

| Score | Description | Example |
|-------|-------------|---------|
| 1 | Fixed scale — always the same amount of work | Single document analysis |
| 2 | Slight variation — occasionally more work | 1-10 items to process |
| 3 | Moderate — workload varies significantly | 10-100 items, some parallelizable |
| 4 | High — need to scale specific components | Some agents handle 10x more traffic |
| 5 | Extreme — elastic scaling is essential | Processing thousands of items, bursty workloads |

## Scoring Thresholds

Sum all five dimensions:

| Total Score | Recommendation |
|-------------|---------------|
| 5-12 | **Single agent.** Multi-agent adds overhead without sufficient benefit. |
| 13-18 | **Consider multi-agent.** Evaluate whether the complexity tax is justified. |
| 19-25 | **Multi-agent recommended.** The problem characteristics strongly favor it. |

```typescript
import { z } from "zod";

const DecisionScoreSchema = z.object({
  taskDecomposability: z.number().int().min(1).max(5),
  skillSpecialization: z.number().int().min(1).max(5),
  stateComplexity: z.number().int().min(1).max(5),
  failureIsolation: z.number().int().min(1).max(5),
  scalingRequirements: z.number().int().min(1).max(5),
});

type DecisionScore = z.infer<typeof DecisionScoreSchema>;

function evaluateArchitecture(score: DecisionScore): {
  total: number;
  recommendation: "single_agent" | "consider_multi" | "multi_agent";
  reasoning: string;
} {
  const validated = DecisionScoreSchema.parse(score);
  const total =
    validated.taskDecomposability +
    validated.skillSpecialization +
    validated.stateComplexity +
    validated.failureIsolation +
    validated.scalingRequirements;

  if (total <= 12) {
    return {
      total,
      recommendation: "single_agent",
      reasoning:
        "The problem does not have enough complexity, specialization, or " +
        "scaling needs to justify multi-agent coordination overhead.",
    };
  }

  if (total <= 18) {
    return {
      total,
      recommendation: "consider_multi",
      reasoning:
        "The problem has some characteristics that benefit from multi-agent, " +
        "but the overhead may not be justified. Consider starting with a " +
        "single agent and migrating if complexity grows.",
    };
  }

  return {
    total,
    recommendation: "multi_agent",
    reasoning:
      "The problem has high decomposability, specialization, state " +
      "complexity, isolation needs, or scaling requirements that " +
      "strongly favor a multi-agent architecture.",
  };
}
```

## Real-World Scoring Examples

### Example 1: Code Review Bot

A bot that reviews pull requests for code quality.

```typescript
const codeReviewScore: DecisionScore = {
  taskDecomposability: 4,   // Security, performance, quality are independent
  skillSpecialization: 3,   // Different review types need different focus
  stateComplexity: 2,       // Shared context (the PR), but minimal state
  failureIsolation: 3,      // One review type failing shouldn't block others
  scalingRequirements: 2,   // Usually one PR at a time
};
// Total: 14 → "consider_multi"
// Verdict: Multi-agent is reasonable here. Security, performance, and
// quality reviews can run in parallel with different specialized prompts.
// But a single agent with a comprehensive prompt may suffice if the
// codebase is small.
```

### Example 2: Customer Support System

Automated customer support handling billing, technical, and general queries.

```typescript
const customerSupportScore: DecisionScore = {
  taskDecomposability: 3,   // Queries are independent but may escalate
  skillSpecialization: 4,   // Billing vs. technical vs. general = very different
  stateComplexity: 4,       // Customer history, open tickets, account state
  failureIsolation: 5,      // Customer-facing — failures must be contained
  scalingRequirements: 4,   // Bursty traffic, different query types peak differently
};
// Total: 20 → "multi_agent"
// Verdict: Multi-agent is strongly recommended. Different query types
// need specialized agents, failure isolation is critical for customer
// experience, and scaling needs vary by query type.
```

### Example 3: Data Pipeline

Extract, transform, and load data from multiple sources.

```typescript
const dataPipelineScore: DecisionScore = {
  taskDecomposability: 5,   // Each source is fully independent
  skillSpecialization: 3,   // Different sources need different extractors
  stateComplexity: 3,       // Shared destination, dedup requirements
  failureIsolation: 4,      // One source failing shouldn't block others
  scalingRequirements: 5,   // Sources vary enormously in data volume
};
// Total: 20 → "multi_agent"
// Verdict: Multi-agent for independent source processing. Each source
// gets its own agent (or agent pool) with independent failure handling.
```

### Example 4: Blog Post Generator

Generate a blog post from a topic.

```typescript
const blogPostScore: DecisionScore = {
  taskDecomposability: 2,   // Outline → draft → edit is sequential
  skillSpecialization: 2,   // Same model, slightly different prompts
  stateComplexity: 1,       // Simple input → output
  failureIsolation: 1,      // Cheap to retry from scratch
  scalingRequirements: 1,   // One post at a time
};
// Total: 7 → "single_agent"
// Verdict: Single agent with a good prompt. Multi-agent adds latency
// and complexity without meaningful benefit.
```

## The Complexity Tax

Multi-agent adds overhead in several dimensions:

```typescript
const complexityTax = {
  latency: {
    description: "Inter-agent communication adds latency",
    typical: "100-500ms per agent boundary",
    mitigation: "Parallel execution where possible",
  },
  tokenCost: {
    description: "Each agent needs context, multiplying token usage",
    typical: "2-5x token usage vs single agent",
    mitigation: "Minimal context passing, schema-based communication",
  },
  debugging: {
    description: "Failures span multiple agents, harder to trace",
    typical: "3-10x debugging time without observability",
    mitigation: "Correlation IDs, structured logging, distributed tracing",
  },
  development: {
    description: "More code for orchestration, contracts, testing",
    typical: "2-4x initial development time",
    mitigation: "Reusable patterns, schema libraries, test harnesses",
  },
  maintenance: {
    description: "Schema evolution, version compatibility, coordination",
    typical: "1.5-3x ongoing maintenance",
    mitigation: "Schema registry, backward compatibility, contract tests",
  },
};
```

## Migration Path: Single to Multi-Agent

Start with a single agent. Migrate to multi-agent when specific pain
points emerge.

```
Stage 1: Single Agent
├── One prompt handles everything
├── Simple, fast, cheap
└── Works until: prompt is too long, quality drops, failures cascade

Stage 2: Prompt Chain
├── Break the prompt into sequential steps
├── Each step is still the same agent/model
├── Validates output between steps
└── Works until: steps need different skills, parallelism needed

Stage 3: Specialized Agents
├── Different prompts/models for different steps
├── Typed schemas between agents
├── Independent failure handling
└── Works until: scale requires independent scaling

Stage 4: Full Multi-Agent
├── Independent agent services
├── Orchestration layer
├── Full observability and resilience
└── The "distributed system" architecture
```

```typescript
// Stage 1: Single agent
async function handleQuery(query: string): Promise<string> {
  return await callLLM(`Research, analyze, and summarize: ${query}`);
}

// Stage 2: Prompt chain with validation
async function handleQueryV2(query: string): Promise<string> {
  const research = ResearchOutputSchema.parse(
    await callLLM(`Research: ${query}`)
  );
  const analysis = AnalysisOutputSchema.parse(
    await callLLM(`Analyze: ${JSON.stringify(research)}`)
  );
  return await callLLM(`Summarize: ${JSON.stringify(analysis)}`);
}

// Stage 3: Specialized agents
async function handleQueryV3(query: string): Promise<string> {
  const research = await researchAgent.run({ query });  // Specialized prompt + tools
  const analysis = await analysisAgent.run(research);    // Different model/prompt
  return await summaryAgent.run(analysis);               // Writing-optimized
}

// Stage 4: Full multi-agent with orchestration
async function handleQueryV4(query: string): Promise<string> {
  const result = await orchestrator.run({
    workflow: "research-analyze-summarize",
    input: { query },
    config: {
      retryPolicy: { strategy: "exponential_jitter", maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 10000, retryableErrors: [], nonRetryableErrors: [] },
      circuitBreaker: { failureThreshold: 5, resetTimeoutMs: 30000 },
      timeout: 120_000,
    },
  });
  return result.summary;
}
```

## Decision Tree (Text)

```
Is the task a single skill (translate, classify, summarize)?
├── YES → Single agent. Done.
└── NO → Continue.

Can you describe the full workflow in one prompt under 2000 tokens?
├── YES → Is the quality acceptable?
│   ├── YES → Single agent. Done.
│   └── NO → Prompt chain (Stage 2). Re-evaluate after.
└── NO → Continue.

Do sub-tasks need genuinely different capabilities?
├── NO → Prompt chain with the same model. Done.
└── YES → Continue.

Is failure isolation important?
├── NO → Specialized agents (Stage 3) without orchestration.
└── YES → Continue.

Do you need independent scaling?
├── NO → Specialized agents (Stage 3) with basic orchestration.
└── YES → Full multi-agent (Stage 4) with resilience stack.

At any stage, if the complexity tax exceeds the benefit:
→ Step back one stage.
```

## Scoring Calculator

```typescript
function shouldUseMultiAgent(
  answers: {
    canDecomposeIntoIndependentTasks: boolean;
    tasksNeedDifferentSkills: boolean;
    sharedStateBeyondSimpleHandoff: boolean;
    failureIsolationMatters: boolean;
    needsIndependentScaling: boolean;
    workloadExceeds100Items: boolean;
    singlePromptQualityAcceptable: boolean;
    budgetForComplexity: boolean;
  },
): {
  recommendation: string;
  confidence: "high" | "medium" | "low";
  reasoning: string[];
} {
  const reasoning: string[] = [];

  // Strong signals for single agent
  if (answers.singlePromptQualityAcceptable) {
    reasoning.push("Single prompt produces acceptable quality — start there.");
    return {
      recommendation: "single_agent",
      confidence: "high",
      reasoning,
    };
  }

  if (!answers.canDecomposeIntoIndependentTasks && !answers.tasksNeedDifferentSkills) {
    reasoning.push("Task is not decomposable and does not need specialization.");
    return {
      recommendation: "single_agent",
      confidence: "high",
      reasoning,
    };
  }

  // Count multi-agent signals
  const multiSignals = [
    answers.canDecomposeIntoIndependentTasks,
    answers.tasksNeedDifferentSkills,
    answers.failureIsolationMatters,
    answers.needsIndependentScaling,
    answers.workloadExceeds100Items,
  ].filter(Boolean).length;

  if (multiSignals >= 4 && answers.budgetForComplexity) {
    reasoning.push(`${multiSignals}/5 multi-agent signals are present.`);
    reasoning.push("Budget for complexity is available.");
    return {
      recommendation: "multi_agent",
      confidence: "high",
      reasoning,
    };
  }

  if (multiSignals >= 2) {
    reasoning.push(`${multiSignals}/5 multi-agent signals are present.`);
    reasoning.push("Consider starting with prompt chain and evolving.");
    return {
      recommendation: "prompt_chain_then_evaluate",
      confidence: "medium",
      reasoning,
    };
  }

  reasoning.push("Few multi-agent signals. Single agent with good prompt is sufficient.");
  return {
    recommendation: "single_agent",
    confidence: "medium",
    reasoning,
  };
}
```

## Summary

The decision to use multi-agent architecture should be driven by
measurable characteristics of the problem, not by architectural
preference. The 5-dimension rubric provides an objective framework:

1. **Score each dimension** (1-5) honestly
2. **Sum the scores** to get a total
3. **Apply the threshold**: <=12 single, 13-18 consider, >=19 multi
4. **Account for the complexity tax** in development and maintenance
5. **Start simple** and migrate incrementally as complexity demands

The most common mistake is premature multi-agent: paying the complexity
tax before the problem requires it. Start with a single agent, add
validation between steps, and only split into separate agents when a
specific dimension (specialization, isolation, scaling) demands it.
