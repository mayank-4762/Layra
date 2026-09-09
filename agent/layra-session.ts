import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { ActionResult, AgentState, Reflection, Task } from './state';

function asDate(value: unknown, fallback = new Date()): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function normalizeAction(value: any): ActionResult {
  return {
    actionId: String(value?.actionId || `action_${Date.now()}`),
    stepId: value?.stepId ? String(value.stepId) : null,
    tool: String(value?.tool || 'unknown'),
    success: Boolean(value?.success),
    result: value?.result ?? null,
    error: value?.error ? String(value.error) : null,
    executionTime: Number(value?.executionTime || 0),
    timestamp: asDate(value?.timestamp),
    metadata: value?.metadata && typeof value.metadata === 'object' ? value.metadata : {}
  };
}

export class LayraSessionStore {
  readonly sessionDir: string;
  readonly memoryDir: string;
  readonly maxTasksPerRun: number;
  private readonly sessionPath: string;
  private readonly eventPath: string;
  private readonly statusPath: string;
  private readonly reportPath: string;
  private sessionId = '';
  private runNumber = 1;

  constructor(options: { sessionDir?: string; memoryDir?: string; maxTasksPerRun?: number } = {}) {
    this.sessionDir = path.resolve(options.sessionDir || path.join(process.cwd(), '.state'));
    this.memoryDir = path.resolve(options.memoryDir || path.join(process.cwd(), 'memory'));
    this.maxTasksPerRun = options.maxTasksPerRun ?? 3;
    this.sessionPath = path.join(this.sessionDir, 'session.json');
    this.eventPath = path.join(this.sessionDir, 'events.jsonl');
    this.statusPath = path.join(this.memoryDir, 'STATUS.md');
    this.reportPath = path.join(this.memoryDir, 'REPORT.md');
    mkdirSync(this.sessionDir, { recursive: true });
    mkdirSync(this.memoryDir, { recursive: true });
  }

  async initialize(state: AgentState): Promise<void> {
    const saved = this.readJson(this.sessionPath);
    this.runNumber = Number(saved?.metadata?.runNumber || 0) + 1;
    this.sessionId = String(saved?.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);

    if (saved) {
      state.currentGoal = saved.currentGoal ?? state.currentGoal;
      state.goalHistory = Array.isArray(saved.goalHistory) ? saved.goalHistory.map(String) : state.goalHistory;
      state.goalQueue = Array.isArray(saved.goalQueue) ? saved.goalQueue.map(String) : state.goalQueue;
      state.taskQueue = Array.isArray(saved.taskQueue) ? saved.taskQueue.map(this.normalizeTask) : state.taskQueue;
      state.activeTasks = Array.isArray(saved.activeTasks) ? saved.activeTasks.map(this.normalizeTask) : [];
      state.completedTasks = Array.isArray(saved.completedTasks) ? saved.completedTasks.map(this.normalizeTask) : [];
      state.failedTasks = Array.isArray(saved.failedTasks) ? saved.failedTasks.map(this.normalizeTask) : [];
      state.workingMemory = saved.workingMemory && typeof saved.workingMemory === 'object' ? saved.workingMemory : {};
      state.shortTermMemory = saved.shortTermMemory && typeof saved.shortTermMemory === 'object' ? saved.shortTermMemory : {};
      state.longTermMemory = saved.longTermMemory && typeof saved.longTermMemory === 'object' ? saved.longTermMemory : {};
      state.currentPlan = Array.isArray(saved.currentPlan) ? saved.currentPlan : [];
      state.planningHistory = Array.isArray(saved.planningHistory) ? saved.planningHistory : [];
      state.reflections = Array.isArray(saved.reflections) ? saved.reflections.map(this.normalizeReflection) : [];
      state.lastActionResult = saved.lastActionResult ? normalizeAction(saved.lastActionResult) : null;
      state.executionHistory = Array.isArray(saved.executionHistory) ? saved.executionHistory.map(normalizeAction) : [];
      state.createdAt = asDate(saved.createdAt, state.createdAt);
      state.lastUpdated = new Date();
      state.lastActiveAt = new Date();
      this.recalculateMetrics(state);
      await this.event('session_resume', `Resumed ${this.sessionId} (run #${this.runNumber})`);
    } else {
      await this.event('session_start', `Started ${this.sessionId} (run #${this.runNumber})`);
    }

    await this.writeStatus(state);
    await this.writeReport(state);
    await this.save(state);
  }

