/**
 * Supervisor-Worker Pattern
 *
 * A supervisor agent delegates typed tasks to specialized worker agents,
 * monitors their health, and collects validated results. Workers are
 * selected dynamically based on task type. All state transitions are
 * immutable.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Task & result schemas
// ---------------------------------------------------------------------------

export const TaskType = z.enum([
  "research",
  "analysis",
  "generation",
  "validation",
  "summarization",
]);

export type TaskType = z.infer<typeof TaskType>;

export const WorkerTask = z.object({
  taskId: z.string().uuid(),
  type: TaskType,
  payload: z.unknown(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  createdAt: z.string().datetime(),
  timeoutMs: z.number().int().positive().default(30_000),
});

export type WorkerTask = z.infer<typeof WorkerTask>;

export const WorkerResult = z.object({
  taskId: z.string().uuid(),
  workerId: z.string().min(1),
  status: z.enum(["success", "failure"]),
  data: z.unknown().optional(),
  error: z.string().optional(),
  durationMs: z.number().nonneg(),
  completedAt: z.string().datetime(),
});

export type WorkerResult = z.infer<typeof WorkerResult>;

// ---------------------------------------------------------------------------
// Worker interface
// ---------------------------------------------------------------------------

export interface Worker {
  readonly id: string;
  readonly capabilities: ReadonlyArray<TaskType>;
  readonly maxConcurrency: number;
  execute(task: WorkerTask): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Worker health tracking (immutable)
// ---------------------------------------------------------------------------

export interface WorkerHealth {
  readonly workerId: string;
  readonly activeTasks: number;
  readonly completedTasks: number;
  readonly failedTasks: number;
  readonly lastHeartbeat: number;
  readonly status: "healthy" | "degraded" | "offline";
}

function initialHealth(workerId: string): WorkerHealth {
  return {
    workerId,
    activeTasks: 0,
    completedTasks: 0,
    failedTasks: 0,
    lastHeartbeat: Date.now(),
    status: "healthy",
  };
}

function withTaskStarted(health: WorkerHealth): WorkerHealth {
  return { ...health, activeTasks: health.activeTasks + 1, lastHeartbeat: Date.now() };
}

function withTaskCompleted(health: WorkerHealth): WorkerHealth {
  return {
    ...health,
    activeTasks: Math.max(0, health.activeTasks - 1),
    completedTasks: health.completedTasks + 1,
    lastHeartbeat: Date.now(),
  };
}

function withTaskFailed(health: WorkerHealth): WorkerHealth {
  const failed = health.failedTasks + 1;
  return {
    ...health,
    activeTasks: Math.max(0, health.activeTasks - 1),
    failedTasks: failed,
    lastHeartbeat: Date.now(),
    status: failed > 5 ? "degraded" : health.status,
  };
}

// ---------------------------------------------------------------------------
// Task queue (immutable operations)
// ---------------------------------------------------------------------------

export interface TaskQueue {
  readonly pending: ReadonlyArray<WorkerTask>;
  readonly inProgress: ReadonlyMap<string, WorkerTask>;
}

function emptyQueue(): TaskQueue {
  return { pending: [], inProgress: new Map() };
}

function enqueue(queue: TaskQueue, task: WorkerTask): TaskQueue {
  const sorted = [...queue.pending, task].sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    return priorityOrder[a.priority] - priorityOrder[b.priority];
  });
  return { ...queue, pending: sorted };
}

function dequeue(queue: TaskQueue): { task: WorkerTask | undefined; queue: TaskQueue } {
  if (queue.pending.length === 0) return { task: undefined, queue };
  const [task, ...rest] = queue.pending;
  return {
    task,
    queue: {
      pending: rest,
      inProgress: new Map([...queue.inProgress, [task.taskId, task]]),
    },
  };
}

function completeTask(queue: TaskQueue, taskId: string): TaskQueue {
  const next = new Map(queue.inProgress);
  next.delete(taskId);
  return { ...queue, inProgress: next };
}

// ---------------------------------------------------------------------------
// Worker selection
// ---------------------------------------------------------------------------

/**
 * Select the best worker for a task based on capability and availability.
 * Returns undefined when no suitable worker is available.
 */
