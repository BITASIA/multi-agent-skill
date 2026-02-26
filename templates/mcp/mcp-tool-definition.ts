/**
 * MCP Tool Definition with Typed Schemas
 *
 * Defines the structure for MCP-compatible tools with Zod-validated
 * input and output schemas. Framework-agnostic – works with any MCP
 * server implementation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

export const ToolMetadata = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]*$/),
  description: z.string().min(1).max(1024),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  category: z.string().min(1).optional(),
  deprecated: z.boolean().default(false),
  deprecationMessage: z.string().optional(),
});

export type ToolMetadata = z.infer<typeof ToolMetadata>;

// ---------------------------------------------------------------------------
// Generic tool definition
// ---------------------------------------------------------------------------

/**
 * A tool definition pairs metadata with typed input/output schemas.
 * The schemas are Zod objects so they can be used for both runtime
 * validation and compile-time type inference.
 */
export interface ToolDefinition<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  readonly metadata: ToolMetadata;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly execute: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}

/**
 * Helper to define a tool with full type inference.
 * Returns a frozen ToolDefinition – immutable by design.
 */
export function defineTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny,
>(config: {
  readonly metadata: ToolMetadata;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly execute: (input: z.infer<TInput>) => Promise<z.infer<TOutput>>;
}): ToolDefinition<TInput, TOutput> {
  return Object.freeze({ ...config });
}

// ---------------------------------------------------------------------------
// Example tools
// ---------------------------------------------------------------------------

// -- Search tool --

const SearchInput = z.object({
  query: z.string().min(1).max(500),
  maxResults: z.number().int().positive().max(100).default(10),
  filters: z.record(z.string()).default({}),
});

const SearchOutput = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      snippet: z.string(),
      score: z.number().min(0).max(1),
    })
  ),
  totalCount: z.number().int().nonneg(),
  queryTimeMs: z.number().nonneg(),
});

export const searchTool = defineTool({
  metadata: {
    name: "search",
    description: "Full-text search across the knowledge base.",
    version: "1.0.0",
    category: "retrieval",
    deprecated: false,
  },
  inputSchema: SearchInput,
  outputSchema: SearchOutput,
  execute: async (input) => ({
    results: [],
    totalCount: 0,
    queryTimeMs: 0,
  }),
});

// -- Create tool --

const CreateInput = z.object({
  resource: z.string().min(1),
  data: z.record(z.unknown()),
  dryRun: z.boolean().default(false),
});

const CreateOutput = z.object({
  id: z.string().uuid(),
  resource: z.string(),
  created: z.boolean(),
  createdAt: z.string().datetime(),
});

export const createTool = defineTool({
  metadata: {
    name: "create-resource",
    description: "Create a new resource in the system.",
    version: "1.0.0",
    category: "mutation",
    deprecated: false,
  },
  inputSchema: CreateInput,
  outputSchema: CreateOutput,
  execute: async (input) => ({
    id: crypto.randomUUID(),
    resource: input.resource,
    created: !input.dryRun,
    createdAt: new Date().toISOString(),
  }),
});

// -- Analyze tool --

const AnalyzeInput = z.object({
  content: z.string().min(1),
  analysisType: z.enum(["sentiment", "summary", "entities", "classification"]),
  options: z.record(z.unknown()).default({}),
});

const AnalyzeOutput = z.object({
  analysisType: z.string(),
  result: z.unknown(),
  confidence: z.number().min(0).max(1),
  processingTimeMs: z.number().nonneg(),
});

export const analyzeTool = defineTool({
  metadata: {
    name: "analyze",
    description: "Run NLP analysis on provided content.",
    version: "1.2.0",
    category: "analysis",
    deprecated: false,
  },
  inputSchema: AnalyzeInput,
  outputSchema: AnalyzeOutput,
  execute: async (input) => ({
    analysisType: input.analysisType,
    result: null,
    confidence: 0,
    processingTimeMs: 0,
  }),
});

// ---------------------------------------------------------------------------
// Tool registry – immutable collection of tools
// ---------------------------------------------------------------------------

export interface ToolRegistry {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
}

/**
 * Create a registry from an array of tool definitions.
 * Throws if duplicate names are detected.
 */
export function createRegistry(
  definitions: ReadonlyArray<ToolDefinition>
): ToolRegistry {
  const entries = definitions.map((def) => {
    return [def.metadata.name, def] as const;
  });

  const names = entries.map(([name]) => name);
  const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate tool names: ${duplicates.join(", ")}`);
  }

  return Object.freeze({
    tools: new Map(entries),
  });
}

/**
 * Look up a tool by name. Returns undefined when not found.
 */
export function lookupTool(
  registry: ToolRegistry,
  name: string
): ToolDefinition | undefined {
  return registry.tools.get(name);
}

/**
 * List all tool names in the registry.
 */
export function listToolNames(registry: ToolRegistry): ReadonlyArray<string> {
  return Array.from(registry.tools.keys());
}
