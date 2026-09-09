import { AgentState, PlanStepStatus, Reflection, ReflectionType, Task, TaskStatus } from './state';
import { GoalTaskManager } from './goal-task-manager';
import { ToolRegistry } from '../tools/registry';
import { ToolExecutor } from '../tools/executor';
import { HermesPlanner } from './hermes-planner';
import { DHSIntelligence } from '../intelligence/dhs';
import { LayraSessionStore } from './layra-session';
import { createModelClient, getModelConfig } from '../config/model-provider';
import { MemoryStore } from '../core/memory';
import { SkillStore } from '../core/skills';
import { SelfImprovementEngine } from './self-improvement';
import { ChatMessage } from '../config/model-provider';
import { runToolLoop, ToolLoopResult } from './tool-loop';

/** Layra is one runtime: reasoning, planning, action, memory, evaluation and learning share the same state. */
export class HybridAgent {
  private readonly state: AgentState;
  private readonly goalTaskManager: GoalTaskManager;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly hermesPlanner: HermesPlanner;
  private readonly dhsIntelligence: DHSIntelligence;
  private readonly sessionStore: LayraSessionStore;
  private readonly memoryStore: MemoryStore;
  private readonly skillStore: SkillStore;
  private readonly selfImprovement: SelfImprovementEngine;
  private readonly maxTasksPerRun: number;
  private readonly maxReplansPerGoal: number;
  private running = false;
  private tasksThisRun = 0;
  private replansThisGoal = 0;

  constructor() {
    this.maxTasksPerRun = Math.max(1, Number(process.env.LAYRA_MAX_ACTIONS_PER_RUN || 3));
    this.maxReplansPerGoal = Math.max(1, Number(process.env.LAYRA_MAX_REPLANS_PER_GOAL || 8));
    this.state = this.initializeState();
    this.goalTaskManager = new GoalTaskManager(this.state);
    this.toolRegistry = new ToolRegistry(this.goalTaskManager);
    this.toolRegistry.grantBasicPermissions('system');
    this.state.availableTools = this.toolRegistry.getAvailableTools();
    this.state.toolPermissions = this.toolRegistry.getToolsWithPermissions().map(item => item.permission);
    this.toolExecutor = new ToolExecutor(this.toolRegistry, this.state);
    this.hermesPlanner = new HermesPlanner(this.state, this.toolRegistry);
    this.dhsIntelligence = new DHSIntelligence(this.state, this.toolExecutor);
    this.memoryStore = new MemoryStore();
    this.skillStore = new SkillStore();
    this.selfImprovement = new SelfImprovementEngine({ memoryStore: this.memoryStore, skillStore: this.skillStore });
    this.sessionStore = new LayraSessionStore({ maxTasksPerRun: this.maxTasksPerRun });
    this.toolRegistry.registerHook({
      after: async (tool, _parameters, result) => {
        await this.sessionStore.event('tool_completed', tool.name, { success: result.success, error: result.error });
      }
    });
  }

