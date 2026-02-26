/**
 * Versioned Shared State Schema
 *
 * Manages state that multiple agents read and write. Every mutation
 * produces a NEW state object (immutable). Conflict detection uses
 * optimistic concurrency via version numbers.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// State phase (lifecycle of an agent's work)
// ---------------------------------------------------------------------------

export const StatePhase = z.enum([
  "idle",
  "initializing",
  "running",
  "waiting",
  "completed",
  "failed",
]);

export type StatePhase = z.infer<typeof StatePhase>;

// ---------------------------------------------------------------------------
// Valid phase transitions (directed graph)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Readonly<Record<StatePhase, ReadonlyArray<StatePhase>>> = {
  idle: ["initializing"],
  initializing: ["running", "failed"],
  running: ["waiting", "completed", "failed"],
  waiting: ["running", "failed"],
  completed: ["idle"],
  failed: ["idle", "initializing"],
};

// ---------------------------------------------------------------------------
// Agent state schema
// ---------------------------------------------------------------------------

export const AgentState = z.object({
  stateId: z.string().uuid(),
  agentId: z.string().min(1),
  version: z.number().int().nonneg(),
  phase: StatePhase,
  data: z.record(z.unknown()).default({}),
  lastUpdatedBy: z.string().min(1),
  updatedAt: z.string().datetime(),
  tags: z.array(z.string()).default([]),
});

export type AgentState = z.infer<typeof AgentState>;

// ---------------------------------------------------------------------------
// State history entry
// ---------------------------------------------------------------------------

export const StateHistoryEntry = z.object({
  version: z.number().int().nonneg(),
  phase: StatePhase,
  data: z.record(z.unknown()),
  updatedBy: z.string().min(1),
  updatedAt: z.string().datetime(),
  reason: z.string().optional(),
});

export type StateHistoryEntry = z.infer<typeof StateHistoryEntry>;

// ---------------------------------------------------------------------------
// Full state container (current state + history)
// ---------------------------------------------------------------------------

export const StateContainer = z.object({
  current: AgentState,
  history: z.array(StateHistoryEntry).default([]),
});

export type StateContainer = z.infer<typeof StateContainer>;

// ---------------------------------------------------------------------------
// Transition validation
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: StatePhase,
    public readonly to: StatePhase
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

/**
 * Returns true when `from -> to` is a legal phase transition.
 */
export function isValidTransition(from: StatePhase, to: StatePhase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Immutable state update (NEVER mutates the original)
// ---------------------------------------------------------------------------

export interface StateUpdate {
  readonly phase?: StatePhase;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly updatedBy: string;
  readonly reason?: string;
}

/**
 * Produces a NEW AgentState with the requested changes applied.
 * Validates phase transitions and bumps the version number.
 *
 * @throws InvalidTransitionError if the phase transition is illegal
 */
export function updateState(
  container: Readonly<StateContainer>,
  update: Readonly<StateUpdate>
): StateContainer {
  const { current, history } = container;
  const nextPhase = update.phase ?? current.phase;

  if (update.phase && !isValidTransition(current.phase, update.phase)) {
    throw new InvalidTransitionError(current.phase, update.phase);
  }

  const now = new Date().toISOString();
  const historyEntry: StateHistoryEntry = {
    version: current.version,
    phase: current.phase,
    data: { ...current.data },
    updatedBy: current.lastUpdatedBy,
    updatedAt: current.updatedAt,
    reason: update.reason,
  };

  const nextState: AgentState = {
    ...current,
    version: current.version + 1,
    phase: nextPhase,
    data: update.data ? { ...current.data, ...update.data } : { ...current.data },
    lastUpdatedBy: update.updatedBy,
    updatedAt: now,
  };

  return {
    current: nextState,
    history: [...history, historyEntry],
  };
}

// ---------------------------------------------------------------------------
// Conflict detection (optimistic concurrency)
// ---------------------------------------------------------------------------

export class VersionConflictError extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number
  ) {
    super(`Version conflict: expected ${expected}, found ${actual}`);
    this.name = "VersionConflictError";
  }
}

/**
 * Apply an update only when the caller's expected version matches.
 * Prevents lost-update problems in concurrent multi-agent writes.
 */
export function updateStateWithVersion(
  container: Readonly<StateContainer>,
  expectedVersion: number,
  update: Readonly<StateUpdate>
): StateContainer {
  if (container.current.version !== expectedVersion) {
    throw new VersionConflictError(expectedVersion, container.current.version);
  }
  return updateState(container, update);
}

// ---------------------------------------------------------------------------
// Snapshot & restore
// ---------------------------------------------------------------------------

/**
 * Creates a serializable snapshot of the full state container.
 * Returns a deep-frozen plain object safe for JSON serialization.
 */
export function snapshot(container: Readonly<StateContainer>): string {
  return JSON.stringify(container);
}

/**
 * Restores a StateContainer from a JSON snapshot string.
 * Validates with Zod so corrupted snapshots are caught early.
 */
export function restore(json: string): StateContainer {
  const raw: unknown = JSON.parse(json);
  return StateContainer.parse(raw);
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

/**
 * Creates a fresh StateContainer for a new agent in the `idle` phase.
 */
export function createInitialState(
  stateId: string,
  agentId: string,
  createdBy: string
): StateContainer {
  return {
    current: {
      stateId,
      agentId,
      version: 0,
      phase: "idle",
      data: {},
      lastUpdatedBy: createdBy,
      updatedAt: new Date().toISOString(),
      tags: [],
    },
    history: [],
  };
}
