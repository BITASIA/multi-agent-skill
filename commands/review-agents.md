---
name: review-agents
description: Audit existing multi-agent code against the 3 core patterns
---

# /review-agents

## Usage

```
/review-agents
/review-agents <path-to-code>
```

Invoke without arguments to audit the current project, or pass a path to target specific code.

## Prerequisites

- An existing codebase with multi-agent architecture
- Agents should be identifiable as separate files, functions, or classes

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Identify Target Code

If no path was provided as an argument, ask:

```
Which code would you like to audit?

1. Current project (scan the entire working directory)
2. Specific directory (provide a path)
3. Specific files (provide file paths)

Choice:
```

Once the target is identified, scan for files that look like agent definitions (classes, modules, or functions that represent distinct agents).

List the discovered agents and ask for confirmation:

```
I found these agent boundaries in your code:

1. <file-path> -- <agent-name/description>
2. <file-path> -- <agent-name/description>
...

Is this correct? Are there agents I missed or non-agents I included?
```

### Step 2: Check Pattern 1 -- Typed Schemas

For each agent boundary and inter-agent data flow, check:

- **Schema Definitions**: Are Zod schemas (or equivalent typed schemas) defined for data passed between agents?
- **Boundary Validation**: Is validation happening at both send AND receive boundaries?
- **Schema Versioning**: Are schemas versioned to handle evolution?
- **Type Inference**: Are TypeScript types derived from schemas using `z.infer`?

Score: **PASS** (all criteria met) / **PARTIAL** (some criteria met) / **FAIL** (no typed schemas found)

Record specific findings with file paths and line numbers.

### Step 3: Check Pattern 2 -- Action Schemas

For each agent, check:

- **Discriminated Unions**: Are agent actions defined as discriminated unions with a `type` field?
- **Exhaustive Handling**: Is action handling exhaustive (no default catch-all that silently swallows unknown actions)?
- **Action Validation**: Are incoming actions validated against the schema before execution?
- **Type Safety**: Does TypeScript narrow the action type correctly in each handler branch?

Score: **PASS** / **PARTIAL** / **FAIL**

Record specific findings with file paths and line numbers.

### Step 4: Check Pattern 3 -- MCP Contracts

For each tool or external interface, check:

- **Typed Definitions**: Do tool definitions have typed input and output schemas?
- **Pre-Execution Validation**: Is input validated before the tool executes?
- **Contract Tests**: Are there tests that verify the tool contract (input/output shape, error cases)?
- **Error Typing**: Are error responses typed and consistent?

Score: **PASS** / **PARTIAL** / **FAIL**

Record specific findings with file paths and line numbers.

### Step 5: Check Anti-Patterns

Scan the codebase for common multi-agent anti-patterns:

- **God Agent**: One agent that does everything, making others trivial
- **Implicit Contract**: Agents communicate via untyped strings, raw JSON, or `any` types
- **Fire and Forget**: Agent sends a message with no confirmation or error handling
- **Shared Mutable State**: Multiple agents read/write the same mutable state without coordination
- **Retry Storm**: Unbounded retries without backoff or circuit breaking
- **Log Nothing**: No structured logging, correlation IDs, or error tracking

For each anti-pattern found, note the location and severity (CRITICAL / HIGH / MEDIUM / LOW).

### Step 6: Check Observability

Check for observability infrastructure:

- **Correlation IDs**: Are requests traceable across agent boundaries with a shared ID?
- **Structured Logging**: Are logs structured (JSON) rather than free-form strings?
- **Error Tracking**: Are errors captured with context (agent name, action, input)?
- **Metrics**: Are agent execution times, success rates, or queue depths tracked?

### Step 7: Produce Audit Report

Generate a comprehensive audit report:

```
# Multi-Agent Audit Report

## Summary
Overall Grade: <A-F>
Agents Audited: <count>
Patterns Checked: 3

## Pattern Scores

| Pattern            | Score   | Details                          |
|--------------------|---------|----------------------------------|
| Typed Schemas      | <score> | <one-line summary>               |
| Action Schemas     | <score> | <one-line summary>               |
| MCP Contracts      | <score> | <one-line summary>               |

## Anti-Patterns Detected

| Anti-Pattern           | Severity | Location          | Recommendation       |
|------------------------|----------|-------------------|----------------------|
| <name>                 | <level>  | <file:line>       | <fix suggestion>     |

## Observability

| Check            | Status  | Notes                            |
|------------------|---------|----------------------------------|
| Correlation IDs  | <Y/N>   | <details>                        |
| Structured Logs  | <Y/N>   | <details>                        |
| Error Tracking   | <Y/N>   | <details>                        |
| Metrics          | <Y/N>   | <details>                        |

## Grading Criteria
- A: All 3 patterns PASS, no CRITICAL anti-patterns, observability in place
- B: All 3 patterns PASS or PARTIAL, no CRITICAL anti-patterns
- C: At least 2 patterns PASS or PARTIAL, some anti-patterns
- D: 1 pattern PASS, multiple anti-patterns
- F: No patterns implemented, multiple CRITICAL anti-patterns

## Recommended Actions (Priority Order)
1. <highest priority fix>
2. <next priority fix>
...
```

## Output

- Detailed audit report with overall grade (A-F)
- Pattern-by-pattern scoring with specific findings
- Anti-pattern detection with locations and severity
- Prioritized list of recommended fixes

## References

- references/02-typed-schemas.md
- references/03-action-schemas.md
- references/04-mcp-contracts.md
- references/12-anti-patterns.md
