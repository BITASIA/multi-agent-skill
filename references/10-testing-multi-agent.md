# Testing Strategies for Multi-Agent Systems

## The Test Pyramid for Multi-Agent Systems

```
         /  E2E  \           Few, expensive, slow
        /----------\
       / Integration \       Moderate count, test agent combinations
      /----------------\
     /  Contract Tests  \    Many, verify schema conformance
    /--------------------\
   /     Unit Tests       \  Most, test individual functions
  /________________________\
```

- **Unit tests**: Individual functions, validators, state transitions
- **Contract tests**: Schema conformance between agents
- **Integration tests**: Multiple agents working together
- **E2E tests**: Full workflow from input to output

## Contract Testing Between Agents

Contract tests verify that an agent's output conforms to the schema that
downstream agents expect. They are the most important tests in a
multi-agent system.

```typescript
import { z } from "zod";

// Contract definition: what Agent A promises to produce
// and what Agent B expects to receive
interface AgentContract<TOutput> {
  producerAgent: string;
  consumerAgent: string;
  schema: z.ZodType<TOutput>;
  description: string;
}

// Contract test runner
async function testContract<TOutput>(
  contract: AgentContract<TOutput>,
  samples: unknown[],
): Promise<{
  passed: boolean;
  results: Array<{
    sampleIndex: number;
    passed: boolean;
    errors?: string[];
  }>;
}> {
  const results = samples.map((sample, index) => {
    const parseResult = contract.schema.safeParse(sample);
    if (parseResult.success) {
      return { sampleIndex: index, passed: true };
    }
    return {
      sampleIndex: index,
      passed: false,
      errors: parseResult.error.issues.map(
        (i) => `${i.path.join(".")}: ${i.message}`,
      ),
    };
  });

  return {
    passed: results.every((r) => r.passed),
    results,
  };
}

// Example: contract between ResearchAgent and AnalysisAgent
const ResearchOutputSchema = z.object({
  sources: z.array(z.object({
    title: z.string().min(1),
    content: z.string().min(1),
    url: z.string().url(),
    relevance: z.number().min(0).max(1),
  })),
  query: z.string().min(1),
  searchTimeMs: z.number().nonnegative(),
});

const researchToAnalysisContract: AgentContract<z.infer<typeof ResearchOutputSchema>> = {
  producerAgent: "research-agent",
  consumerAgent: "analysis-agent",
  schema: ResearchOutputSchema,
  description: "Research agent produces source data for analysis",
};

// Test with real agent outputs
async function testResearchContract() {
  // Collect sample outputs from the research agent
  const sampleOutputs = [
    {
      sources: [
        {
          title: "Multi-Agent Patterns",
          content: "Content about patterns...",
          url: "https://example.com/article",
          relevance: 0.95,
        },
      ],
      query: "multi-agent best practices",
      searchTimeMs: 450,
    },
    {
      sources: [],
      query: "obscure topic with no results",
      searchTimeMs: 200,
    },
  ];

  const result = await testContract(researchToAnalysisContract, sampleOutputs);
  return result;
  // { passed: true, results: [{ sampleIndex: 0, passed: true }, ...] }
}
```

### Bidirectional Contract Testing

Test both directions: producer output matches schema, AND consumer
can process schema-conformant data.

```typescript
interface BidirectionalContract<TData> {
  schema: z.ZodType<TData>;
  producerAgent: string;
  consumerAgent: string;
  // Producer generates sample outputs
  produceSamples: () => Promise<unknown[]>;
  // Consumer processes validated data
  consumeSample: (data: TData) => Promise<{ success: boolean; error?: string }>;
}

async function testBidirectional<TData>(
  contract: BidirectionalContract<TData>,
): Promise<{
  producerConformance: { passed: boolean; failures: number };
  consumerCompatibility: { passed: boolean; failures: number };
}> {
  // Test 1: Producer output matches schema
  const samples = await contract.produceSamples();
  let producerFailures = 0;

  const validSamples: TData[] = [];
  for (const sample of samples) {
    const result = contract.schema.safeParse(sample);
    if (result.success) {
      validSamples.push(result.data);
    } else {
      producerFailures++;
    }
  }

  // Test 2: Consumer can process valid data
  let consumerFailures = 0;
  for (const validSample of validSamples) {
    const consumeResult = await contract.consumeSample(validSample);
    if (!consumeResult.success) {
      consumerFailures++;
    }
  }

  return {
    producerConformance: {
      passed: producerFailures === 0,
      failures: producerFailures,
    },
    consumerCompatibility: {
      passed: consumerFailures === 0,
      failures: consumerFailures,
    },
  };
}
```

