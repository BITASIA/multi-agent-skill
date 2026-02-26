---
name: generate-schemas
description: Generate Zod typed and action schemas from a natural language specification
---

# /generate-schemas

## Usage

```
/generate-schemas
/generate-schemas <spec-description>
```

Invoke without arguments for a fully interactive experience, or pass a natural language description of the data flowing between agents.

## Prerequisites

- A TypeScript project with Zod installed (`npm install zod`)
- An understanding of the agents in your system and what data flows between them

## Workflow

Follow these steps in order. Each step that requires user input MUST wait for a response before proceeding.

### Step 1: Gather Specification

If no spec description was provided as an argument, ask:

```
Describe the data that flows between your agents.
Include:
- What agents exist
- What data each agent sends and receives
- What actions each agent can perform

Example: "A research agent sends a list of findings (title, url, summary,
relevance score) to an analysis agent. The analysis agent produces a report
(sections with headers and body text, overall confidence score). A review
agent can approve, reject, or request-revision on the report."
```

### Step 2: Identify Data Types

Parse the specification and identify all distinct data types:

```
I identified these data types from your specification:

1. <TypeName> -- <brief description>
   Fields: <field list>

2. <TypeName> -- <brief description>
   Fields: <field list>

...

Does this look complete? Any types to add, remove, or modify?
```

Wait for user confirmation before proceeding.

### Step 3: Generate Typed Schemas

For each identified data type, generate a Zod schema:

```typescript
import { z } from 'zod';

// Schema version for evolution tracking
const SCHEMA_VERSION = '1.0.0';

export const FindingSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  summary: z.string(),
  relevanceScore: z.number().min(0).max(1),
});

export type Finding = z.infer<typeof FindingSchema>;
```

Apply these conventions:
- Use descriptive field names
- Add appropriate Zod validators (`.min()`, `.max()`, `.url()`, `.email()`, etc.)
- Use `z.enum()` for known string literals
- Use `z.discriminatedUnion()` for variant types
- Mark optional fields with `.optional()`
- Add `.describe()` annotations for complex fields

### Step 4: Identify Actions

Parse the specification for actions each agent can perform:

```
I identified these agent actions:

Agent: <agent-name>
  - <action-name>: <description> (payload: <fields>)
  - <action-name>: <description> (payload: <fields>)

Agent: <agent-name>
  - <action-name>: <description> (payload: <fields>)

Does this look complete? Any actions to add or modify?
```

Wait for user confirmation.

### Step 5: Generate Action Schemas

For each agent, generate a discriminated union action schema:

```typescript
import { z } from 'zod';

export const ReviewActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('approve'),
    reviewerId: z.string().uuid(),
    comments: z.string().optional(),
  }),
  z.object({
    type: z.literal('reject'),
    reviewerId: z.string().uuid(),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('request-revision'),
    reviewerId: z.string().uuid(),
    revisionNotes: z.array(z.string().min(1)),
  }),
]);

export type ReviewAction = z.infer<typeof ReviewActionSchema>;
```

### Step 6: Generate Validation Functions

Generate convenience validation wrappers:

```typescript
import { z, ZodSchema } from 'zod';

export function validateOrThrow<T>(schema: ZodSchema<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `Validation failed: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`
    );
  }
  return result.data;
}

export function validateSafe<T>(schema: ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; errors: string[] } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`),
  };
}
```

### Step 7: Generate Type Exports

Generate a barrel export file with all types:

```typescript
// schemas/index.ts
export { FindingSchema, type Finding } from './findings';
export { ReportSchema, type Report } from './report';
export { ReviewActionSchema, type ReviewAction } from './review-actions';
export { validateOrThrow, validateSafe } from './validation';
export { SCHEMA_VERSION } from './version';
```

### Step 8: Add Schema Versioning Boilerplate

Generate a version registry:

```typescript
// schemas/version.ts
export const SCHEMA_VERSION = '1.0.0';

export const SchemaRegistry = {
  Finding: { version: '1.0.0', schema: FindingSchema },
  Report: { version: '1.0.0', schema: ReportSchema },
  ReviewAction: { version: '1.0.0', schema: ReviewActionSchema },
} as const;
```

### Step 9: Present for Review

Display all generated schemas together and ask:

```
Here are the complete generated schemas.
Please review:

1. Are all field types correct?
2. Are validation rules appropriate (min/max, formats, etc.)?
3. Are there missing fields or actions?
4. Should any optional fields be required, or vice versa?

Feedback:
```

### Step 10: Apply Feedback

Incorporate any user feedback and regenerate affected schemas. Repeat until the user approves.

### Step 11: Write Schema Files

Ask where to write the files:

```
Where should I write the schema files?

Suggested structure:
  <project-root>/src/schemas/
    findings.ts
    report.ts
    review-actions.ts
    validation.ts
    version.ts
    index.ts

Accept this structure, or specify an alternative path:
```

Write all schema files to the confirmed location.

## Output

- Zod typed schemas for all inter-agent data types
- Discriminated union action schemas for each agent
- Validation utility functions
- Schema versioning boilerplate
- Barrel export file

## References

- references/02-typed-schemas.md
- references/03-action-schemas.md
- templates/schemas/*
