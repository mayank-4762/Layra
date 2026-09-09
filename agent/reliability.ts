import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type { AgentState, TaskStatus } from './state';
import type { HybridAgent } from './agent';

export interface Phase6ReliabilityOptions {
  checkpointPath?: string;
  intervalMs?: number;
  maxRuntimeMs?: number;
  maxTotalActions?: number;
  maxConsecutiveFailures?: number;
  maxTaskAgeMs?: number;
}

export interface Phase6Checkpoint {
  schemaVersion: 1;
  savedAt: string;
  stateId: string;
  goal: string | null;
  plan: Array<{ id: string; status: string; description: string; tool: string }>;
  metrics: {
    totalActions: number;
    successRate: number;
    completedTasks: number;
    failedTasks: number;
    consecutiveFailures: number;
  };
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function safeJson(value: unknown, fallback: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return fallback;
  }
}

/**
 * Phase 6 reliability control plane for the single Layra runtime.
 * It adds durable checkpoints, bounded resource execution, stuck-task detection,
 * and outcome scoring without spawning or delegating to another agent.
 */
export class Phase6ReliabilitySupervisor {
  private readonly checkpointPath: string;
  private readonly intervalMs: number;
  private readonly maxRuntimeMs: number;
  private readonly maxTotalActions: number;
  private readonly maxConsecutiveFailures: number;
  private readonly maxTaskAgeMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private stoppedForBudget = false;
  private lastScoredCompleted = 0;
  private lastScoredFailed = 0;