## Boundary Testing

Test the validation logic at each agent's input and output boundaries.

```typescript
import { z } from "zod";

// Generate edge case inputs for boundary testing
function generateBoundaryInputs(schema: z.ZodObject<z.ZodRawShape>): unknown[] {
  const inputs: unknown[] = [];
  const shape = schema.shape;

  // Test 1: Empty object
  inputs.push({});

  // Test 2: Null values for each field
  for (const key of Object.keys(shape)) {
    inputs.push({ [key]: null });
  }

  // Test 3: Wrong types for each field
  for (const key of Object.keys(shape)) {
    inputs.push({ [key]: 12345 });    // number where string expected
    inputs.push({ [key]: "string" }); // string where number expected
    inputs.push({ [key]: true });     // boolean
    inputs.push({ [key]: [] });       // array
    inputs.push({ [key]: {} });       // object
  }

  // Test 4: Extra fields (should be stripped or ignored)
  inputs.push({ ...validSample(shape), _extra: "unexpected" });

  // Test 5: Missing each required field
  const allKeys = Object.keys(shape);
  for (const omitKey of allKeys) {
    const partial: Record<string, unknown> = {};
    for (const key of allKeys) {
      if (key !== omitKey) {
        partial[key] = validSample(shape)[key];
      }
    }
    inputs.push(partial);
  }

  return inputs;
}

function validSample(shape: z.ZodRawShape): Record<string, unknown> {
  // Generate a minimal valid sample (simplified)
  const sample: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(shape)) {
    if (value instanceof z.ZodString) sample[key] = "test";
    else if (value instanceof z.ZodNumber) sample[key] = 0;
    else if (value instanceof z.ZodBoolean) sample[key] = false;
    else if (value instanceof z.ZodArray) sample[key] = [];
    else sample[key] = null;
  }
  return sample;
}

// Boundary test runner
async function runBoundaryTests(
  agentName: string,
  inputSchema: z.ZodType,
  handler: (input: unknown) => Promise<unknown>,
  outputSchema: z.ZodType,
): Promise<{
  inputValidation: { rejectedInvalid: number; acceptedValid: number; leaked: number };
  outputValidation: { conformant: number; nonConformant: number };
}> {
  let rejectedInvalid = 0;
  let acceptedValid = 0;
  let leaked = 0;
  let conformant = 0;
  let nonConformant = 0;

  // Test invalid inputs are rejected
  const invalidInputs = [null, undefined, "", 0, [], {}, "not valid json"];
  for (const invalid of invalidInputs) {
    const parseResult = inputSchema.safeParse(invalid);
    if (!parseResult.success) {
      rejectedInvalid++;
    } else {
      leaked++; // Invalid input was accepted — potential problem
    }
  }

  // Test valid input produces conformant output
  // (Use actual valid samples for the agent)
  const validInputs = [
    // Add agent-specific valid inputs here
  ];

  for (const valid of validInputs) {
    const inputResult = inputSchema.safeParse(valid);
    if (inputResult.success) {
      acceptedValid++;
      try {
        const output = await handler(inputResult.data);
        const outputResult = outputSchema.safeParse(output);
        if (outputResult.success) {
          conformant++;
        } else {
          nonConformant++;
        }
      } catch {
        nonConformant++;
      }
    }
  }

  return {
    inputValidation: { rejectedInvalid, acceptedValid, leaked },
    outputValidation: { conformant, nonConformant },
  };
}
```

## Integration Testing Patterns

Test multiple agents working together in a controlled environment.

