# State Management for Multi-Agent Systems

## Why Shared Mutable State Breaks Multi-Agent Systems

When multiple agents read and write the same mutable state, you get the
same problems as multithreaded programming: race conditions, lost updates,
inconsistent reads, and non-deterministic behavior. LLM agents make this
worse because their execution is non-deterministic and their timing is
unpredictable.

```typescript
// THE PROBLEM: shared mutable state
const state = {
  tasks: [{ id: "1", status: "pending" }],
  completedCount: 0,
};

// Agent A reads state, works for 5 seconds, then writes
async function agentA() {
  const task = state.tasks[0]; // reads { status: "pending" }
  // ... works for 5 seconds ...
  task.status = "completed";   // mutates in place
  state.completedCount += 1;   // race condition
}

// Agent B reads state simultaneously
async function agentB() {
  const task = state.tasks[0]; // reads { status: "pending" } (stale!)
  // ... makes decisions based on stale data ...
  task.status = "failed";      // overwrites Agent A's "completed"
  state.completedCount += 1;   // race condition on counter
}

// Both run concurrently:
// Final state is unpredictable. Could be "completed" or "failed".
// completedCount could be 1 or 2, regardless of actual completions.
```

## Immutable State Patterns

Immutable state eliminates race conditions by making all updates produce
new state objects. No in-place mutation means no conflicting writes.

```typescript
import { z } from "zod";

// Immutable state schema
const WorkflowStateSchema = z.object({
  version: z.number().int().nonnegative(),
  workflowId: z.string().uuid(),
  status: z.enum(["running", "paused", "completed", "failed"]),
  tasks: z.record(
    z.string(),
    z.object({
      status: z.enum(["pending", "running", "completed", "failed"]),
      assignedTo: z.string().optional(),
      result: z.unknown().optional(),
      attempts: z.number().int().nonnegative(),
    })
  ),
  context: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime(),
});

type WorkflowState = z.infer<typeof WorkflowStateSchema>;

// All updates return new state — never mutate the original
function updateTaskStatus(
  state: WorkflowState,
  taskId: string,
  newStatus: "pending" | "running" | "completed" | "failed",
  result?: unknown,
): WorkflowState {
  const existingTask = state.tasks[taskId];
  if (!existingTask) {
    throw new Error(`Task ${taskId} not found in state`);
  }

  return {
    ...state,
    version: state.version + 1,
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...existingTask,
        status: newStatus,
        result: result ?? existingTask.result,
        attempts: newStatus === "running"
          ? existingTask.attempts + 1
          : existingTask.attempts,
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function addTask(
  state: WorkflowState,
  taskId: string,
  assignedTo?: string,
): WorkflowState {
  return {
    ...state,
    version: state.version + 1,
    tasks: {
      ...state.tasks,
      [taskId]: {
        status: "pending",
        assignedTo,
        attempts: 0,
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function updateContext(
  state: WorkflowState,
  key: string,
  value: unknown,
): WorkflowState {
  return {
    ...state,
    version: state.version + 1,
    context: {
      ...state.context,
      [key]: value,
    },
    updatedAt: new Date().toISOString(),
  };
}
```

### Immutable State Store

```typescript
class ImmutableStateStore {
  private history: WorkflowState[] = [];

  constructor(initialState: WorkflowState) {
    this.history = [WorkflowStateSchema.parse(initialState)];
  }

  get current(): WorkflowState {
    return this.history[this.history.length - 1];
  }

  get version(): number {
    return this.current.version;
  }

  // Apply an update function that returns new state
  update(
    updater: (current: WorkflowState) => WorkflowState,
  ): WorkflowState {
    const newState = updater(this.current);

    // Validate the new state
    const validated = WorkflowStateSchema.parse(newState);

    // Ensure version was incremented
    if (validated.version <= this.current.version) {
      throw new Error(
        `State version must increase. Current: ${this.current.version}, ` +
        `got: ${validated.version}`,
      );
    }

    this.history = [...this.history, validated];
    return validated;
  }

  // Optimistic concurrency: only apply if version matches
  updateIfVersion(
    expectedVersion: number,
    updater: (current: WorkflowState) => WorkflowState,
  ): { success: boolean; state: WorkflowState } {
    if (this.current.version !== expectedVersion) {
      return { success: false, state: this.current };
    }
    return { success: true, state: this.update(updater) };
  }

  // Get state at a specific version
  getVersion(version: number): WorkflowState | undefined {
    return this.history.find((s) => s.version === version);
  }

  // Get full history
  getHistory(): ReadonlyArray<WorkflowState> {
    return this.history;
  }

  // Rollback to a previous version
  rollbackTo(version: number): WorkflowState {
    const targetState = this.getVersion(version);
    if (!targetState) {
      throw new Error(`Version ${version} not found`);
    }
    const rolledBack: WorkflowState = {
      ...targetState,
      version: this.current.version + 1,
      updatedAt: new Date().toISOString(),
    };
    this.history = [...this.history, WorkflowStateSchema.parse(rolledBack)];
    return rolledBack;
  }
}
```

