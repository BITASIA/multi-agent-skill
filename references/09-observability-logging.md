# Observability: Logging, Tracing, and Metrics

## Why Observability Matters for Multi-Agent Systems

Multi-agent systems are opaque by default. An agent receives input, does
something internally (often involving an LLM), and produces output. Without
structured observability, debugging a multi-agent workflow is like debugging
a distributed system with no logs — you can see the final output but not
how it was produced.

Three pillars of observability:
1. **Logs** — what happened (structured events)
2. **Traces** — how it flowed (request paths across agents)
3. **Metrics** — how it performed (latency, errors, throughput)

## Correlation IDs Across Agent Boundaries

Every workflow gets a correlation ID that propagates through every agent
call, log entry, and metric. This is the single most important
observability practice.

```typescript
import { z } from "zod";

// Correlation context that travels with every request
const CorrelationContextSchema = z.object({
  // Unique to the entire workflow
  correlationId: z.string().uuid(),
  // Unique to the current agent's execution
  spanId: z.string().uuid(),
  // The spanId of the agent that called this one
  parentSpanId: z.string().uuid().optional(),
  // Chain of agent names for quick debugging
  callChain: z.array(z.string()),
  // When the workflow started
  workflowStartedAt: z.string().datetime(),
});

type CorrelationContext = z.infer<typeof CorrelationContextSchema>;

// Create initial context for a new workflow
function createRootContext(workflowName: string): CorrelationContext {
  return {
    correlationId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    callChain: [workflowName],
    workflowStartedAt: new Date().toISOString(),
  };
}

// Create child context when calling another agent
function createChildContext(
  parent: CorrelationContext,
  agentName: string,
): CorrelationContext {
  return {
    correlationId: parent.correlationId,
    spanId: crypto.randomUUID(),
    parentSpanId: parent.spanId,
    callChain: [...parent.callChain, agentName],
    workflowStartedAt: parent.workflowStartedAt,
  };
}

// Example: propagating context through a pipeline
async function runAgentWithContext<TInput, TOutput>(
  agentName: string,
  context: CorrelationContext,
  input: TInput,
  agentFn: (input: TInput, ctx: CorrelationContext) => Promise<TOutput>,
): Promise<{ output: TOutput; context: CorrelationContext }> {
  const childContext = createChildContext(context, agentName);

  const output = await agentFn(input, childContext);

  return { output, context: childContext };
}
```

## Structured Logging

Structured logs are machine-parseable JSON. Every log entry includes the
correlation context, the agent name, the log level, and structured data.

```typescript
import { z } from "zod";

const LogLevelSchema = z.enum(["debug", "info", "warn", "error", "fatal"]);
type LogLevel = z.infer<typeof LogLevelSchema>;

const LogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  level: LogLevelSchema,
  message: z.string(),
  agent: z.string(),
  correlationId: z.string().uuid(),
  spanId: z.string().uuid(),
  parentSpanId: z.string().uuid().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }).optional(),
  duration: z.object({
    ms: z.number().nonnegative(),
    label: z.string(),
  }).optional(),
});

type LogEntry = z.infer<typeof LogEntrySchema>;

class StructuredLogger {
  private agentName: string;
  private context: CorrelationContext;
  private logBuffer: LogEntry[] = [];
  private sink: (entry: LogEntry) => void;

  constructor(
    agentName: string,
    context: CorrelationContext,
    sink: (entry: LogEntry) => void = (entry) =>
      console.info(JSON.stringify(entry)),
  ) {
    this.agentName = agentName;
    this.context = context;
    this.sink = sink;
  }

  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    error?: Error,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      agent: this.agentName,
      correlationId: this.context.correlationId,
      spanId: this.context.spanId,
      parentSpanId: this.context.parentSpanId,
      data,
      error: error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : undefined,
    };

    this.logBuffer = [...this.logBuffer, entry];
    this.sink(entry);
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, error: Error, data?: Record<string, unknown>): void {
    this.log("error", message, data, error);
  }

  // Time an operation and log the duration
  async timed<T>(
    label: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startTime = Date.now();
    this.log("debug", `Starting: ${label}`);

    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;
      this.log("info", `Completed: ${label}`, {
        durationMs,
        label,
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      this.log(
        "error",
        `Failed: ${label}`,
        { durationMs, label },
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  getBuffer(): ReadonlyArray<LogEntry> {
    return this.logBuffer;
  }
}
```