```typescript
import { z } from "zod";

// Integration test harness
class IntegrationTestHarness {
  private agents: Map<string, {
    handler: (input: unknown) => Promise<unknown>;
    inputSchema: z.ZodType;
    outputSchema: z.ZodType;
  }> = new Map();

  private interceptors: Array<{
    agentName: string;
    type: "before" | "after";
    fn: (data: unknown) => void;
  }> = [];

  registerAgent(
    name: string,
    config: {
      handler: (input: unknown) => Promise<unknown>;
      inputSchema: z.ZodType;
      outputSchema: z.ZodType;
    },
  ): void {
    this.agents.set(name, config);
  }

  // Add interceptors to observe data flow between agents
  intercept(
    agentName: string,
    type: "before" | "after",
    fn: (data: unknown) => void,
  ): void {
    this.interceptors = [...this.interceptors, { agentName, type, fn }];
  }

  async callAgent(name: string, input: unknown): Promise<unknown> {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent "${name}" not registered in test harness`);
    }

    // Run "before" interceptors
    for (const interceptor of this.interceptors) {
      if (interceptor.agentName === name && interceptor.type === "before") {
        interceptor.fn(input);
      }
    }

    // Validate input
    const validInput = agent.inputSchema.parse(input);

    // Execute
    const output = await agent.handler(validInput);

    // Validate output
    const validOutput = agent.outputSchema.parse(output);

    // Run "after" interceptors
    for (const interceptor of this.interceptors) {
      if (interceptor.agentName === name && interceptor.type === "after") {
        interceptor.fn(validOutput);
      }
    }

    return validOutput;
  }

  // Run a pipeline of agents and collect all intermediate results
  async runPipeline(
    agentSequence: string[],
    initialInput: unknown,
  ): Promise<{
    finalOutput: unknown;
    intermediateResults: Record<string, unknown>;
  }> {
    const intermediateResults: Record<string, unknown> = {};
    let currentInput = initialInput;

    for (const agentName of agentSequence) {
      const output = await this.callAgent(agentName, currentInput);
      intermediateResults[agentName] = output;
      currentInput = output;
    }

    return {
      finalOutput: currentInput,
      intermediateResults,
    };
  }
}

// Example integration test
async function testResearchAnalysisPipeline() {
  const harness = new IntegrationTestHarness();

  harness.registerAgent("research", {
    handler: async (input) => ({
      sources: [{ title: "Test", content: "Content", url: "https://example.com", relevance: 0.9 }],
      query: (input as { query: string }).query,
      searchTimeMs: 100,
    }),
    inputSchema: z.object({ query: z.string() }),
    outputSchema: ResearchOutputSchema,
  });

  harness.registerAgent("analysis", {
    handler: async (input) => ({
      themes: [{ name: "main theme", evidence: ["source 1"], confidence: 0.8 }],
      gaps: [],
    }),
    inputSchema: ResearchOutputSchema,
    outputSchema: z.object({
      themes: z.array(z.object({
        name: z.string(),
        evidence: z.array(z.string()),
        confidence: z.number(),
      })),
      gaps: z.array(z.string()),
    }),
  });

  // Capture intermediate data for assertions
  const capturedData: Record<string, unknown> = {};
  harness.intercept("analysis", "before", (data) => {
    capturedData["analysis_input"] = data;
  });

  const result = await harness.runPipeline(
    ["research", "analysis"],
    { query: "test query" },
  );

  // Assertions
  const analysisInput = capturedData["analysis_input"];
  // Verify research output was properly passed to analysis
  ResearchOutputSchema.parse(analysisInput);

  return result;
}
```

## Chaos Testing

Inject failures, delays, and corrupted data to test system resilience.

```typescript
// Chaos monkey for multi-agent systems
interface ChaosConfig {
  failureRate: number;       // 0-1: probability of injected failure
  latencyInjection: {
    probability: number;     // 0-1: probability of added latency
    minMs: number;
    maxMs: number;
  };
  dataCorruption: {
    probability: number;     // 0-1: probability of corrupted output
  };
}