  private initializeState(): AgentState {
    const now = new Date();
    return {
      id: `layra_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, name: 'Layra', version: '3.0.0', currentGoal: null,
      goalHistory: [], goalQueue: [], activeTasks: [], completedTasks: [], failedTasks: [], taskQueue: [],
      workingMemory: {}, shortTermMemory: {}, longTermMemory: { lessons: [] }, currentPlan: [], planningHistory: [], reflections: [],
      lastActionResult: null, executionHistory: [], availableTools: [], toolPermissions: [], successRate: 0, averageResponseTime: 0,
      totalActions: 0, createdAt: now, lastUpdated: now, lastActiveAt: now
    };
  }

  async start(initialGoal?: string): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.memoryStore.load();
    await this.selfImprovement.load();
    try {
      const curator = await this.selfImprovement.curate();
      await this.sessionStore.event('self_improvement_curated', 'Completed learned-skill maintenance pass.', curator);
    } catch (error) {
      this.state.shortTermMemory.selfImprovementCuratorError = error instanceof Error ? error.message : String(error);
    }
    await this.sessionStore.initialize(this.state);
    const durable = await this.memoryStore.recent(100);
    this.state.longTermMemory.records = durable;
    if (initialGoal) this.setGoal(initialGoal);
    while (this.running) {
      try {
        const progressed = await this.cycle();
        await this.sessionStore.save(this.state);
        await this.sessionStore.writeReport(this.state);
        await this.sleep(progressed ? 50 : 500);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.state.shortTermMemory.lastCycleError = message;
        await this.sessionStore.event('error', message);
        await this.sessionStore.writeReport(this.state, 'Cycle error recovered; Layra will retry from persisted state.');
        await this.sleep(1000);
      }
    }
    await this.sessionStore.save(this.state);
  }

  stop(): void { this.running = false; }
  stopAgent(): void { this.stop(); }

  /** Run one conversational turn through the same tool surface used by autonomous goals. */
  async runInteractiveTurn(prompt: string, signal?: AbortSignal): Promise<ToolLoopResult> {
    const text = prompt.trim();
    if (!text) throw new Error('Prompt cannot be empty');
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are Layra, one unified autonomous agent. Use tools when evidence or action is required. Never claim a tool action succeeded unless the tool result says success.' },
      { role: 'user', content: text }
    ];
    const result = await runToolLoop(messages, this.toolRegistry, this.toolExecutor, { signal, maxRounds: Number(process.env.LAYRA_MAX_TOOL_ROUNDS || 16), maxToolCallsPerRound: Number(process.env.LAYRA_MAX_TOOL_CALLS_PER_ROUND || 8) });
    this.state.shortTermMemory.lastInteractiveTurn = { prompt: text, content: result.content, rounds: result.rounds, toolCalls: result.toolCalls, stoppedReason: result.stoppedReason, timestamp: new Date().toISOString() };
    await this.sessionStore.event('interactive_turn', result.content || result.stoppedReason, { rounds: result.rounds, toolCalls: result.toolCalls });
    return result;
  }

  setGoal(goal: string): void {
    const value = goal.trim();
    if (!value) throw new Error('Goal cannot be empty');
    if (this.state.currentGoal) this.state.goalQueue.push(value); else this.state.currentGoal = value;
    this.state.currentPlan = [];
    this.tasksThisRun = 0;
    this.replansThisGoal = 0;
    this.state.activeTasks = [];
    this.state.taskQueue = [];
  }
  getState(): AgentState { return this.state; }
  getSelfImprovementStatus() { return this.selfImprovement.getStatus(); }
  getStatistics() {
    const model = getModelConfig();
    return {
      id: this.state.id, name: this.state.name, version: this.state.version, modelProvider: model.provider, model: model.model,
      uptime: Math.floor((Date.now() - this.state.createdAt.getTime()) / 1000), totalActions: this.state.totalActions,
      successRate: this.state.successRate, averageResponseTime: this.state.averageResponseTime, completedTasks: this.state.completedTasks.length,
      failedTasks: this.state.failedTasks.length, pendingTasks: this.state.currentPlan.filter(step => step.status === PlanStepStatus.PENDING).length,
      sessionId: this.sessionStore.getSessionId(), runNumber: this.sessionStore.getRunNumber(), maxActionsPerRun: this.maxTasksPerRun,
      maxReplansPerGoal: this.maxReplansPerGoal, replansThisGoal: this.replansThisGoal,
      availableTools: this.state.availableTools.map(tool => tool.name), selfImprovement: this.selfImprovement.getStatus()
    };
  }

  private async cycle(): Promise<boolean> {
    this.state.lastActiveAt = new Date();
    await this.sessionStore.writeStatus(this.state);
    if (!this.state.currentGoal && this.state.goalQueue.length) {
      this.state.currentGoal = this.state.goalQueue.shift() || null;
      this.tasksThisRun = 0;
      this.replansThisGoal = 0;
      this.state.currentPlan = [];
    }
    if (!this.state.currentGoal) return false;
    if (this.tasksThisRun >= this.maxTasksPerRun) {
      this.tasksThisRun = 0;
      await this.sessionStore.event('action_budget_reset', `Starting another action batch for goal: ${this.state.currentGoal}`, { maxActionsPerRun: this.maxTasksPerRun });
    }
    if (!this.state.currentPlan.length) {
      if (this.replansThisGoal >= this.maxReplansPerGoal) {
        await this.sessionStore.writeReport(this.state, `Replanning limit reached for goal; preserving evidence for review: ${this.state.currentGoal}`);
        this.running = false;
        return false;
      }
      const plan = await this.hermesPlanner.plan(this.state.currentGoal, { memory: this.state.longTermMemory, recentReflections: this.state.reflections.slice(-8), recentActions: this.state.executionHistory.slice(-8) });
      this.state.currentPlan = plan.steps.map(step => ({ ...step, status: PlanStepStatus.PENDING, actualDuration: null, result: null, error: null }));
      this.state.planningHistory.push([...this.state.currentPlan]);
      this.replansThisGoal += 1;
      await this.sessionStore.event('plan_generated', `Generated ${this.state.currentPlan.length}-step plan`, { confidence: plan.confidence, reasoning: plan.reasoning, risk: this.hermesPlanner.calculatePlanRisk(plan), replanNumber: this.replansThisGoal });
      if (!this.state.currentPlan.length) { await this.requestReplan('Planner returned no executable steps'); return true; }
    }
    const ready = this.readySteps();
    if (!ready.length) {
      const unfinished = this.state.currentPlan.some(item => item.status !== PlanStepStatus.COMPLETED && item.status !== PlanStepStatus.SKIPPED);
      if (!unfinished) return this.finishGoal();
      await this.requestReplan('No executable step remains and plan is incomplete');
      return true;
    }
    const batch = this.selectBatch(ready, Math.max(1, this.maxTasksPerRun - this.tasksThisRun));
    await Promise.all(batch.map(step => this.executeStep(step)));
    for (const step of batch) await this.reason(step);
    await this.learn(batch);
    return true;
  }

  private readySteps() {
    const completed = new Set(this.state.currentPlan.filter(step => step.status === PlanStepStatus.COMPLETED).map(step => step.id));
    return this.state.currentPlan.filter(step => step.status === PlanStepStatus.PENDING && step.dependsOn.every(dep => completed.has(dep)));
  }
  private selectBatch(ready: any[], capacity: number): any[] {
    const selected: any[] = [];
    for (const step of ready.sort((a, b) => b.priority - a.priority)) {
      if (selected.length >= capacity) break;
      if (selected.every(other => this.hermesPlanner.canExecuteInParallel(step, other))) selected.push(step);
    }
    return selected.length ? selected : ready.slice(0, 1);
  }

  private async executeStep(step: any): Promise<void> {
    step.status = PlanStepStatus.IN_PROGRESS;
    const started = Date.now();
    this.state.activeTasks.push({ id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, goal: this.state.currentGoal || '', description: step.description, priority: step.priority, status: TaskStatus.IN_PROGRESS, createdAt: new Date(started), startedAt: new Date(started), completedAt: null, assignedTo: step.tool, result: null, error: null, dependencies: [...step.dependsOn], metadata: { stepId: step.id } });
    await this.sessionStore.event('task_started', step.description, { tool: step.tool, stepId: step.id });
    const result = await this.toolExecutor.executeWithTimeout(step.tool, step.parameters, Math.max(5000, step.estimatedDuration * 2000));
    step.actualDuration = Date.now() - started;
    step.result = result.result; step.error = result.error;
    step.status = result.success ? PlanStepStatus.COMPLETED : PlanStepStatus.FAILED;
    this.tasksThisRun += 1;
    const task: Task = { id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, goal: this.state.currentGoal || '', description: step.description, priority: step.priority, status: result.success ? TaskStatus.COMPLETED : TaskStatus.FAILED, createdAt: new Date(started), startedAt: new Date(started), completedAt: new Date(), assignedTo: step.tool, result: result.result, error: result.error, dependencies: [...step.dependsOn], metadata: { stepId: step.id, executor: result.metadata?.executor || 'unknown' } };
    const activeIndex = this.state.activeTasks.findIndex(item => item.status === TaskStatus.IN_PROGRESS && item.metadata?.stepId === step.id);
    if (activeIndex >= 0) this.state.activeTasks.splice(activeIndex, 1);
    if (result.success) {
      this.state.completedTasks.push(task);
      await this.sessionStore.event('task_completed', step.description, { stepId: step.id, tool: step.tool, result: this.safeEvidence(result.result) });
    } else {
      this.state.failedTasks.push(task);
      await this.sessionStore.event('task_failed', step.description, { stepId: step.id, error: result.error });
      this.state.currentPlan = [];
    }
  }

  private async reason(step: any): Promise<void> {
    const client = createModelClient();
    if (!client) return;
    try {
      const response = await client.chat([
        { role: 'system', content: 'You are Layra\'s post-action reasoning capability. Analyze evidence only. Return JSON {"shouldReplan":boolean,"reason":string,"nextAction":string,"confidence":number}. Do not declare overall goal completion.' },
        { role: 'user', content: JSON.stringify({ goal: this.state.currentGoal, step, lastAction: this.state.lastActionResult, recentActions: this.state.executionHistory.slice(-5), lessons: (this.state.longTermMemory?.lessons || []).slice(-10) }) }
      ], { temperature: 0.1, maxTokens: 450 });
      this.state.shortTermMemory.lastReasoning = response.content;
      const reflection: Reflection = { id: `reason_${Date.now()}`, type: ReflectionType.INSIGHT, content: response.content, confidence: 0.8, source: [step.id], createdAt: new Date(), metadata: { source: client.provider } };
      this.state.reflections.push(reflection);
      await this.sessionStore.event('reflection_generated', reflection.content, { source: client.provider, stepId: step.id });
      const decision = this.parseJson(response.content);
      if (decision?.shouldReplan === true) await this.requestReplan(String(decision.reason || 'Reasoning requested a replan'));
    } catch (error) {
      this.state.shortTermMemory.lastReasoningError = error instanceof Error ? error.message : String(error);
    }
  }

  private async requestReplan(reason: string): Promise<void> { this.state.currentPlan = []; await this.sessionStore.event('replan_requested', reason, { goal: this.state.currentGoal, replanNumber: this.replansThisGoal + 1 }); }

  private async learn(batch: any[]): Promise<void> {
    if (!batch.some(step => step.status === PlanStepStatus.COMPLETED)) return;
    const insights = await this.dhsIntelligence.generateInsightsFromSteps(this.state.completedTasks.slice(-10));
    for (const insight of insights) {
      this.state.reflections.push(insight as Reflection);
      const lesson = String(insight.content || '').trim();
      if (lesson) {
        this.state.longTermMemory.lessons = [...(this.state.longTermMemory.lessons || []), lesson].slice(-200);
        await this.memoryStore.remember({ kind: 'lesson', content: lesson, tags: ['dhs', 'execution'], importance: Number(insight.confidence || 0.7) * 10, source: 'DHS' });
        await this.sessionStore.event('reflection_generated', lesson, { source: 'DHS' });
      }
    }
    this.state.longTermMemory.recentEvidence = this.state.executionHistory.slice(-20);
    if (this.state.completedTasks.length >= 5 && this.state.completedTasks.length % 5 === 0) await this.captureProcedureSkill();
  }

  private async captureProcedureSkill(): Promise<void> {
    const goal = this.state.currentGoal || 'successful workflow';
    const name = `learned-${goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'workflow'}`;
    const steps = this.state.completedTasks.slice(-8).map((task: Task, i: number) => `${i + 1}. ${task.description} (tool: ${task.assignedTo || 'n/a'})`).join('\n');
    const lessons = (this.state.longTermMemory.lessons || []).slice(-5).map((item: any) => `- ${String(item)}`).join('\n');
    try {
      await this.skillStore.upsert(name, `# Procedure\n\n${steps}\n\n## Verification\nConfirm the goal-specific result from fresh evidence; do not infer success from step completion alone.\n\n# Lessons\n\n${lessons || '- No durable lesson recorded.'}`, { description: 'Reusable workflow learned by Layra.', tools: this.state.completedTasks.slice(-8).map(t => t.assignedTo || '').filter(Boolean) });
      await this.sessionStore.event('skill_learned', `Saved procedural skill ${name}`, { name });
    } catch (error) { this.state.shortTermMemory.skillLearningError = error instanceof Error ? error.message : String(error); }
  }