export function selectWorker(
  workers: ReadonlyArray<Worker>,
  healthMap: ReadonlyMap<string, WorkerHealth>,
  taskType: TaskType
): Worker | undefined {
  const capable = workers.filter((w) => w.capabilities.includes(taskType));

  const available = capable.filter((w) => {
    const health = healthMap.get(w.id);
    if (!health || health.status === "offline") return false;
    return health.activeTasks < w.maxConcurrency;
  });

  if (available.length === 0) return undefined;

  // Prefer healthiest worker (fewest active tasks, then fewest failures)
  return [...available].sort((a, b) => {
    const ha = healthMap.get(a.id) ?? initialHealth(a.id);
    const hb = healthMap.get(b.id) ?? initialHealth(b.id);
    if (ha.activeTasks !== hb.activeTasks) return ha.activeTasks - hb.activeTasks;
    return ha.failedTasks - hb.failedTasks;
  })[0];
}

// ---------------------------------------------------------------------------
// Supervisor
// ---------------------------------------------------------------------------

export interface SupervisorState {
  readonly queue: TaskQueue;
  readonly healthMap: ReadonlyMap<string, WorkerHealth>;
  readonly results: ReadonlyArray<WorkerResult>;
}

export interface Supervisor {
  readonly state: SupervisorState;
  submit(task: WorkerTask): Supervisor;
  processNext(workers: ReadonlyArray<Worker>): Promise<Supervisor>;
  getResults(): ReadonlyArray<WorkerResult>;
}

/**
 * Create a new supervisor. All operations return a NEW supervisor
 * with updated state – the original is never mutated.
 */
export function createSupervisor(
  workers: ReadonlyArray<Worker>
): Supervisor {
  const healthMap = new Map(workers.map((w) => [w.id, initialHealth(w.id)]));
  return buildSupervisor({
    queue: emptyQueue(),
    healthMap,
    results: [],
  });
}

function buildSupervisor(state: SupervisorState): Supervisor {
  return {
    state,

    submit(task: WorkerTask): Supervisor {
      return buildSupervisor({
        ...state,
        queue: enqueue(state.queue, task),
      });
    },

    async processNext(workers: ReadonlyArray<Worker>): Promise<Supervisor> {
      const { task, queue: nextQueue } = dequeue(state.queue);
      if (!task) return buildSupervisor(state);

      const worker = selectWorker(workers, state.healthMap, task.type);
      if (!worker) {
        // No available worker – put task back
        return buildSupervisor({ ...state, queue: enqueue(nextQueue, task) });
      }

      const health = state.healthMap.get(worker.id) ?? initialHealth(worker.id);
      const updatedHealth = new Map(state.healthMap);
      updatedHealth.set(worker.id, withTaskStarted(health));

      const result = await executeWorkerTask(worker, task);

      const finalHealth = new Map(updatedHealth);
      const currentHealth = finalHealth.get(worker.id) ?? initialHealth(worker.id);
      finalHealth.set(
        worker.id,
        result.status === "success"
          ? withTaskCompleted(currentHealth)
          : withTaskFailed(currentHealth)
      );

      return buildSupervisor({
        queue: completeTask(nextQueue, task.taskId),
        healthMap: finalHealth,
        results: [...state.results, result],
      });
    },

    getResults(): ReadonlyArray<WorkerResult> {
      return state.results;
    },
  };
}

async function executeWorkerTask(
  worker: Worker,
  task: WorkerTask
): Promise<WorkerResult> {
  const start = Date.now();
  try {
    const data = await worker.execute(task);
    return WorkerResult.parse({
      taskId: task.taskId,
      workerId: worker.id,
      status: "success",
      data,
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    return WorkerResult.parse({
      taskId: task.taskId,
      workerId: worker.id,
      status: "failure",
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
      completedAt: new Date().toISOString(),
    });
  }
}

// ---------------------------------------------------------------------------
// Example: supervisor routing tasks to specialized workers
// ---------------------------------------------------------------------------

export function exampleWorkers(): ReadonlyArray<Worker> {
  return [
    {
      id: "researcher-1",
      capabilities: ["research", "summarization"],
      maxConcurrency: 3,
      execute: async (task) => ({ findings: [], query: task.payload }),
    },
    {
      id: "analyst-1",
      capabilities: ["analysis", "validation"],
      maxConcurrency: 2,
      execute: async (task) => ({ score: 0.85, analysis: "positive" }),
    },
    {
      id: "writer-1",
      capabilities: ["generation", "summarization"],
      maxConcurrency: 1,
      execute: async (task) => ({ content: "Generated text.", wordCount: 2 }),
    },
  ];
}
