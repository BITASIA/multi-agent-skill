---
name: generate-mcp-tool
description: Scaffold an MCP tool definition with input/output schemas and validation
---

# /generate-mcp-tool

## Usage

```
/generate-mcp-tool
/generate-mcp-tool <tool-name>
```

Invoke without arguments for a fully interactive experience, or pass a tool name to skip the first prompt.

## Prerequisites

- A TypeScript project with Zod installed (`npm install zod`)
- Understanding of MCP (Model Context Protocol) tool conventions
- Knowledge of what the tool should do (inputs, processing, outputs)

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Gather Tool Name and Description

If no tool name was provided as an argument, ask:

```
What is the name of your MCP tool?
(Use kebab-case, e.g., search-codebase, analyze-pr, run-tests)
```

Then ask for a description:

```
Describe what this tool does in one sentence:
(e.g., "Searches the codebase for files matching a pattern and returns matching lines")
```

### Step 2: Define Tool Behavior

Ask the user to describe the tool's behavior:

```
Describe the tool's inputs, processing, and outputs:

Inputs:
  What parameters does this tool accept?
  (e.g., "a search query string, optional file glob pattern, max results count")

Processing:
  What does the tool do with the inputs?
  (e.g., "runs ripgrep on the codebase, filters by glob, limits results")

Outputs:
  What does the tool return on success?
  (e.g., "list of matches with file path, line number, and matching text")

Error cases:
  What can go wrong?
  (e.g., "invalid glob pattern, no results found, search timeout")
```

### Step 3: Generate Input Schema

Based on the described inputs, generate a Zod input schema:

```typescript
import { z } from 'zod';

export const SearchCodebaseInputSchema = z.object({
  query: z.string().min(1).describe('The search query string'),
  glob: z.string().optional().describe('File glob pattern to filter results'),
  maxResults: z.number().int().min(1).max(1000).default(100).describe('Maximum number of results to return'),
});

export type SearchCodebaseInput = z.infer<typeof SearchCodebaseInputSchema>;
```

Present the schema and ask:

```
Here's the generated input schema. Are the types, constraints, and defaults correct?
```

### Step 4: Generate Output Schema

Based on the described outputs, generate a Zod output schema:

```typescript
export const SearchCodebaseOutputSchema = z.object({
  matches: z.array(z.object({
    filePath: z.string(),
    lineNumber: z.number().int().positive(),
    lineContent: z.string(),
    context: z.object({
      before: z.array(z.string()),
      after: z.array(z.string()),
    }).optional(),
  })),
  totalMatches: z.number().int().min(0),
  truncated: z.boolean(),
});

export type SearchCodebaseOutput = z.infer<typeof SearchCodebaseOutputSchema>;
```

Present the schema and ask for confirmation.

### Step 5: Generate MCP Tool Definition

Generate the complete MCP tool definition:

```typescript
import { z } from 'zod';
import { SearchCodebaseInputSchema, SearchCodebaseOutputSchema } from './schemas';
import type { SearchCodebaseInput, SearchCodebaseOutput } from './schemas';

export const searchCodebaseTool = {
  name: 'search-codebase',
  description: 'Searches the codebase for files matching a pattern and returns matching lines',
  version: '1.0.0',
  inputSchema: SearchCodebaseInputSchema,
  outputSchema: SearchCodebaseOutputSchema,

  async execute(rawInput: unknown): Promise<SearchCodebaseOutput> {
    // Pre-execution validation
    const input = SearchCodebaseInputSchema.parse(rawInput);

    try {
      // TODO: Implement tool logic
      const result = await performSearch(input);

      // Output validation
      return SearchCodebaseOutputSchema.parse(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ToolValidationError(
          `Output validation failed: ${error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`
        );
      }
      throw new ToolExecutionError(
        `search-codebase failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  },
};
```

Generate supporting error classes:

```typescript
export class ToolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolValidationError';
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
```

### Step 6: Generate Contract Test

Generate a basic contract test for the tool:

```typescript
import { describe, it, expect } from 'vitest';
import { SearchCodebaseInputSchema, SearchCodebaseOutputSchema } from './schemas';
import { searchCodebaseTool } from './search-codebase';

describe('search-codebase tool contract', () => {
  describe('input schema', () => {
    it('accepts valid input', () => {
      const input = { query: 'function', glob: '*.ts', maxResults: 50 };
      expect(() => SearchCodebaseInputSchema.parse(input)).not.toThrow();
    });

    it('rejects empty query', () => {
      const input = { query: '' };
      expect(() => SearchCodebaseInputSchema.parse(input)).toThrow();
    });

    it('applies default maxResults', () => {
      const input = { query: 'function' };
      const parsed = SearchCodebaseInputSchema.parse(input);
      expect(parsed.maxResults).toBe(100);
    });

    it('rejects invalid maxResults', () => {
      const input = { query: 'function', maxResults: -1 };
      expect(() => SearchCodebaseInputSchema.parse(input)).toThrow();
    });
  });

  describe('output schema', () => {
    it('accepts valid output', () => {
      const output = {
        matches: [{
          filePath: 'src/index.ts',
          lineNumber: 42,
          lineContent: 'export function main() {',
        }],
        totalMatches: 1,
        truncated: false,
      };
      expect(() => SearchCodebaseOutputSchema.parse(output)).not.toThrow();
    });

    it('rejects missing required fields', () => {
      const output = { matches: [] };
      expect(() => SearchCodebaseOutputSchema.parse(output)).toThrow();
    });
  });

  describe('execution', () => {
    it('rejects invalid input at runtime', async () => {
      await expect(searchCodebaseTool.execute({})).rejects.toThrow();
    });
  });
});
```

### Step 7: Present for Review

Display all generated files and ask:

```
Here's the complete MCP tool scaffold:

1. schemas.ts     -- Input and output Zod schemas
2. <tool-name>.ts -- Tool definition with validation and error handling
3. errors.ts      -- Custom error classes
4. <tool-name>.test.ts -- Contract tests

Would you like to modify anything before I write the files?
```

### Step 8: Write Files

Ask where to write the files:

```
Where should I write the tool files?

Suggested structure:
  <project-root>/src/tools/<tool-name>/
    schemas.ts
    <tool-name>.ts
    errors.ts
    <tool-name>.test.ts

Accept this structure, or specify an alternative path:
```

Write all files to the confirmed location.

## Output

- Zod input and output schemas for the tool
- MCP tool definition with pre-execution validation and error handling
- Custom error classes for validation and execution failures
- Contract test file with input, output, and execution tests

## References

- references/04-mcp-contracts.md
- templates/mcp/*
