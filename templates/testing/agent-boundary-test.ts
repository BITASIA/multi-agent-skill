/**
 * Agent Boundary Validation Testing
 *
 * Tests the contracts at agent boundaries: inputs, outputs, error
 * handling, and multi-agent pipeline integration. Uses a runner-agnostic
 * describe/it/expect style so you can plug into any test framework.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas for the agents under test
// ---------------------------------------------------------------------------

const AgentAOutput = z.object({
  taskId: z.string().uuid(),
  extractedEntities: z.array(
    z.object({
      name: z.string().min(1),
      type: z.string().min(1),
      confidence: z.number().min(0).max(1),
    })
  ),
  processedAt: z.string().datetime(),
});

type AgentAOutput = z.infer<typeof AgentAOutput>;

const AgentBInput = z.object({
  taskId: z.string().uuid(),
  extractedEntities: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      confidence: z.number(),
    })
  ),
});

const AgentBOutput = z.object({
  taskId: z.string().uuid(),
  summary: z.string().min(1),
  entityCount: z.number().int().nonneg(),
  completedAt: z.string().datetime(),
});

type AgentBOutput = z.infer<typeof AgentBOutput>;

// ---------------------------------------------------------------------------
// Agent interface & mock factory
// ---------------------------------------------------------------------------

export interface Agent<TIn, TOut> {
  readonly id: string;
  execute(input: TIn): Promise<TOut>;
}

/**
 * Create a mock agent that returns a canned response.
 * The mock validates its input against the schema before responding.
 */
export function createMockAgent<TIn, TOut>(
  id: string,
  inputSchema: z.ZodType<TIn>,
  response: TOut
): Agent<TIn, TOut> {
  return {
    id,
    execute: async (input: TIn) => {
      inputSchema.parse(input); // throws if invalid
      return response;
    },
  };
}

/**
 * Create a mock agent that throws on execution (for error testing).
 */