## Event Sourcing for Agent Actions

Instead of storing current state, store the sequence of events that
produced it. The current state is derived by replaying events.

```typescript
import { z } from "zod";

// Event schemas using discriminated union
const WorkflowEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow_started"),
    workflowId: z.string().uuid(),
    input: z.unknown(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("task_created"),
    workflowId: z.string().uuid(),
    taskId: z.string().uuid(),
    taskType: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("task_assigned"),
    workflowId: z.string().uuid(),
    taskId: z.string().uuid(),
    agentId: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("task_completed"),
    workflowId: z.string().uuid(),
    taskId: z.string().uuid(),
    result: z.unknown(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("task_failed"),
    workflowId: z.string().uuid(),
    taskId: z.string().uuid(),
    error: z.string(),
    retryable: z.boolean(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("context_updated"),
    workflowId: z.string().uuid(),
    key: z.string(),
    value: z.unknown(),
    updatedBy: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("workflow_completed"),
    workflowId: z.string().uuid(),
    finalResult: z.unknown(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("workflow_failed"),
    workflowId: z.string().uuid(),
    reason: z.string(),
    timestamp: z.string().datetime(),
  }),
]);

type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;

// Event store
class EventStore {
  private events: WorkflowEvent[] = [];

  append(event: WorkflowEvent): void {
    const validated = WorkflowEventSchema.parse(event);
    this.events = [...this.events, validated];
  }

  getEvents(workflowId: string): ReadonlyArray<WorkflowEvent> {
    return this.events.filter((e) => e.workflowId === workflowId);
  }

  getAllEvents(): ReadonlyArray<WorkflowEvent> {
    return this.events;
  }
}

// Derive current state from events
function deriveState(events: ReadonlyArray<WorkflowEvent>): WorkflowState {
  const initial: WorkflowState = {
    version: 0,
    workflowId: "",
    status: "running",
    tasks: {},
    context: {},
    updatedAt: new Date().toISOString(),
  };

  return events.reduce<WorkflowState>((state, event) => {
    switch (event.type) {
      case "workflow_started":
        return {
          ...state,
          version: state.version + 1,
          workflowId: event.workflowId,
          status: "running",
          updatedAt: event.timestamp,
        };

      case "task_created":
        return {
          ...state,
          version: state.version + 1,
          tasks: {
            ...state.tasks,
            [event.taskId]: {
              status: "pending",
              attempts: 0,
            },
          },
          updatedAt: event.timestamp,
        };

      case "task_assigned":
        return {
          ...state,
          version: state.version + 1,
          tasks: {
            ...state.tasks,
            [event.taskId]: {
              ...state.tasks[event.taskId],
              status: "running",
              assignedTo: event.agentId,
              attempts: (state.tasks[event.taskId]?.attempts ?? 0) + 1,
            },
          },
          updatedAt: event.timestamp,
        };

      case "task_completed":
        return {
          ...state,
          version: state.version + 1,
          tasks: {
            ...state.tasks,
            [event.taskId]: {
              ...state.tasks[event.taskId],
              status: "completed",
              result: event.result,
            },
          },
          updatedAt: event.timestamp,
        };

      case "task_failed":
        return {
          ...state,
          version: state.version + 1,
          tasks: {
            ...state.tasks,
            [event.taskId]: {
              ...state.tasks[event.taskId],
              status: "failed",
              result: event.error,
            },
          },
          updatedAt: event.timestamp,
        };

      case "context_updated":
        return {
          ...state,
          version: state.version + 1,
          context: {
            ...state.context,
            [event.key]: event.value,
          },
          updatedAt: event.timestamp,
        };

      case "workflow_completed":
        return {
          ...state,
          version: state.version + 1,
          status: "completed",
          updatedAt: event.timestamp,
        };

      case "workflow_failed":
        return {
          ...state,
          version: state.version + 1,
          status: "failed",
          updatedAt: event.timestamp,
        };

      default: {
        const _exhaustive: never = event;
        return state;
      }
    }
  }, initial);
}
```

## State Versioning and Conflict Resolution

### Optimistic Concurrency Control

