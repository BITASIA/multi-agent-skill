---
name: failure-analysis
description: Analyze a multi-agent workflow for failure modes and risk
---

# /failure-analysis

## Usage

```
/failure-analysis
/failure-analysis <path-to-workflow>
```

Invoke without arguments for a fully interactive experience, or pass a path to the workflow code to analyze.

## Prerequisites

- An existing multi-agent workflow (code or design document)
- Understanding of the agents, their connections, and data flow

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Identify the Workflow

If no path was provided as an argument, ask:

```
How would you like to provide the workflow for analysis?

1. Point to code (provide a directory or file path)
2. Describe the workflow (agents, connections, data flow)
3. Use the current project (I'll scan for agent definitions)

Choice:
```

If the user chooses to describe the workflow, ask:

```
Describe your multi-agent workflow:
- What agents exist and what does each do?
- How are they connected (what calls what)?
- What data flows between them?
- What external dependencies exist (APIs, databases, file systems)?
```

### Step 2: Map the Workflow Graph

Build a text-based representation of the agent workflow graph:

```
Workflow Graph:

  [Trigger] --> [Agent A: Intake]
                    |
                    v
              [Agent B: Processor] ---> [External API]
                    |
              +-----+-----+
              |           |
              v           v
    [Agent C: Writer]  [Agent D: Validator]
              |           |
              +-----+-----+
                    |
                    v
              [Agent E: Publisher]

Connections:
  Trigger -> A: HTTP request (unvalidated)
  A -> B: ProcessingRequest schema
  B -> External API: REST call
  B -> C: ContentDraft schema
  B -> D: ValidationRequest schema
  C -> E: FinalContent schema
  D -> E: ValidationResult schema

Does this graph accurately represent your workflow?
```

Wait for user confirmation or corrections.

### Step 3: Identify Failure Modes

For each agent and connection in the graph, systematically identify failure modes:

```
Failure Mode Analysis:

Agent A (Intake):
  F1. Agent crash/timeout: Process dies during intake processing
  F2. Invalid input: Trigger sends malformed data
  F3. Resource exhaustion: Too many concurrent requests

Connection A -> B:
  F4. Schema mismatch: Agent A sends data that doesn't match ProcessingRequest
  F5. Message lost: Network failure between agents

Agent B (Processor):
  F6. External API timeout: API call exceeds timeout threshold
  F7. External API error: API returns 4xx/5xx
  F8. Rate limiting: API throttles requests
  F9. Invalid response: API returns unexpected data shape

...
```

Present the full failure mode list and ask:

```
I identified <N> failure modes. Are there additional failure scenarios
specific to your domain that I should include?
```

### Step 4: Analyze Cascade Paths

For each critical agent, trace what happens when it fails:

```
Cascade Analysis:

If Agent B (Processor) fails:
  -> Agent C (Writer) never receives input: BLOCKED
  -> Agent D (Validator) never receives input: BLOCKED
  -> Agent E (Publisher) never receives either input: BLOCKED
  -> Overall workflow: COMPLETE FAILURE
  -> Blast radius: 100% of downstream agents affected

If Agent D (Validator) fails:
  -> Agent C (Writer) is unaffected: CONTINUES
  -> Agent E (Publisher) missing validation: PARTIAL DATA
  -> Overall workflow: DEGRADED (can proceed without validation)
  -> Blast radius: 50% of downstream agents affected
```

### Step 5: Check Race Conditions and Ordering

Analyze the workflow for timing-dependent failures:

- Do any agents assume a specific execution order?
- Can parallel agents produce conflicting results?
- Are there shared resources accessed by multiple agents?
- Are there time-of-check to time-of-use (TOCTOU) vulnerabilities?

```
Race Condition Analysis:

Issue R1: Agents C and D both write to the same output store.
  Risk: Last-write-wins can corrupt data.
  Location: Agent C (writer.ts:45), Agent D (validator.ts:32)

Issue R2: Agent E reads from both C and D but assumes C finishes first.
  Risk: E may read stale or missing data from C.
  Location: Agent E (publisher.ts:18)

No race conditions found? Report: "No race conditions identified."
```

