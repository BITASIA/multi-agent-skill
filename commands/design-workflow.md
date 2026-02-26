---
name: design-workflow
description: Interactive wizard for designing a multi-agent workflow from scratch
---

# /design-workflow

## Usage

```
/design-workflow
/design-workflow <problem-description>
```

Invoke without arguments for a fully interactive experience, or pass a problem description to skip the first prompt.

## Prerequisites

- Familiarity with the problem domain you want to solve
- A TypeScript project (or willingness to create one)
- Zod installed or ready to install (`npm install zod`)

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Gather Problem Description

If no problem description was provided as an argument, ask:

```
What problem are you trying to solve with agents?
Describe the end-to-end workflow, including:
- What triggers it
- What steps are involved
- What the final output should be

Example: "A code review system that takes a PR, runs security analysis,
checks style compliance, validates tests, and produces a unified review."
```

### Step 2: Run Single-vs-Multi Scoring

Present the 5-dimension scoring framework and ask the user to rate each dimension 1-5:

```
Before designing a multi-agent system, let's verify it's the right approach.
Rate each dimension from 1 (low) to 5 (high):

1. Task Decomposability: Can the task be split into independent subtasks?
   (1 = fully sequential/coupled, 5 = naturally parallel/independent)

2. Skill Specialization: Does the task require different expertise areas?
   (1 = single domain, 5 = multiple distinct domains)

3. State Complexity: How complex is the shared state?
   (1 = simple/fits in one context, 5 = complex/needs partitioning)

4. Failure Isolation: How important is containing failures?
   (1 = acceptable blast radius, 5 = must isolate failure domains)

5. Scaling Requirements: Does throughput need to vary by component?
   (1 = fixed/predictable, 5 = variable/elastic)
```

Calculate the total score (5-25):

- **5-12**: Recommend single-agent. Explain that multi-agent would add unnecessary complexity. Offer to help design a well-structured single-agent solution instead. Stop here unless the user insists on proceeding.
- **13-18**: Multi-agent is a reasonable choice. Note which dimensions scored high and proceed.
- **19-25**: Multi-agent is strongly recommended. Proceed with confidence.

### Step 3: Identify Agent Responsibilities

Based on the problem description, suggest a decomposition into agents:

```
Based on your description, here's a suggested agent decomposition:

Agent 1: <name> - <responsibility>
Agent 2: <name> - <responsibility>
Agent 3: <name> - <responsibility>
...

Does this decomposition look right? Would you like to:
  a) Accept as-is
  b) Modify (add, remove, or rename agents)
  c) Start over with a different decomposition
```

Wait for the user to confirm or modify before proceeding.

### Step 4: Select Orchestration Pattern

Present orchestration pattern options with pros and cons:

```
Which orchestration pattern fits your workflow?

1. Pipeline (Sequential)
   - Agents execute in a fixed order, each passing output to the next
   - Best for: Linear workflows with clear stages
   - Pros: Simple, predictable, easy to debug
   - Cons: No parallelism, slowest overall

2. Fan-Out / Fan-In (Parallel)
   - One agent distributes work, multiple agents process in parallel, results are merged
   - Best for: Independent subtasks that can run concurrently
   - Pros: Fast, scalable
   - Cons: Merge logic can be complex, harder to debug

3. Router (Conditional)
   - A routing agent decides which specialist agent to invoke based on input
   - Best for: Varied input types requiring different handling
   - Pros: Flexible, extensible
   - Cons: Router can become a bottleneck, needs good classification

4. Supervisor (Hierarchical)
   - A supervisor agent delegates tasks, monitors progress, handles failures
   - Best for: Complex workflows needing coordination and error recovery
   - Pros: Centralized control, good failure handling
   - Cons: Supervisor is a single point of failure

5. Hybrid (Combination)
   - Combine multiple patterns (e.g., supervisor with fan-out workers)
   - Best for: Complex real-world workflows
   - Pros: Flexible
   - Cons: Most complex to implement

Which pattern? (1-5)
```

### Step 5: Generate Typed Schemas

Based on the identified agents and their data flow, generate Zod schemas for all inter-agent data:

- Identify every piece of data that crosses an agent boundary
- Create a Zod schema for each data type
- Include versioning metadata
- Use `z.infer<typeof Schema>` for TypeScript type exports

Present the schemas and ask:

```
Here are the typed schemas for data flowing between your agents.
Review each schema -- are there fields to add, remove, or change?
```

Wait for user feedback and iterate.

### Step 6: Generate Action Schemas

For each agent, generate a discriminated union of all actions it can perform:

- Use a `type` field as the discriminant
- Define payload schemas for each action variant
- Ensure exhaustive handling (no default catch-all)

Present the action schemas and ask for confirmation.

### Step 7: Define Failure Handling Strategy

For the selected orchestration pattern and agents, propose a failure handling strategy:

```
Here's the recommended failure handling for your workflow:

Agent failures:
  <agent-name>: <strategy (retry with backoff / fallback / circuit breaker / skip)>
  <agent-name>: <strategy>

Timeout policy:
  Per-agent timeout: <duration>
  Overall workflow timeout: <duration>

Error escalation:
  <describe escalation path>

Does this strategy work? Would you like to adjust any thresholds or strategies?
```

### Step 8: Produce Architecture Document

Generate a complete architecture document containing:

1. **Agent Responsibility Map** -- Table of agents with name, responsibility, inputs, outputs
2. **Orchestration Pattern Diagram** -- Text-based flow diagram showing agent connections
3. **Zod Schema Definitions** -- All typed schemas from Step 5
4. **Action Schema Definitions** -- All action schemas from Step 6
5. **Failure Handling Strategy** -- Complete strategy from Step 7
6. **Suggested File Structure** -- Recommended directory layout, e.g.:

```
src/
  agents/
    <agent-name>/
      index.ts          # Agent entry point
      actions.ts         # Action schema definitions
      schemas.ts         # Input/output Zod schemas
    ...
  orchestrator/
    index.ts             # Orchestration logic
    types.ts             # Shared types
  schemas/
    shared.ts            # Shared schemas across agents
    versions.ts          # Schema version registry
```

### Step 9: Scaffold Code (Optional)

Ask the user:

```
Would you like me to scaffold the code files based on this architecture?
This will create:
  - Agent entry points with action handlers
  - Zod schema files with validation
  - Orchestrator skeleton
  - Basic test stubs

Scaffold now? (y/n)
```

If yes, generate all files following the architecture document.

## Output

- Complete architecture document with agent map, schemas, and failure strategy
- Optionally: scaffolded TypeScript source files ready for implementation

## References

- references/01-foundations.md
- references/05-orchestration-patterns.md
- references/11-single-vs-multi-decision.md
- templates/schemas/*
- templates/orchestration/*