function withChaos<TInput, TOutput>(
  handler: (input: TInput) => Promise<TOutput>,
  config: ChaosConfig,
): (input: TInput) => Promise<TOutput> {
  return async (input: TInput): Promise<TOutput> => {
    // Inject failure
    if (Math.random() < config.failureRate) {
      throw new Error("[CHAOS] Injected failure");
    }

    // Inject latency
    if (Math.random() < config.latencyInjection.probability) {
      const delay =
        config.latencyInjection.minMs +
        Math.random() *
          (config.latencyInjection.maxMs - config.latencyInjection.minMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    const result = await handler(input);

    // Inject data corruption
    if (Math.random() < config.dataCorruption.probability) {
      // Return a corrupted version — this tests downstream validation
      return { corrupted: true } as unknown as TOutput;
    }

    return result;
  };
}

// Run chaos tests
async function chaosTest(
  pipeline: (input: unknown) => Promise<unknown>,
  validInput: unknown,
  iterations: number,
  config: ChaosConfig,
): Promise<{
  totalRuns: number;
  succeeded: number;
  failed: number;
  failedGracefully: number; // Failed with proper error handling
  failedUngracefully: number; // Unhandled exception or corrupted output
}> {
  let succeeded = 0;
  let failedGracefully = 0;
  let failedUngracefully = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      const result = await pipeline(validInput);
      // Verify result is valid even under chaos
      if (result && typeof result === "object") {
        succeeded++;
      } else {
        failedUngracefully++;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("CHAOS") ||
         error.message.includes("validation") ||
         error.message.includes("Circuit breaker"))
      ) {
        failedGracefully++; // System detected and handled the failure
      } else {
        failedUngracefully++; // Unhandled failure
      }
    }
  }

  return {
    totalRuns: iterations,
    succeeded,
    failed: failedGracefully + failedUngracefully,
    failedGracefully,
    failedUngracefully,
  };
}
```

## Property-Based Testing for Schemas

Instead of testing specific examples, test that properties hold for all
possible inputs.

```typescript
import { z } from "zod";

// Generate random valid data from a schema (simplified generator)
function generateFromSchema(schema: z.ZodType, depth: number = 0): unknown {
  if (depth > 5) return null;

  if (schema instanceof z.ZodString) {
    const chars = "abcdefghijklmnopqrstuvwxyz";
    const length = Math.floor(Math.random() * 50) + 1;
    return Array.from({ length }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  }

  if (schema instanceof z.ZodNumber) {
    return Math.random() * 200 - 100;
  }

  if (schema instanceof z.ZodBoolean) {
    return Math.random() > 0.5;
  }

  if (schema instanceof z.ZodEnum) {
    const values = (schema as z.ZodEnum<[string, ...string[]]>).options;
    return values[Math.floor(Math.random() * values.length)];
  }

  if (schema instanceof z.ZodArray) {
    const length = Math.floor(Math.random() * 5);
    const elementSchema = (schema as z.ZodArray<z.ZodType>).element;
    return Array.from({ length }, () =>
      generateFromSchema(elementSchema, depth + 1)
    );
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(shape)) {
      result[key] = generateFromSchema(value as z.ZodType, depth + 1);
    }
    return result;
  }

  return null;
}

// Property: generated data always passes validation
async function testPropertyRoundTrip(
  schema: z.ZodType,
  iterations: number = 100,
): Promise<{ passed: number; failed: number; errors: string[] }> {
  let passed = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < iterations; i++) {
    const generated = generateFromSchema(schema);
    const result = schema.safeParse(generated);

    if (result.success) {
      // Property: parse(stringify(parse(x))) === parse(x)
      const serialized = JSON.stringify(result.data);
      const deserialized = JSON.parse(serialized);
      const revalidated = schema.safeParse(deserialized);

      if (revalidated.success) {
        passed++;
      } else {
        failed++;
        errors.push(
          `Round-trip failed at iteration ${i}: ${revalidated.error.message}`,
        );
      }
    } else {
      // Generator produced invalid data — this is a generator bug, not a schema bug
      failed++;
      errors.push(
        `Generator produced invalid data at iteration ${i}: ${result.error.message}`,
      );
    }
  }

  return { passed, failed, errors };
}
```

## Mock Agent Patterns

Replace real agents with deterministic mocks for testing.

```typescript
import { z } from "zod";