### Logging Best Practices

```typescript
// DO: Log agent boundary crossings
logger.info("Sending task to analysis agent", {
  taskId: task.id,
  inputTokenEstimate: estimateTokens(task),
});

// DO: Log decisions
logger.info("Router selected agent", {
  selectedAgent: "security-reviewer",
  confidence: 0.92,
  alternativeAgents: ["quality-reviewer", "perf-reviewer"],
});

// DO: Log state transitions
logger.info("Task status changed", {
  taskId: "abc-123",
  previousStatus: "running",
  newStatus: "completed",
  stateVersion: 5,
});

// DO: Log validation results
logger.warn("Input validation failed", {
  validationErrors: [
    { path: "score", message: "Expected number, received string" },
  ],
  rawInput: sanitize(rawInput), // Remove sensitive data
});

// DON'T: Log raw LLM prompts or responses (token cost, sensitive data)
// DON'T: Log PII without sanitization
// DON'T: Use unstructured string concatenation
```

## Distributed Tracing with Spans

Traces show the full path of a request through the multi-agent system.
Each agent's execution is a "span" within the trace.

```typescript
import { z } from "zod";

const SpanStatusSchema = z.enum(["ok", "error", "timeout"]);

const SpanSchema = z.object({
  traceId: z.string().uuid(),
  spanId: z.string().uuid(),
  parentSpanId: z.string().uuid().optional(),
  operationName: z.string(),
  agentName: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  status: SpanStatusSchema.optional(),
  attributes: z.record(z.string(), z.union([
    z.string(),
    z.number(),
    z.boolean(),
  ])).default({}),
  events: z.array(z.object({
    name: z.string(),
    timestamp: z.string().datetime(),
    attributes: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
});

type Span = z.infer<typeof SpanSchema>;

class TraceCollector {
  private spans: Span[] = [];

  startSpan(config: {
    traceId: string;
    parentSpanId?: string;
    operationName: string;
    agentName: string;
    attributes?: Record<string, string | number | boolean>;
  }): SpanHandle {
    const span: Span = {
      traceId: config.traceId,
      spanId: crypto.randomUUID(),
      parentSpanId: config.parentSpanId,
      operationName: config.operationName,
      agentName: config.agentName,
      startTime: new Date().toISOString(),
      attributes: config.attributes ?? {},
      events: [],
    };

    return {
      spanId: span.spanId,

      addEvent: (name: string, attributes?: Record<string, unknown>) => {
        span.events = [...span.events, {
          name,
          timestamp: new Date().toISOString(),
          attributes: attributes ?? {},
        }];
      },

      setAttribute: (key: string, value: string | number | boolean) => {
        span.attributes = { ...span.attributes, [key]: value };
      },

      end: (status: "ok" | "error" | "timeout" = "ok") => {
        const completedSpan: Span = {
          ...span,
          endTime: new Date().toISOString(),
          status,
        };
        this.spans = [...this.spans, SpanSchema.parse(completedSpan)];
      },
    };
  }

  getTrace(traceId: string): ReadonlyArray<Span> {
    return this.spans.filter((s) => s.traceId === traceId);
  }

  getAllSpans(): ReadonlyArray<Span> {
    return this.spans;
  }

  // Build a tree view of the trace
  getTraceTree(traceId: string): SpanTreeNode | undefined {
    const traceSpans = this.getTrace(traceId);
    const root = traceSpans.find((s) => !s.parentSpanId);
    if (!root) return undefined;

    function buildTree(parent: Span): SpanTreeNode {
      const children = traceSpans
        .filter((s) => s.parentSpanId === parent.spanId)
        .map(buildTree);
      return { span: parent, children };
    }

    return buildTree(root);
  }
}

interface SpanHandle {
  spanId: string;
  addEvent: (name: string, attributes?: Record<string, unknown>) => void;
  setAttribute: (key: string, value: string | number | boolean) => void;
  end: (status?: "ok" | "error" | "timeout") => void;
}

interface SpanTreeNode {
  span: Span;
  children: SpanTreeNode[];
}

// Usage: tracing a multi-agent workflow
async function tracedAgentCall<T>(
  collector: TraceCollector,
  traceId: string,
  parentSpanId: string | undefined,
  agentName: string,
  operation: string,
  fn: () => Promise<T>,
): Promise<{ result: T; spanId: string }> {
  const span = collector.startSpan({
    traceId,
    parentSpanId,
    operationName: operation,
    agentName,
  });

  try {
    span.addEvent("execution_started");
    const result = await fn();
    span.addEvent("execution_completed");
    span.end("ok");
    return { result, spanId: span.spanId };
  } catch (error) {
    span.addEvent("execution_failed", {
      error: error instanceof Error ? error.message : "Unknown",
    });
    span.end("error");
    throw error;
  }
}
```

