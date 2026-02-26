/**
 * Schema Contract Testing
 *
 * Verifies that producer and consumer schemas remain compatible.
 * Detects breaking changes, validates schema shapes, and generates
 * property-based test data from Zod schemas. Uses a runner-agnostic
 * describe/it/expect style.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Test harness types (framework-agnostic)
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

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertParses<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string): void {
  const result = schema.safeParse(data);
  assert(result.success, `${label}: expected valid, got ${JSON.stringify(result.success ? {} : result.error.flatten())}`);
}

function assertRejects<T extends z.ZodTypeAny>(schema: T, data: unknown, label: string): void {
  const result = schema.safeParse(data);
  assert(!result.success, `${label}: expected rejection, but data was accepted`);
}

// ---------------------------------------------------------------------------
// Schema compatibility checking
// ---------------------------------------------------------------------------

/**
 * Check if `consumer` accepts everything that `producer` produces.
 * Tests a set of samples from the producer and validates them against
 * the consumer. This is a runtime approximation of structural subtyping.
 */
export function checkCompatibility<
  P extends z.ZodTypeAny,
  C extends z.ZodTypeAny,
>(
  producer: P,
  consumer: C,
  samples: ReadonlyArray<z.infer<P>>
): { compatible: boolean; failures: ReadonlyArray<string> } {
  const failures: string[] = [];

  for (let i = 0; i < samples.length; i++) {
    const result = consumer.safeParse(samples[i]);
    if (!result.success) {
      failures.push(
        `Sample ${i}: ${result.error.issues.map((is) => is.message).join("; ")}`
      );
    }
  }

  return { compatible: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Property-based data generator (simple, deterministic)
// ---------------------------------------------------------------------------

/**
 * Generate N random-ish samples that conform to the given schema.
 * Uses a naive approach: build minimal valid objects from the schema shape.
 * For production property-based testing, plug in fast-check or similar.
 */
export function generateSamples<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  count: number
): ReadonlyArray<z.infer<T>> {
  const shape = schema.shape;
  const samples: z.infer<T>[] = [];

  for (let i = 0; i < count; i++) {
    const obj: Record<string, unknown> = {};
    for (const [key, zodType] of Object.entries(shape)) {
      obj[key] = generateValue(zodType as z.ZodTypeAny, i);
    }
    // Validate to ensure defaults and transforms are applied
    samples.push(schema.parse(obj));
  }

  return samples;
}

function generateValue(schema: z.ZodTypeAny, seed: number): unknown {
  if (schema instanceof z.ZodString) return `sample-${seed}`;
  if (schema instanceof z.ZodNumber) return seed;
  if (schema instanceof z.ZodBoolean) return seed % 2 === 0;
  if (schema instanceof z.ZodEnum) {
    const values = schema.options as string[];
    return values[seed % values.length];
  }
  if (schema instanceof z.ZodArray) return [];
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodDefault) return undefined; // let Zod apply default
  if (schema instanceof z.ZodOptional) return seed % 3 === 0 ? undefined : generateValue(schema.unwrap(), seed);
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot testing for schema shapes
// ---------------------------------------------------------------------------

/**
 * Serialize a schema's shape into a stable string for snapshot comparison.
 * Detects added/removed/changed fields between versions.
 */
export function schemaSnapshot(schema: z.ZodObject<z.ZodRawShape>): string {
  const entries = Object.entries(schema.shape).map(([key, type]) => {
    const zodType = type as z.ZodTypeAny;
    return `${key}: ${describeType(zodType)}`;
  });
  return entries.sort().join("\n");
}

function describeType(schema: z.ZodTypeAny): string {
  if (schema instanceof z.ZodString) return "string";
  if (schema instanceof z.ZodNumber) return "number";
  if (schema instanceof z.ZodBoolean) return "boolean";
  if (schema instanceof z.ZodEnum) return `enum(${(schema.options as string[]).join("|")})`;
  if (schema instanceof z.ZodArray) return `array<${describeType(schema.element)}>`;
  if (schema instanceof z.ZodOptional) return `optional<${describeType(schema.unwrap())}>`;
  if (schema instanceof z.ZodDefault) return `default<${describeType(schema.removeDefault())}>`;
  if (schema instanceof z.ZodRecord) return "record";
  if (schema instanceof z.ZodObject) return "object";
  if (schema instanceof z.ZodUnion) return "union";
  if (schema instanceof z.ZodLiteral) return `literal(${String(schema.value)})`;
  return "unknown";
}

/**
 * Detect breaking changes between two schema snapshots.
 */
export function detectBreakingChanges(
  before: string,
  after: string
): { breaking: boolean; removed: ReadonlyArray<string>; changed: ReadonlyArray<string> } {
  const parseSnapshot = (s: string) =>
    new Map(s.split("\n").filter(Boolean).map((line) => {
      const [key, ...rest] = line.split(": ");
      return [key.trim(), rest.join(": ").trim()] as const;
    }));

  const beforeMap = parseSnapshot(before);
  const afterMap = parseSnapshot(after);

  const removed = [...beforeMap.keys()].filter((k) => !afterMap.has(k));
  const changed = [...beforeMap.entries()]
    .filter(([k, v]) => afterMap.has(k) && afterMap.get(k) !== v)
    .map(([k]) => k);

  return {
    breaking: removed.length > 0 || changed.length > 0,
    removed,
    changed,
  };
}

// ---------------------------------------------------------------------------
// Example contract test suite
// ---------------------------------------------------------------------------

/** Producer schema (what agent A outputs). */
const ProducerOutput = z.object({
  taskId: z.string(),
  result: z.string(),
  confidence: z.number(),
  tags: z.array(z.string()).default([]),
});

/** Consumer schema (what agent B expects as input). */
const ConsumerInput = z.object({
  taskId: z.string(),
  result: z.string(),
  confidence: z.number(),
});

export function runContractTests(): TestSuite {
  const results: TestResult[] = [];

  // Test 1: Producer output satisfies consumer input
  const samples = generateSamples(ProducerOutput, 10);
  const compat = checkCompatibility(ProducerOutput, ConsumerInput, samples);
  results.push({
    name: "producer output is compatible with consumer input",
    passed: compat.compatible,
    error: compat.compatible ? undefined : compat.failures.join("; "),
  });

  // Test 2: Valid data parses
  try {
    assertParses(ProducerOutput, { taskId: "t1", result: "ok", confidence: 0.9 }, "valid producer data");
    results.push({ name: "valid data parses against producer schema", passed: true });
  } catch (err) {
    results.push({ name: "valid data parses against producer schema", passed: false, error: (err as Error).message });
  }

  // Test 3: Invalid data is rejected
  try {
    assertRejects(ConsumerInput, { taskId: 123 }, "invalid consumer data");
    results.push({ name: "invalid data is rejected by consumer schema", passed: true });
  } catch (err) {
    results.push({ name: "invalid data is rejected by consumer schema", passed: false, error: (err as Error).message });
  }

  // Test 4: Schema snapshot stability
  const snapshot = schemaSnapshot(ProducerOutput);
  const changes = detectBreakingChanges(snapshot, snapshot);
  results.push({
    name: "schema snapshot has no breaking changes against itself",
    passed: !changes.breaking,
  });

  // Test 5: Removing a field is detected as breaking
  const ReducedProducer = z.object({
    taskId: z.string(),
    confidence: z.number(),
  });
  const beforeSnap = schemaSnapshot(ProducerOutput);
  const afterSnap = schemaSnapshot(ReducedProducer);
  const breakingChanges = detectBreakingChanges(beforeSnap, afterSnap);
  results.push({
    name: "removing a field is detected as breaking change",
    passed: breakingChanges.breaking && breakingChanges.removed.includes("result"),
  });

  return {
    name: "Schema Contract Tests",
    results,
    passed: results.every((r) => r.passed),
  };
}