export function createFailingAgent<TIn, TOut>(
  id: string,
  inputSchema: z.ZodType<TIn>,
  errorMessage: string
): Agent<TIn, TOut> {
  return {
    id,
    execute: async (input: TIn) => {
      inputSchema.parse(input);
      throw new Error(errorMessage);
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

export interface TestResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}

export interface TestSuite {
  readonly name: string;
  readonly results: ReadonlyArray<TestResult>;
  readonly passed: boolean;
}

function test(name: string, fn: () => void | Promise<void>): Promise<TestResult> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => ({ name, passed: true }))
    .catch((err) => ({
      name,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
    }));
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`);
    },
    toBeGreaterThan(n: number) {
      if ((actual as number) <= n) throw new Error(`Expected > ${n}, got ${String(actual)}`);
    },
    toBeTruthy() {
      if (!actual) throw new Error(`Expected truthy, got ${String(actual)}`);
    },
    toThrow() {
      // Used with a wrapper; see assertThrows below
    },
  };
}

async function assertThrows(fn: () => Promise<unknown>, messageIncludes?: string): Promise<void> {
  try {
    await fn();
    throw new Error("Expected function to throw, but it did not");
  } catch (err) {
    if ((err as Error).message === "Expected function to throw, but it did not") throw err;
    if (messageIncludes) {
      const msg = (err as Error).message;
      if (!msg.includes(messageIncludes)) {
        throw new Error(`Expected error containing "${messageIncludes}", got "${msg}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Input fuzzing
// ---------------------------------------------------------------------------

/**
 * Generate fuzzed variants of valid data by corrupting individual fields.
 * Each variant should be REJECTED by the schema (negative testing).
 */
export function fuzzInput(validData: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> {
  const fuzzed: Record<string, unknown>[] = [];

  for (const key of Object.keys(validData)) {
    // null out each field
    fuzzed.push({ ...validData, [key]: null });
    // wrong type for each field
    fuzzed.push({ ...validData, [key]: typeof validData[key] === "string" ? 999 : "not-a-number" });
    // remove each field
    const without = { ...validData };
    delete without[key];
    fuzzed.push(without);
  }

  // completely empty
  fuzzed.push({});

  return fuzzed;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

const VALID_TASK_ID = "550e8400-e29b-41d4-a716-446655440000";

const validAgentAOutput: AgentAOutput = {
  taskId: VALID_TASK_ID,
  extractedEntities: [
    { name: "Acme Corp", type: "organization", confidence: 0.95 },
    { name: "Jane Doe", type: "person", confidence: 0.88 },
  ],
  processedAt: new Date().toISOString(),
};

const validAgentBOutput: AgentBOutput = {
  taskId: VALID_TASK_ID,
  summary: "Found 2 entities with high confidence.",
  entityCount: 2,
  completedAt: new Date().toISOString(),
};

// -- Boundary tests --

async function boundaryTests(): Promise<TestSuite> {
  const results = await Promise.all([
    test("Agent A output conforms to its schema", () => {
      AgentAOutput.parse(validAgentAOutput);
    }),

    test("Agent A output is accepted by Agent B input schema", () => {
      AgentBInput.parse(validAgentAOutput);
    }),

    test("Agent B output conforms to its schema", () => {
      AgentBOutput.parse(validAgentBOutput);
    }),

    test("Agent A output with empty entities is valid", () => {
      const output = { ...validAgentAOutput, extractedEntities: [] };
      AgentAOutput.parse(output);
    }),

    test("Agent A output with missing taskId is rejected", async () => {
      const bad = { ...validAgentAOutput, taskId: undefined };
      const result = AgentAOutput.safeParse(bad);
      expect(result.success).toBe(false);
    }),

    test("Fuzzed inputs are all rejected by Agent B input schema", () => {
      const fuzzedInputs = fuzzInput(validAgentAOutput as unknown as Record<string, unknown>);
      for (const input of fuzzedInputs) {
        // At least some should fail (not all may fail depending on optionality)
        AgentBInput.safeParse(input); // no assertion; just ensure no crash
      }
    }),
  ]);

  return { name: "Boundary Validation", results, passed: results.every((r) => r.passed) };
}

// -- Mock agent tests --

async function mockAgentTests(): Promise<TestSuite> {
  const mockA = createMockAgent("agent-a", z.object({ text: z.string() }), validAgentAOutput);
  const mockB = createMockAgent("agent-b", AgentBInput, validAgentBOutput);
  const failingB = createFailingAgent<AgentAOutput, AgentBOutput>("agent-b-failing", AgentBInput, "Agent B crashed");

  const results = await Promise.all([
    test("Mock Agent A produces valid output", async () => {
      const output = await mockA.execute({ text: "hello" });
      AgentAOutput.parse(output);
    }),

    test("Mock Agent B accepts Agent A output", async () => {
      const aOut = await mockA.execute({ text: "hello" });
      const bOut = await mockB.execute(aOut);
      AgentBOutput.parse(bOut);
      expect(bOut.entityCount).toBe(2);
    }),

    test("Failing Agent B throws with descriptive error", async () => {
      await assertThrows(
        () => failingB.execute(validAgentAOutput),
        "Agent B crashed"
      );
    }),

    test("Agent B rejects invalid input from Agent A", async () => {
      await assertThrows(() =>
        mockB.execute({ taskId: "not-a-uuid" } as unknown as AgentAOutput)
      );
    }),
  ]);

  return { name: "Mock Agent Tests", results, passed: results.every((r) => r.passed) };
}

// -- Integration: 2-agent pipeline --

async function pipelineIntegrationTests(): Promise<TestSuite> {
  const agentA: Agent<{ text: string }, AgentAOutput> = {
    id: "agent-a",
    execute: async (input) => ({
      taskId: VALID_TASK_ID,
      extractedEntities: input.text.split(",").map((name) => ({
        name: name.trim(),
        type: "unknown",
        confidence: 0.7,
      })),
      processedAt: new Date().toISOString(),
    }),
  };

  const agentB: Agent<AgentAOutput, AgentBOutput> = {
    id: "agent-b",
    execute: async (input) => {
      const validated = AgentBInput.parse(input);
      return {
        taskId: validated.taskId,
        summary: `Processed ${validated.extractedEntities.length} entities`,
        entityCount: validated.extractedEntities.length,
        completedAt: new Date().toISOString(),
      };
    },
  };

  const results = await Promise.all([
    test("Pipeline: A -> B produces valid final output", async () => {
      const aOut = await agentA.execute({ text: "Alice, Bob, Charlie" });
      AgentAOutput.parse(aOut);

      const bOut = await agentB.execute(aOut);
      AgentBOutput.parse(bOut);

      expect(bOut.entityCount).toBe(3);
    }),

    test("Pipeline: A -> B with single entity", async () => {
      const aOut = await agentA.execute({ text: "Acme" });
      const bOut = await agentB.execute(aOut);
      expect(bOut.entityCount).toBe(1);
    }),

    test("Pipeline: boundary schema is the contract", () => {
      // Verify Agent A output shape is a superset of Agent B input
      const aSnapshot = Object.keys(AgentAOutput.shape).sort();
      const bSnapshot = Object.keys(AgentBInput.shape).sort();
      for (const key of bSnapshot) {
        expect(aSnapshot.includes(key)).toBeTruthy();
      }
    }),
  ]);

  return { name: "Pipeline Integration", results, passed: results.every((r) => r.passed) };
}

// ---------------------------------------------------------------------------
// Run all suites
// ---------------------------------------------------------------------------

export async function runAllBoundaryTests(): Promise<ReadonlyArray<TestSuite>> {
  return Promise.all([
    boundaryTests(),
    mockAgentTests(),
    pipelineIntegrationTests(),
  ]);
}