## Metrics

Track quantitative data about agent performance.

```typescript
import { z } from "zod";

const MetricTypeSchema = z.enum(["counter", "gauge", "histogram"]);

interface MetricPoint {
  name: string;
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels: Record<string, string>;
  timestamp: string;
}

class MetricsCollector {
  private points: MetricPoint[] = [];

  // Counter: monotonically increasing (total calls, total errors)
  increment(
    name: string,
    labels: Record<string, string> = {},
    amount: number = 1,
  ): void {
    this.points = [...this.points, {
      name,
      type: "counter",
      value: amount,
      labels,
      timestamp: new Date().toISOString(),
    }];
  }

  // Gauge: point-in-time value (active agents, queue depth)
  gauge(
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.points = [...this.points, {
      name,
      type: "gauge",
      value,
      labels,
      timestamp: new Date().toISOString(),
    }];
  }

  // Histogram: distribution of values (latency, token usage)
  observe(
    name: string,
    value: number,
    labels: Record<string, string> = {},
  ): void {
    this.points = [...this.points, {
      name,
      type: "histogram",
      value,
      labels,
      timestamp: new Date().toISOString(),
    }];
  }

  // Get summary statistics for a metric
  summarize(
    name: string,
    labels?: Record<string, string>,
  ): {
    count: number;
    sum: number;
    min: number;
    max: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
  } | undefined {
    let matching = this.points.filter((p) => p.name === name);

    if (labels) {
      matching = matching.filter((p) =>
        Object.entries(labels).every(([k, v]) => p.labels[k] === v)
      );
    }

    if (matching.length === 0) return undefined;

    const values = matching.map((p) => p.value).sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      count: values.length,
      sum,
      min: values[0],
      max: values[values.length - 1],
      avg: sum / values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      p99: percentile(values, 99),
    };
  }

  getAllPoints(): ReadonlyArray<MetricPoint> {
    return this.points;
  }
}

function percentile(sorted: number[], p: number): number {
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// Standard metrics for multi-agent systems
function instrumentAgent(
  metrics: MetricsCollector,
  agentName: string,
) {
  return {
    recordCall(durationMs: number, success: boolean, tokensUsed: number): void {
      const labels = { agent: agentName };

      metrics.increment("agent_calls_total", {
        ...labels,
        status: success ? "success" : "error",
      });

      metrics.observe("agent_latency_ms", durationMs, labels);
      metrics.observe("agent_tokens_used", tokensUsed, labels);
    },

    recordQueueDepth(depth: number): void {
      metrics.gauge("agent_queue_depth", depth, { agent: agentName });
    },

    recordCircuitBreakerState(state: string): void {
      metrics.gauge(
        "circuit_breaker_state",
        state === "closed" ? 0 : state === "half-open" ? 1 : 2,
        { agent: agentName },
      );
    },
  };
}
```

## Log Aggregation Patterns

```typescript
// Collect logs from all agents into a central store
class LogAggregator {
  private logs: LogEntry[] = [];

  ingest(entry: LogEntry): void {
    this.logs = [...this.logs, LogEntrySchema.parse(entry)];
  }

  // Query logs by correlation ID (see entire workflow)
  byCorrelation(correlationId: string): ReadonlyArray<LogEntry> {
    return this.logs
      .filter((l) => l.correlationId === correlationId)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // Query logs by agent (see all activity for one agent)
  byAgent(agentName: string): ReadonlyArray<LogEntry> {
    return this.logs.filter((l) => l.agent === agentName);
  }

  // Query error logs
  errors(since?: string): ReadonlyArray<LogEntry> {
    let filtered = this.logs.filter(
      (l) => l.level === "error" || l.level === "fatal",
    );
    if (since) {
      filtered = filtered.filter((l) => l.timestamp >= since);
    }
    return filtered;
  }

  // Error rate per agent in a time window
  errorRates(windowMs: number): Record<string, {
    total: number;
    errors: number;
    rate: number;
  }> {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const recent = this.logs.filter((l) => l.timestamp >= cutoff);

    const rates: Record<string, { total: number; errors: number; rate: number }> = {};

    for (const log of recent) {
      if (!rates[log.agent]) {
        rates[log.agent] = { total: 0, errors: 0, rate: 0 };
      }
      rates[log.agent].total++;
      if (log.level === "error" || log.level === "fatal") {
        rates[log.agent].errors++;
      }
    }

    for (const agent of Object.keys(rates)) {
      rates[agent].rate = rates[agent].errors / rates[agent].total;
    }

    return rates;
  }
}
```

