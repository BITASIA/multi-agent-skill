/**
 * Sequential Pipeline Orchestration
 *
 * A type-safe pipeline where each step's output becomes the next step's
 * input. The pipeline builder is immutable – every `.addStep()` returns
 * a NEW pipeline instance. Validation runs between each step.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Pipeline step interface
// ---------------------------------------------------------------------------

export interface PipelineStep<TIn, TOut> {
  readonly name: string;
  readonly inputSchema: z.ZodType<TIn>;
  readonly outputSchema: z.ZodType<TOut>;
  readonly execute: (input: TIn) => Promise<TOut>;
}

// ---------------------------------------------------------------------------
// Pipeline execution state
// ---------------------------------------------------------------------------

export const StepResult = z.object({
  stepName: z.string(),
  status: z.enum(["success", "failed", "skipped"]),
  durationMs: z.number().nonneg(),
  error: z.string().optional(),
});

export type StepResult = z.infer<typeof StepResult>;

export interface PipelineResult<T> {
  readonly success: boolean;
  readonly output?: T;
  readonly error?: string;
  readonly stepResults: ReadonlyArray<StepResult>;
  readonly totalDurationMs: number;
}

// ---------------------------------------------------------------------------
// Recovery strategy
// ---------------------------------------------------------------------------

export type RecoveryStrategy<TIn, TOut> = (
  error: Error,
  input: TIn,
  stepName: string
) => Promise<TOut | null>;

// ---------------------------------------------------------------------------
// Pipeline builder (immutable – each method returns a new object)
// ---------------------------------------------------------------------------

export interface Pipeline<TIn, TOut> {
  readonly steps: ReadonlyArray<PipelineStep<unknown, unknown>>;
  addStep<TNext>(
    step: PipelineStep<TOut, TNext>,
    recovery?: RecoveryStrategy<TOut, TNext>
  ): Pipeline<TIn, TNext>;
  run(input: TIn): Promise<PipelineResult<TOut>>;
}

interface StepEntry {
  readonly step: PipelineStep<unknown, unknown>;
  readonly recovery?: RecoveryStrategy<unknown, unknown>;
}

function createPipeline<TIn, TOut>(
  entries: ReadonlyArray<StepEntry>,
  firstInputSchema: z.ZodType<TIn>
): Pipeline<TIn, TOut> {
  return {
    steps: entries.map((e) => e.step),

    addStep<TNext>(
      step: PipelineStep<TOut, TNext>,
      recovery?: RecoveryStrategy<TOut, TNext>
    ): Pipeline<TIn, TNext> {
      const newEntries = [
        ...entries,
        { step: step as PipelineStep<unknown, unknown>, recovery } as StepEntry,
      ];
      return createPipeline<TIn, TNext>(newEntries, firstInputSchema);
    },

    async run(input: TIn): Promise<PipelineResult<TOut>> {
      return executePipeline<TIn, TOut>(entries, firstInputSchema, input);
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline execution engine
// ---------------------------------------------------------------------------

async function executePipeline<TIn, TOut>(
  entries: ReadonlyArray<StepEntry>,
  firstInputSchema: z.ZodType<TIn>,
  input: TIn
): Promise<PipelineResult<TOut>> {
  const pipelineStart = Date.now();
  const stepResults: StepResult[] = [];

  // Validate initial input
  const initialParse = firstInputSchema.safeParse(input);
  if (!initialParse.success) {
    return {
      success: false,
      error: `Pipeline input validation failed: ${initialParse.error.message}`,
      stepResults: [],
      totalDurationMs: Date.now() - pipelineStart,
    };
  }

  let current: unknown = initialParse.data;

  for (const entry of entries) {
    const { step, recovery } = entry;
    const stepStart = Date.now();

    // Validate step input
    const inputParse = step.inputSchema.safeParse(current);
    if (!inputParse.success) {
      stepResults.push({
        stepName: step.name,
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: `Input validation: ${inputParse.error.message}`,
      });
      return {
        success: false,
        error: `Step "${step.name}" input validation failed`,
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
      };
    }

    try {
      const output = await step.execute(inputParse.data);

      // Validate step output
      const outputParse = step.outputSchema.safeParse(output);
      if (!outputParse.success) {
        throw new Error(`Output validation: ${outputParse.error.message}`);
      }

      current = outputParse.data;
      stepResults.push({
        stepName: step.name,
        status: "success",
        durationMs: Date.now() - stepStart,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // Attempt recovery
      if (recovery) {
        const recovered = await recovery(error, inputParse.data, step.name);
        if (recovered !== null) {
          current = recovered;
          stepResults.push({
            stepName: step.name,
            status: "success",
            durationMs: Date.now() - stepStart,
            error: `Recovered: ${error.message}`,
          });
          continue;
        }
      }

      stepResults.push({
        stepName: step.name,
        status: "failed",
        durationMs: Date.now() - stepStart,
        error: error.message,
      });
      return {
        success: false,
        error: `Step "${step.name}" failed: ${error.message}`,
        stepResults,
        totalDurationMs: Date.now() - pipelineStart,
      };
    }
  }

  return {
    success: true,
    output: current as TOut,
    stepResults,
    totalDurationMs: Date.now() - pipelineStart,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Start building a pipeline with a typed initial input schema.
 */
export function pipeline<TIn>(
  inputSchema: z.ZodType<TIn>
): Pipeline<TIn, TIn> {
  return createPipeline<TIn, TIn>([], inputSchema);
}

// ---------------------------------------------------------------------------
// Example: 3-step data processing pipeline
// ---------------------------------------------------------------------------

// Step schemas
const RawData = z.object({ text: z.string().min(1) });
type RawData = z.infer<typeof RawData>;

const CleanedData = z.object({ text: z.string(), wordCount: z.number().int().nonneg() });
type CleanedData = z.infer<typeof CleanedData>;

const AnalyzedData = z.object({
  text: z.string(),
  wordCount: z.number(),
  sentiment: z.enum(["positive", "negative", "neutral"]),
});
type AnalyzedData = z.infer<typeof AnalyzedData>;

const Report = z.object({ summary: z.string(), analyzedAt: z.string().datetime() });
type Report = z.infer<typeof Report>;

const cleanStep: PipelineStep<RawData, CleanedData> = {
  name: "clean",
  inputSchema: RawData,
  outputSchema: CleanedData,
  execute: async (input) => ({
    text: input.text.trim().toLowerCase(),
    wordCount: input.text.split(/\s+/).length,
  }),
};

const analyzeStep: PipelineStep<CleanedData, AnalyzedData> = {
  name: "analyze",
  inputSchema: CleanedData,
  outputSchema: AnalyzedData,
  execute: async (input) => ({
    ...input,
    sentiment: "neutral" as const,
  }),
};

const reportStep: PipelineStep<AnalyzedData, Report> = {
  name: "report",
  inputSchema: AnalyzedData,
  outputSchema: Report,
  execute: async (input) => ({
    summary: `${input.wordCount} words, sentiment: ${input.sentiment}`,
    analyzedAt: new Date().toISOString(),
  }),
};

/** Ready-to-run example pipeline. */
export const examplePipeline = pipeline(RawData)
  .addStep(cleanStep)
  .addStep(analyzeStep)
  .addStep(reportStep);