  constructor(private readonly agent: HybridAgent, options: Phase6ReliabilityOptions = {}) {
    const defaultStateDir = path.resolve(process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state'));
    this.checkpointPath = path.resolve(options.checkpointPath || path.join(defaultStateDir, 'phase6-checkpoint.json'));
    this.intervalMs = positiveInt(options.intervalMs ?? Number(process.env.LAYRA_RELIABILITY_INTERVAL_MS), 1000);
    this.maxRuntimeMs = positiveInt(options.maxRuntimeMs ?? Number(process.env.LAYRA_MAX_RUNTIME_MS), 0) || Number.POSITIVE_INFINITY;
    this.maxTotalActions = positiveInt(options.maxTotalActions ?? Number(process.env.LAYRA_MAX_TOTAL_ACTIONS), 0) || Number.POSITIVE_INFINITY;
    this.maxConsecutiveFailures = positiveInt(options.maxConsecutiveFailures ?? Number(process.env.LAYRA_MAX_CONSECUTIVE_FAILURES), 0) || 0;
    this.maxTaskAgeMs = positiveInt(options.maxTaskAgeMs ?? Number(process.env.LAYRA_MAX_TASK_AGE_MS), 0) || Number.POSITIVE_INFINITY;
  }

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    const state = this.agent.getState();
    this.lastScoredCompleted = state.completedTasks.length;
    this.lastScoredFailed = state.failedTasks.length;
    this.persist(state);
    this.timer = setInterval(() => {
      void this.monitor();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(reason = 'supervisor_stop'): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const state = this.agent.getState();
    this.scoreOutcomes(state);
    state.shortTermMemory = {
      ...(state.shortTermMemory || {}),
      phase6Supervisor: { reason, stoppedForBudget: this.stoppedForBudget, stoppedAt: new Date().toISOString() }
    };
    this.persist(state);
  }

  isRunning(): boolean { return this.timer !== null; }
  wasStoppedForBudget(): boolean { return this.stoppedForBudget; }

  loadCheckpoint(): Phase6Checkpoint | null {
    if (!existsSync(this.checkpointPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.checkpointPath, 'utf8')) as Phase6Checkpoint;
      if (parsed?.schemaVersion !== 1 || typeof parsed?.savedAt !== 'string' || typeof parsed?.stateId !== 'string') return null;
      if (!parsed.metrics || !Array.isArray(parsed.plan)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  getCheckpointPath(): string { return this.checkpointPath; }

  private async monitor(): Promise<void> {
    const state = this.agent.getState();
    this.scoreOutcomes(state);
    this.persist(state);

    if (Date.now() - this.startedAt >= this.maxRuntimeMs) {
      this.tripBudget(state, `Maximum runtime ${this.maxRuntimeMs}ms reached`);
      return;
    }
    if (state.totalActions >= this.maxTotalActions) {
      this.tripBudget(state, `Maximum total actions ${this.maxTotalActions} reached`);
      return;
    }
    const consecutiveFailures = this.getConsecutiveFailures(state);
    if (this.maxConsecutiveFailures > 0 && consecutiveFailures >= this.maxConsecutiveFailures) {
      this.tripBudget(state, `Maximum consecutive failures ${this.maxConsecutiveFailures} reached`);
      return;
    }
    if (this.hasStuckTask(state)) {
      this.tripBudget(state, `Task exceeded maximum age ${this.maxTaskAgeMs}ms`);
    }
  }

  private tripBudget(state: AgentState, reason: string): void {
    this.stoppedForBudget = true;
    state.shortTermMemory = { ...(state.shortTermMemory || {}), phase6StopReason: reason };
    this.persist(state);
    this.agent.stop();
  }

  private hasStuckTask(state: AgentState): boolean {
    if (!Number.isFinite(this.maxTaskAgeMs)) return false;
    const now = Date.now();
    return state.activeTasks.some(task => task.status === ('in_progress' as TaskStatus) && task.startedAt instanceof Date && now - task.startedAt.getTime() >= this.maxTaskAgeMs);
  }

  private getConsecutiveFailures(state: AgentState): number {
    let count = 0;
    for (let i = state.failedTasks.length - 1; i >= 0; i -= 1) {
      if (state.failedTasks[i]?.status !== ('failed' as TaskStatus)) break;
      count += 1;
    }
    return count;
  }

  private scoreOutcomes(state: AgentState): void {
    const completedDelta = state.completedTasks.length - this.lastScoredCompleted;
    const failedDelta = state.failedTasks.length - this.lastScoredFailed;
    if (completedDelta === 0 && failedDelta === 0) return;
    const completed = state.completedTasks.slice(this.lastScoredCompleted).map(task => ({ id: task.id, description: task.description, tool: task.assignedTo }));
    const failed = state.failedTasks.slice(this.lastScoredFailed).map(task => ({ id: task.id, description: task.description, tool: task.assignedTo, error: task.error }));
    const existing = Array.isArray(state.shortTermMemory?.phase6OutcomeScores) ? state.shortTermMemory.phase6OutcomeScores : [];
    const entry = {
      timestamp: new Date().toISOString(),
      goal: state.currentGoal,
      completed,
      failed,
      score: completedDelta / Math.max(1, completedDelta + failedDelta)
    };
    state.shortTermMemory = {
      ...(state.shortTermMemory || {}),
      phase6OutcomeScores: [...existing, safeJson(entry, { timestamp: entry.timestamp, score: entry.score })].slice(-50)
    };
    this.lastScoredCompleted = state.completedTasks.length;
    this.lastScoredFailed = state.failedTasks.length;
  }

  private persist(state: AgentState): void {
    const checkpoint: Phase6Checkpoint = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      stateId: state.id,
      goal: state.currentGoal,
      plan: state.currentPlan.map(step => ({ id: step.id, status: step.status, description: step.description, tool: step.tool })),
      metrics: {
        totalActions: state.totalActions,
        successRate: state.successRate,
        completedTasks: state.completedTasks.length,
        failedTasks: state.failedTasks.length,
        consecutiveFailures: this.getConsecutiveFailures(state)
      }
    };
    const dir = path.dirname(this.checkpointPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.checkpointPath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(checkpoint, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.checkpointPath);
  }
}