```typescript
// Agents read state with a version number. When they write, they
// include the version they read. If the version has changed, the
// write is rejected and the agent must re-read and retry.

interface StateUpdate {
  agentId: string;
  expectedVersion: number;
  updater: (state: WorkflowState) => WorkflowState;
}

class ConcurrentStateStore {
  private store: ImmutableStateStore;
  private pendingUpdates: StateUpdate[] = [];

  constructor(initialState: WorkflowState) {
    this.store = new ImmutableStateStore(initialState);
  }

  read(): { state: WorkflowState; version: number } {
    return {
      state: this.store.current,
      version: this.store.version,
    };
  }

  write(update: StateUpdate): {
    success: boolean;
    state: WorkflowState;
    conflictReason?: string;
  } {
    const result = this.store.updateIfVersion(
      update.expectedVersion,
      update.updater,
    );

    if (!result.success) {
      return {
        success: false,
        state: result.state,
        conflictReason:
          `Version conflict: expected ${update.expectedVersion}, ` +
          `current is ${result.state.version}`,
      };
    }

    return { success: true, state: result.state };
  }

  // Retry loop for agents
  async writeWithRetry(
    agentId: string,
    updater: (state: WorkflowState) => WorkflowState,
    maxRetries: number = 3,
  ): Promise<WorkflowState> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { state, version } = this.read();
      const result = this.write({
        agentId,
        expectedVersion: version,
        updater,
      });

      if (result.success) {
        return result.state;
      }

      // Back off before retrying
      await new Promise((resolve) =>
        setTimeout(resolve, Math.pow(2, attempt) * 100)
      );
    }

    throw new Error(
      `Agent "${agentId}" failed to write state after ${maxRetries} retries`,
    );
  }
}
```

## Agent-Local vs Shared State

### Agent-Local State

Each agent maintains private state that is not shared. This is safe because
only one agent reads and writes it.

```typescript
const AgentLocalStateSchema = z.object({
  agentId: z.string(),
  // Scratchpad for intermediate work
  scratchpad: z.record(z.string(), z.unknown()),
  // History of this agent's actions
  actionHistory: z.array(z.object({
    action: z.string(),
    timestamp: z.string().datetime(),
    result: z.unknown(),
  })),
  // Configuration specific to this agent
  config: z.object({
    maxRetries: z.number().int().nonnegative(),
    timeoutMs: z.number().int().positive(),
    model: z.string(),
  }),
  // Performance metrics
  metrics: z.object({
    tasksProcessed: z.number().int().nonnegative(),
    totalTokensUsed: z.number().int().nonnegative(),
    averageLatencyMs: z.number().nonnegative(),
  }),
});

type AgentLocalState = z.infer<typeof AgentLocalStateSchema>;

// Agent-local state manager
class AgentStateManager {
  private state: AgentLocalState;

  constructor(agentId: string, config: AgentLocalState["config"]) {
    this.state = {
      agentId,
      scratchpad: {},
      actionHistory: [],
      config,
      metrics: {
        tasksProcessed: 0,
        totalTokensUsed: 0,
        averageLatencyMs: 0,
      },
    };
  }

  get current(): Readonly<AgentLocalState> {
    return this.state;
  }

  recordAction(action: string, result: unknown): void {
    this.state = {
      ...this.state,
      actionHistory: [
        ...this.state.actionHistory,
        {
          action,
          timestamp: new Date().toISOString(),
          result,
        },
      ],
    };
  }

  updateScratchpad(key: string, value: unknown): void {
    this.state = {
      ...this.state,
      scratchpad: {
        ...this.state.scratchpad,
        [key]: value,
      },
    };
  }

  updateMetrics(tokensUsed: number, latencyMs: number): void {
    const prev = this.state.metrics;
    const newCount = prev.tasksProcessed + 1;
    this.state = {
      ...this.state,
      metrics: {
        tasksProcessed: newCount,
        totalTokensUsed: prev.totalTokensUsed + tokensUsed,
        averageLatencyMs:
          (prev.averageLatencyMs * prev.tasksProcessed + latencyMs) / newCount,
      },
    };
  }
}
```

### Shared State: Only Through Validated Channels

```typescript
// Shared state should only be updated through a central store
// with validation and versioning. Agents never modify shared state
// directly — they submit update requests.

const StateUpdateRequestSchema = z.object({
  requestId: z.string().uuid(),
  agentId: z.string(),
  operation: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("update_task"),
      taskId: z.string(),
      newStatus: z.enum(["pending", "running", "completed", "failed"]),
      result: z.unknown().optional(),
    }),
    z.object({
      type: z.literal("set_context"),
      key: z.string(),
      value: z.unknown(),
    }),
    z.object({
      type: z.literal("add_task"),
      taskId: z.string(),
      assignTo: z.string().optional(),
    }),
  ]),
  expectedVersion: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});

type StateUpdateRequest = z.infer<typeof StateUpdateRequestSchema>;
```