// Mock agent factory
function createMockAgent<TInput, TOutput>(config: {
  name: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  responses: Array<{
    when: (input: TInput) => boolean;
    respond: TOutput;
  }>;
  defaultResponse: TOutput;
}): {
  handler: (input: unknown) => Promise<TOutput>;
  callLog: () => ReadonlyArray<{ input: TInput; output: TOutput; timestamp: string }>;
  reset: () => void;
} {
  let calls: Array<{ input: TInput; output: TOutput; timestamp: string }> = [];

  return {
    handler: async (rawInput: unknown): Promise<TOutput> => {
      const input = config.inputSchema.parse(rawInput);

      // Find matching response
      const matchedResponse = config.responses.find((r) => r.when(input));
      const output = matchedResponse?.respond ?? config.defaultResponse;

      // Validate output matches schema
      const validOutput = config.outputSchema.parse(output);

      calls = [...calls, {
        input,
        output: validOutput,
        timestamp: new Date().toISOString(),
      }];

      return validOutput;
    },

    callLog: () => calls,

    reset: () => {
      calls = [];
    },
  };
}

// Example: mock research agent
const mockResearch = createMockAgent({
  name: "mock-research",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: ResearchOutputSchema,
  responses: [
    {
      when: (input) => input.query.includes("security"),
      respond: {
        sources: [
          {
            title: "Security Best Practices",
            content: "Always validate input...",
            url: "https://example.com/security",
            relevance: 0.95,
          },
        ],
        query: "security",
        searchTimeMs: 100,
      },
    },
  ],
  defaultResponse: {
    sources: [],
    query: "default",
    searchTimeMs: 50,
  },
});

// Failing mock: simulates agent failures
function createFailingMock(
  failAfterNCalls: number,
  error: Error,
): (input: unknown) => Promise<never> {
  let callCount = 0;

  return async (_input: unknown): Promise<never> => {
    callCount++;
    if (callCount > failAfterNCalls) {
      throw error;
    }
    throw error; // Always fails for simplicity; adjust as needed
  };
}

// Slow mock: simulates latency
function createSlowMock<T>(
  handler: (input: unknown) => Promise<T>,
  delayMs: number,
): (input: unknown) => Promise<T> {
  return async (input: unknown): Promise<T> => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return handler(input);
  };
}
```

## Test Checklist for Multi-Agent Systems

```typescript
// Use this checklist when testing a new multi-agent workflow

const testChecklist = {
  unit: {
    "Schema validation": "All schemas parse valid data and reject invalid data",
    "State transitions": "State machine only allows valid transitions",
    "Action handling": "All action types are exhaustively handled",
    "Error formatting": "Validation errors produce clear messages",
  },
  contract: {
    "Producer conformance": "Each agent's output matches its declared schema",
    "Consumer compatibility": "Each agent can process its declared input schema",
    "Version compatibility": "Old and new schema versions interoperate",
    "Boundary validation": "Edge cases at agent boundaries are handled",
  },
  integration: {
    "Pipeline flow": "Data flows correctly through the full pipeline",
    "Error propagation": "Errors in one agent are properly handled",
    "State consistency": "Shared state remains consistent after operations",
    "Retry behavior": "Failed operations are retried correctly",
  },
  chaos: {
    "Failure injection": "System handles random agent failures gracefully",
    "Latency injection": "System handles slow agents (timeouts work)",
    "Data corruption": "System detects and rejects corrupted data",
    "Circuit breakers": "Circuit breakers open on repeated failures",
  },
  e2e: {
    "Happy path": "Full workflow completes with valid input",
    "Error path": "Full workflow handles errors and reports them",
    "Escalation": "Failures escalate through the chain correctly",
    "Observability": "Correlation IDs, logs, and traces are complete",
  },
};
```

## Summary

Testing multi-agent systems requires a layered approach:

1. **Contract tests** are the highest-value tests. They verify that agents
   can communicate correctly through shared schemas.

2. **Boundary tests** ensure every agent validates its input and output,
   catching edge cases and type mismatches.

3. **Integration tests** verify that agents work together correctly,
   using interceptors to observe data flow.

4. **Chaos tests** verify resilience by injecting failures, latency,
   and corrupted data.

5. **Mock agents** enable deterministic testing without LLM calls,
   making tests fast, reproducible, and cheap.

The test suite should catch every failure mode from the catalog
(07-failure-modes-catalog.md) before it reaches production.