### Step 6: Build Risk Matrix

Score each failure mode on likelihood (1-5) and impact (1-5):

```
Risk Matrix:

| ID  | Failure Mode              | Likelihood | Impact | Risk Score | Priority |
|-----|---------------------------|------------|--------|------------|----------|
| F6  | External API timeout      | 4          | 4      | 16         | CRITICAL |
| F7  | External API error        | 3          | 4      | 12         | HIGH     |
| F1  | Agent A crash             | 2          | 5      | 10         | HIGH     |
| F4  | Schema mismatch           | 2          | 4      | 8          | MEDIUM   |
| F8  | Rate limiting             | 3          | 2      | 6          | MEDIUM   |
| F2  | Invalid input             | 2          | 2      | 4          | LOW      |
| ...                                                                           |

Risk score = Likelihood x Impact
CRITICAL: >= 15 | HIGH: >= 10 | MEDIUM: >= 5 | LOW: < 5
```

### Step 7: Rate Overall Resilience

Provide an overall resilience score:

```
Overall Workflow Resilience: <score>/10

Scoring breakdown:
  Schema validation at boundaries: <0-2 points>
  Failure handling (retries, timeouts): <0-2 points>
  Cascade isolation: <0-2 points>
  Observability (logging, tracing): <0-2 points>
  Graceful degradation capability: <0-2 points>
```

### Step 8: Recommend Mitigations

For each failure mode, ordered by risk score, recommend a specific mitigation:

```
Recommended Mitigations (ordered by risk):

1. F6 - External API timeout (Risk: 16 CRITICAL)
   Pattern: Circuit breaker with fallback
   Where: Agent B, around the external API call
   Code:
   ```typescript
   const circuitBreaker = createCircuitBreaker({
     failureThreshold: 3,
     resetTimeout: 30_000,
     fallback: () => cachedResponse,
   });

   const result = await circuitBreaker.execute(() =>
     externalApi.call(input)
   );
   ```

2. F7 - External API error (Risk: 12 HIGH)
   Pattern: Retry with exponential backoff
   Where: Agent B, wrapping the API call
   Code:
   ```typescript
   const result = await retryWithBackoff(
     () => externalApi.call(input),
     { maxRetries: 3, baseDelay: 1000, maxDelay: 10_000 }
   );
   ```

3. F1 - Agent A crash (Risk: 10 HIGH)
   Pattern: Supervisor with restart
   Where: Orchestrator, monitoring Agent A health
   Code:
   ```typescript
   const supervisor = createSupervisor({
     agent: agentA,
     healthCheck: { interval: 5_000, timeout: 2_000 },
     onFailure: 'restart',
     maxRestarts: 3,
   });
   ```

...
```

### Step 9: Produce Failure Analysis Report

Compile everything into a complete report:

```
# Failure Analysis Report

## Workflow Summary
<brief description of the analyzed workflow>

## Workflow Graph
<text-based diagram from Step 2>

## Failure Modes (<N> identified)
<table from Step 3>

## Cascade Analysis
<cascade paths from Step 4>

## Race Conditions
<findings from Step 5>

## Risk Matrix
<scored table from Step 6>

## Overall Resilience: <score>/10
<breakdown from Step 7>

## Recommended Mitigations
<prioritized list from Step 8>

## Next Steps
- Address CRITICAL mitigations immediately
- Implement HIGH mitigations before production
- Schedule MEDIUM mitigations for next sprint
- Track LOW mitigations in backlog
```

## Output

- Complete failure analysis report with workflow graph
- Risk matrix with scored failure modes
- Overall resilience rating (1-10)
- Prioritized mitigation recommendations with code snippets

## References

- references/07-failure-modes-catalog.md
- references/08-retry-escalation.md
- templates/orchestration/retry-with-escalation.ts