## State Snapshots and Recovery

```typescript
// Snapshot manager for checkpoint and recovery
class SnapshotManager {
  private snapshots: Map<string, {
    state: WorkflowState;
    events: WorkflowEvent[];
    takenAt: string;
    label: string;
  }> = new Map();

  takeSnapshot(
    label: string,
    state: WorkflowState,
    events: ReadonlyArray<WorkflowEvent>,
  ): string {
    const snapshotId = crypto.randomUUID();
    this.snapshots.set(snapshotId, {
      state: WorkflowStateSchema.parse(state),
      events: [...events],
      takenAt: new Date().toISOString(),
      label,
    });
    return snapshotId;
  }

  restore(snapshotId: string): {
    state: WorkflowState;
    events: WorkflowEvent[];
  } {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      throw new Error(`Snapshot ${snapshotId} not found`);
    }
    return {
      state: snapshot.state,
      events: [...snapshot.events],
    };
  }

  listSnapshots(): Array<{
    id: string;
    label: string;
    takenAt: string;
    version: number;
  }> {
    return Array.from(this.snapshots.entries()).map(([id, snap]) => ({
      id,
      label: snap.label,
      takenAt: snap.takenAt,
      version: snap.state.version,
    }));
  }
}

// Usage in a workflow
// const snapshots = new SnapshotManager();
//
// Before a risky operation:
// const snapshotId = snapshots.takeSnapshot(
//   "before-payment-processing",
//   store.current,
//   eventStore.getAllEvents(),
// );
//
// If the operation fails:
// const { state, events } = snapshots.restore(snapshotId);
// // Rebuild from snapshot
```

## State Machine Pattern

For workflows with well-defined states and transitions, use an explicit
state machine.

```typescript
import { z } from "zod";

type WorkflowStatus =
  | "initialized"
  | "researching"
  | "analyzing"
  | "reviewing"
  | "completed"
  | "failed";

// Define valid transitions
const VALID_TRANSITIONS: Record<WorkflowStatus, WorkflowStatus[]> = {
  initialized: ["researching"],
  researching: ["analyzing", "failed"],
  analyzing: ["reviewing", "failed"],
  reviewing: ["completed", "analyzing", "failed"], // can loop back
  completed: [],
  failed: ["initialized"], // can restart
};

function isValidTransition(
  from: WorkflowStatus,
  to: WorkflowStatus,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

const TransitionRequestSchema = z.object({
  workflowId: z.string().uuid(),
  fromStatus: z.enum([
    "initialized", "researching", "analyzing",
    "reviewing", "completed", "failed",
  ]),
  toStatus: z.enum([
    "initialized", "researching", "analyzing",
    "reviewing", "completed", "failed",
  ]),
  triggeredBy: z.string(),
  reason: z.string(),
  timestamp: z.string().datetime(),
});

type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

class WorkflowStateMachine {
  private currentStatus: WorkflowStatus;
  private transitionHistory: TransitionRequest[] = [];

  constructor(initialStatus: WorkflowStatus = "initialized") {
    this.currentStatus = initialStatus;
  }

  get status(): WorkflowStatus {
    return this.currentStatus;
  }

  get history(): ReadonlyArray<TransitionRequest> {
    return this.transitionHistory;
  }

  transition(request: TransitionRequest): {
    success: boolean;
    error?: string;
  } {
    const validated = TransitionRequestSchema.parse(request);

    if (validated.fromStatus !== this.currentStatus) {
      return {
        success: false,
        error:
          `Expected current status "${validated.fromStatus}", ` +
          `but actual is "${this.currentStatus}"`,
      };
    }

    if (!isValidTransition(validated.fromStatus, validated.toStatus)) {
      return {
        success: false,
        error:
          `Invalid transition: "${validated.fromStatus}" → "${validated.toStatus}". ` +
          `Valid targets: ${VALID_TRANSITIONS[validated.fromStatus].join(", ")}`,
      };
    }

    this.currentStatus = validated.toStatus;
    this.transitionHistory = [...this.transitionHistory, validated];

    return { success: true };
  }

  getValidTransitions(): WorkflowStatus[] {
    return VALID_TRANSITIONS[this.currentStatus] ?? [];
  }
}
```

## Summary

State management in multi-agent systems requires discipline:

1. **Never use shared mutable state** — all updates produce new state objects
2. **Version all state** — optimistic concurrency prevents conflicts
3. **Event sourcing** — store events, derive state, enable replay
4. **Separate local from shared** — agents own their scratchpad, share through validated channels
5. **Snapshot and recover** — checkpoint before risky operations
6. **State machines** — enforce valid transitions for workflow status

The golden rule: if two agents can access the same state, that state must
be immutable, versioned, and validated.