  private async finishGoal(): Promise<boolean> {
    const goal = this.state.currentGoal;
    if (!goal) return false;
    const evidence = this.state.currentPlan.map(step => ({ id: step.id, description: step.description, expectedOutcome: step.expectedOutcome, status: step.status, result: this.safeEvidence(step.result), error: step.error }));
    const verification = await this.dhsIntelligence.verifyGoal(goal, evidence);
    this.state.shortTermMemory.goalVerification = verification;
    const lessons = (this.state.longTermMemory.lessons || []).slice(-10).map((item: any) => typeof item === 'string' ? item : String(item?.content || '')).filter(Boolean);
    const failures = this.state.failedTasks.slice(-10).map(task => String(task.error || task.description)).filter(Boolean);
    const improvementEvidence = evidence.map(item => ({ id: item.id, type: 'goal-step', summary: `${item.description}: ${item.expectedOutcome || 'completed'}`, success: item.status === PlanStepStatus.COMPLETED && !item.error }));
    if (!verification.achieved) {
      await this.selfImprovement.observe({ goal, success: false, evidence: improvementEvidence, failures: [verification.reason, verification.nextAction || '', ...failures].filter(Boolean), lessons, skillsUsed: [] }).catch(error => { this.state.shortTermMemory.selfImprovementError = error instanceof Error ? error.message : String(error); });
      await this.requestReplan(`Goal verification rejected completion: ${verification.reason}${verification.nextAction ? ` Next: ${verification.nextAction}` : ''}`);
      return true;
    }
    this.state.goalHistory.push(goal);
    await this.dhsIntelligence.generateGoalInsights(true, goal);
    await this.memoryStore.remember({ kind: 'event', content: `Verified goal completed: ${goal}`, tags: ['goal', 'verified'], importance: 9, source: 'DHS' });
    await this.selfImprovement.observe({ goal, success: true, evidence: improvementEvidence, failures, lessons, skillsUsed: [] }).catch(error => { this.state.shortTermMemory.selfImprovementError = error instanceof Error ? error.message : String(error); });
    this.state.currentGoal = null;
    this.state.currentPlan = [];
    this.tasksThisRun = 0;
    this.replansThisGoal = 0;
    await this.sessionStore.event('goal_completed', `Goal verified: ${goal}`, verification);
    return true;
  }

  private parseJson(content: string): any {
    const candidate = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || content;
    const start = candidate.indexOf('{'); const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Expected JSON decision');
    return JSON.parse(candidate.slice(start, end + 1));
  }
  private safeEvidence(value: any): any { try { const text = JSON.stringify(value); return text.length > 12000 ? `${text.slice(0, 12000)}…` : value; } catch { return String(value); } }
  private sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }
}