  async save(state: AgentState): Promise<void> {
    state.lastUpdated = new Date();
    state.lastActiveAt = new Date();
    const payload = {
      ...state,
      createdAt: state.createdAt.toISOString(),
      lastUpdated: state.lastUpdated.toISOString(),
      lastActiveAt: state.lastActiveAt.toISOString(),
      metadata: { runNumber: this.runNumber, sessionId: this.sessionId, savedAt: new Date().toISOString() }
    };
    writeFileSync(this.sessionPath, JSON.stringify(payload, null, 2));
  }

  async event(eventType: string, description: string, data?: any): Promise<void> {
    if (!this.sessionId) return;
    appendFileSync(this.eventPath, JSON.stringify({ timestamp: new Date().toISOString(), eventType, description, data: data ?? null, sessionId: this.sessionId, runNumber: this.runNumber }) + '\n');
  }

  async writeStatus(state: AgentState): Promise<void> {
    const lines = [
      '# Layra Status',
      `Last updated: ${new Date().toISOString()}`,
      `Run: #${this.runNumber}`,
      `Session: ${this.sessionId || 'unknown'}`,
      '',
      '## Current Goal',
      state.currentGoal || '(none)',
      '',
      `## Plan (${state.currentPlan.length} steps)`,
      ...state.currentPlan.map(step => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.description} → ${step.tool}`),
      '',
      '## Recent Actions',
      ...state.executionHistory.slice(-5).map(action => `- ${action.success ? 'OK' : 'FAIL'} ${action.tool}: ${action.error || JSON.stringify(action.result).slice(0, 240)}`),
      '',
      '## Learning',
      ...state.reflections.slice(-5).map(reflection => `- ${reflection.type}: ${reflection.content}`)
    ];
    writeFileSync(this.statusPath, lines.join('\n'));
  }

  async writeReport(state: AgentState, note = ''): Promise<void> {
    const pending = state.currentPlan.filter(step => step.status === 'pending').length;
    const failed = state.failedTasks.length;
    const completed = state.currentPlan.length > 0 && state.currentPlan.every(step => step.status === 'completed');
    const status = completed ? 'completed' : failed > 0 ? 'recovering' : pending > 0 ? 'in_progress' : 'idle';
    const lines = [
      `# Layra Report — ${new Date().toISOString()}`,
      `## Status: ${status}`,
      '',
      '## Current Goal',
      state.currentGoal || '(none)',
      '',
      '## Completed',
      ...state.completedTasks.slice(-5).map(task => `- ${task.description}`),
      '',
      '## Failures',
      ...(state.failedTasks.length ? state.failedTasks.slice(-5).map(task => `- ${task.description}: ${task.error}`) : ['None']),
      '',
      '## Next',
      ...state.currentPlan.filter(step => step.status === 'pending').slice(0, 3).map(step => `- ${step.description}`),
      ...(note ? ['', '## Note', note] : [])
    ];
    writeFileSync(this.reportPath, lines.join('\n'));
  }

  getSessionId(): string { return this.sessionId; }
  getRunNumber(): number { return this.runNumber; }

  private recalculateMetrics(state: AgentState): void {
    state.totalActions = state.executionHistory.length;
    const successes = state.executionHistory.filter(action => action.success).length;
    state.successRate = state.totalActions ? successes / state.totalActions : 0;
    state.averageResponseTime = state.totalActions ? state.executionHistory.reduce((sum, action) => sum + action.executionTime, 0) / state.totalActions : 0;
  }

  private readJson(file: string): any | null {
    if (!existsSync(file)) return null;
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  }

  private normalizeTask(task: any): Task {
    return {
      id: String(task?.id || `task_${Date.now()}`),
      goal: String(task?.goal || ''),
      description: String(task?.description || ''),
      priority: Number(task?.priority || 1),
      status: task?.status,
      createdAt: asDate(task?.createdAt),
      startedAt: task?.startedAt ? asDate(task.startedAt) : null,
      completedAt: task?.completedAt ? asDate(task.completedAt) : null,
      assignedTo: task?.assignedTo ? String(task.assignedTo) : null,
      result: task?.result ?? null,
      error: task?.error ? String(task.error) : null,
      dependencies: Array.isArray(task?.dependencies) ? task.dependencies.map(String) : [],
      metadata: task?.metadata && typeof task.metadata === 'object' ? task.metadata : {}
    } as Task;
  }

  private normalizeReflection(reflection: any): Reflection {
    return {
      id: String(reflection?.id || `reflection_${Date.now()}`),
      type: reflection?.type,
      content: String(reflection?.content || ''),
      confidence: Number(reflection?.confidence || 0),
      source: Array.isArray(reflection?.source) ? reflection.source.map(String) : [],
      createdAt: asDate(reflection?.createdAt),
      metadata: reflection?.metadata && typeof reflection.metadata === 'object' ? reflection.metadata : {}
    } as Reflection;
  }
}
