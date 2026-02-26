---
name: single-vs-multi
description: Score a problem against 5 dimensions to decide single vs multi-agent
---

# /single-vs-multi

## Usage

```
/single-vs-multi
/single-vs-multi <problem-description>
```

Invoke without arguments for a fully interactive experience, or pass a problem description to skip the first prompt.

## Prerequisites

- A clear understanding of the problem you want to solve
- No prior architecture decisions required -- this command helps you make the first one

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Gather Problem Description

If no problem description was provided as an argument, ask:

```
Describe the problem you're considering solving with agents:
- What does the system need to do end-to-end?
- What are the main steps or stages?
- Are there external dependencies (APIs, databases, services)?

Example: "A system that monitors GitHub PRs, runs automated code review
with multiple checks (security, style, tests), and posts a summary comment."
```

### Step 2: Score the 5 Dimensions

For each dimension, explain what it means in the context of the user's problem, then ask for a rating.

**Dimension 1: Task Decomposability**

```
Dimension 1 of 5: Task Decomposability

Can your task be split into independent subtasks that don't need to share
intermediate state?

Think about your problem:
- Are there steps that could run in parallel without waiting for each other?
- Or does every step depend on the previous step's output?

Rate 1-5:
  1 - Fully sequential, tightly coupled (every step depends on the last)
  2 - Mostly sequential with minor independent steps
  3 - Some steps can run independently
  4 - Most steps are independent, few dependencies
  5 - Naturally parallel, fully independent subtasks

Your rating (1-5):
```

**Dimension 2: Skill Specialization**

```
Dimension 2 of 5: Skill Specialization

Does the task require fundamentally different types of expertise?

Think about your problem:
- Could one prompt/system message handle all the work?
- Or do different parts need very different instructions, tools, or models?

Rate 1-5:
  1 - Single domain, one skill set handles everything
  2 - Primarily one domain with minor secondary skills
  3 - Two distinct skill areas
  4 - Three or more distinct skill areas
  5 - Multiple distinct domains requiring specialized tools or models

Your rating (1-5):
```

**Dimension 3: State Complexity**

```
Dimension 3 of 5: State Complexity

How complex is the state that needs to be managed across the workflow?

Think about your problem:
- Can all the context fit comfortably in one agent's context window?
- Or is there too much state for a single agent to track?

Rate 1-5:
  1 - Simple state, fits easily in one context
  2 - Moderate state, manageable in one context
  3 - Significant state, pushing context limits
  4 - Complex state, benefits from partitioning
  5 - Very complex state, must be partitioned across agents

Your rating (1-5):
```

**Dimension 4: Failure Isolation**

```
Dimension 4 of 5: Failure Isolation

How important is it to contain failures so they don't take down the whole system?

Think about your problem:
- If one part fails, is it acceptable for everything to fail?
- Or do you need some parts to keep working while others recover?

Rate 1-5:
  1 - Acceptable blast radius, all-or-nothing is fine
  2 - Minor isolation needs
  3 - Some parts should survive independent failures
  4 - Most parts must be isolated from each other's failures
  5 - Critical isolation required, failures must never cascade

Your rating (1-5):
```

**Dimension 5: Scaling Requirements**

```
Dimension 5 of 5: Scaling Requirements

Does throughput need to vary across different parts of the workflow?

Think about your problem:
- Do all parts handle the same volume at the same speed?
- Or do some parts need to scale independently (e.g., many parallel workers
  for one stage, single instance for another)?

Rate 1-5:
  1 - Fixed, predictable load across all parts
  2 - Mostly uniform with minor variation
  3 - Some parts have different throughput needs
  4 - Significant scaling differences between parts
  5 - Highly variable, elastic scaling needed per component

Your rating (1-5):
```

### Step 3: Calculate and Present Score

Sum the 5 ratings and present the result:

```
Dimension Scores:
  Task Decomposability:  <score>/5
  Skill Specialization:  <score>/5
  State Complexity:      <score>/5
  Failure Isolation:     <score>/5
  Scaling Requirements:  <score>/5
  ─────────────────────────────
  Total:                 <total>/25
```

### Step 4: Provide Recommendation

Based on the total score, provide a recommendation:

**Score 5-12: Single Agent Recommended**

```
Recommendation: SINGLE AGENT

Your score of <total>/25 suggests a single-agent approach is the better fit.

Why multi-agent would hurt more than help:
- <explain based on low-scoring dimensions>
- Multi-agent adds coordination overhead, schema maintenance, and debugging
  complexity that isn't justified by the problem's requirements.

Instead, consider:
- A well-structured single agent with clear prompt sections
- Tool use for external interactions
- Structured output parsing for reliable responses

If you still want to explore multi-agent, the highest-scoring dimension
was <dimension> (<score>/5), which could justify splitting out one
specialized sub-agent.
```

**Score 13-18: Consider Multi-Agent**

```
Recommendation: CONSIDER MULTI-AGENT

Your score of <total>/25 puts you in the zone where multi-agent can help,
but isn't mandatory.

Dimensions that scored highest:
- <dimension> (<score>/5): <why this suggests multi-agent>
- <dimension> (<score>/5): <why this suggests multi-agent>

Dimensions that scored lowest:
- <dimension> (<score>/5): <why this could stay single-agent>

A pragmatic approach: Start with a 2-3 agent system focused on the
highest-scoring dimensions. Keep the rest in a single agent and split
later if needed.
```

**Score 19-25: Multi-Agent Recommended**

```
Recommendation: MULTI-AGENT

Your score of <total>/25 strongly indicates a multi-agent architecture.

Key drivers:
- <dimension> (<score>/5): <impact on architecture>
- <dimension> (<score>/5): <impact on architecture>
```

### Step 5: Outline Next Steps (Multi-Agent Only)

If the score is 13 or above (consider or recommended), provide an initial outline:

```
Initial Architecture Sketch:

Suggested agent decomposition:
  Agent 1: <name> -- <responsibility based on the problem description>
  Agent 2: <name> -- <responsibility>
  Agent 3: <name> -- <responsibility>

Recommended orchestration pattern:
  <pattern> -- <one-line justification>

Key schemas needed:
  - <SchemaName>: <what data it represents>
  - <SchemaName>: <what data it represents>

Next step: Run /design-workflow to build out the full architecture
with typed schemas, action definitions, and failure handling.
```

## Output

- Scored breakdown across 5 dimensions
- Clear recommendation: single-agent, consider multi-agent, or multi-agent
- Justification tied to the specific problem described
- For multi-agent: initial architecture sketch and pointer to /design-workflow

## References

- references/11-single-vs-multi-decision.md
- references/01-foundations.md