## Debugging Multi-Agent Workflows

### Debug Session: Reconstructing a Workflow

```typescript
// Given a correlation ID, reconstruct what happened
function debugWorkflow(
  correlationId: string,
  logAggregator: LogAggregator,
  traceCollector: TraceCollector,
  metricsCollector: MetricsCollector,
): {
  timeline: ReadonlyArray<LogEntry>;
  trace: ReadonlyArray<Span>;
  agentMetrics: Record<string, ReturnType<MetricsCollector["summarize"]>>;
  errorChain: ReadonlyArray<LogEntry>;
} {
  // 1. Get all logs for this workflow, in order
  const timeline = logAggregator.byCorrelation(correlationId);

  // 2. Get the distributed trace
  const trace = traceCollector.getTrace(correlationId);

  // 3. Get metrics per agent involved
  const agents = [...new Set(timeline.map((l) => l.agent))];
  const agentMetrics: Record<string, ReturnType<MetricsCollector["summarize"]>> = {};
  for (const agent of agents) {
    agentMetrics[agent] = metricsCollector.summarize(
      "agent_latency_ms",
      { agent },
    );
  }

  // 4. Extract the error chain
  const errorChain = timeline.filter(
    (l) => l.level === "error" || l.level === "fatal",
  );

  return { timeline, trace, agentMetrics, errorChain };
}
```

### Workflow Visualization (Text Format)

```typescript
// Generate a text-based visualization of the workflow
function visualizeTrace(tree: SpanTreeNode, indent: number = 0): string {
  const prefix = "  ".repeat(indent);
  const duration = tree.span.endTime
    ? `${new Date(tree.span.endTime).getTime() - new Date(tree.span.startTime).getTime()}ms`
    : "in-progress";
  const status = tree.span.status ?? "unknown";
  const statusIcon = status === "ok" ? "[OK]" : status === "error" ? "[ERR]" : "[???]";

  let output =
    `${prefix}${statusIcon} ${tree.span.agentName}::${tree.span.operationName} (${duration})\n`;

  for (const event of tree.span.events) {
    output += `${prefix}  > ${event.name} @ ${event.timestamp}\n`;
  }

  for (const child of tree.children) {
    output += visualizeTrace(child, indent + 1);
  }

  return output;
}

// Output example:
// [OK] orchestrator::process_request (1250ms)
//   > execution_started @ 2024-01-15T10:00:00.000Z
//   [OK] router::classify_input (150ms)
//     > execution_started @ 2024-01-15T10:00:00.050Z
//     > execution_completed @ 2024-01-15T10:00:00.200Z
//   [OK] security-reviewer::analyze_code (800ms)
//     > execution_started @ 2024-01-15T10:00:00.210Z
//     > execution_completed @ 2024-01-15T10:00:01.010Z
//   [ERR] summarizer::generate_summary (250ms)
//     > execution_started @ 2024-01-15T10:00:01.020Z
//     > execution_failed @ 2024-01-15T10:00:01.270Z
```

## Summary

Observability for multi-agent systems requires three layers:

1. **Correlation IDs** — thread a unique ID through every agent call, every
   log entry, every metric. This is non-negotiable.

2. **Structured logging** — JSON-formatted logs with agent name, correlation
   ID, span ID, and structured data. Enable querying and aggregation.

3. **Distributed tracing** — spans for each agent's execution, linked by
   parent-child relationships. Enable visualization of the full workflow.

4. **Metrics** — counters, gauges, and histograms for latency, error rates,
   token usage, and queue depths. Enable alerting and capacity planning.

Without observability, a multi-agent system is a black box. With it, every
failure is traceable, every bottleneck is measurable, and every workflow
is debuggable.
