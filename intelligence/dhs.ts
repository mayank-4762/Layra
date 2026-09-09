import { AgentState, ReflectionType } from '../agent/state';
import { ToolExecutor } from '../tools/executor';
import { DeepSeekClient } from '../deepseek-client';

export interface DHSInsight {
  id: string;
  type: string;
  content: string;
  confidence: number;
  source: string[];
  createdAt: Date;
  metadata: Record<string, any>;
}

/** DHS = DeepSeek-powered analysis, reflection and learning layer for Layra. */
export class DHSIntelligence {
  private readonly state: AgentState;
  private readonly _toolExecutor: ToolExecutor;
  private client: DeepSeekClient | null = null;
  private callCount = 0;
  private readonly maxCallsPerSession = Number(process.env.LAYRA_DHS_MAX_CALLS || 12);
  private readonly minCallInterval = Number(process.env.LAYRA_DHS_MIN_INTERVAL_MS || 1500);
  private lastCallTime = 0;

  constructor(state: AgentState, toolExecutor: ToolExecutor) {
    this.state = state;
    this._toolExecutor = toolExecutor;
  }

  private getClient(): DeepSeekClient {
    if (!this.client) this.client = new DeepSeekClient();
    return this.client;
  }

  private canCall(): boolean {
    return Boolean(process.env.DEEPSEEK_API_KEY) && this.callCount < this.maxCallsPerSession && Date.now() - this.lastCallTime >= this.minCallInterval;
  }

  private remember(insight: DHSInsight): void {
    const lessons = Array.isArray(this.state.longTermMemory?.lessons) ? this.state.longTermMemory.lessons : [];
    this.state.longTermMemory = {
      ...(this.state.longTermMemory || {}),
      lessons: [...lessons, { id: insight.id, type: insight.type, content: insight.content, confidence: insight.confidence, createdAt: insight.createdAt.toISOString(), metadata: insight.metadata }].slice(-100)
    };
  }

  private async analyzeJson<T>(prompt: string, maxTokens = 1400): Promise<T | null> {
    if (!this.canCall()) return null;
    try {
      this.callCount += 1;
      this.lastCallTime = Date.now();
      return await this.getClient().analyze(prompt, { json: true, maxTokens });
    } catch (error) {
      console.error('[DHS] DeepSeek analysis error:', error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async analyzeWithDeepSeek(prompt: string) {
    const result: any = await this.analyzeJson(`${prompt}\nReturn JSON with keys: insight, confidence, suggestions, needsFollowup. Do not invent evidence.`);
    if (!result) return null;
    return { insight: String(result?.insight || ''), confidence: Math.max(0, Math.min(1, Number(result?.confidence ?? 0.5))), suggestions: Array.isArray(result?.suggestions) ? result.suggestions.map(String) : [], needsFollowup: Boolean(result?.needsFollowup) };
  }

  async generateInsightsFromSteps(completedSteps: any[]): Promise<DHSInsight[]> {
    if (completedSteps.length < 2) return [];
    const result = await this.analyzeWithDeepSeek(`Analyze Layra execution evidence. Goal: ${this.state.currentGoal || 'none'}\n${completedSteps.slice(-10).map(step => `${step.id}: ${step.status} ${step.description}; result=${JSON.stringify(step.result ?? null)}; error=${step.error ?? ''}`).join('\n')}\nIdentify concrete patterns, failures, and reusable lessons.`);
    if (!result?.insight) return [];
    const insight: DHSInsight = { id: `dhs_${Date.now()}`, type: ReflectionType.PATTERN, content: result.insight, confidence: result.confidence, source: completedSteps.map(step => String(step.id)), createdAt: new Date(), metadata: { suggestions: result.suggestions, needsFollowup: result.needsFollowup, source: 'deepseek' } };
    this.remember(insight);
    return [insight];
  }

  async generateGoalInsights(goalAchieved: boolean, goal: string): Promise<DHSInsight[]> {
    const result = await this.analyzeWithDeepSeek(`Evaluate this goal attempt using the supplied evidence only. Goal: ${goal}\nAchieved: ${goalAchieved}\nCompleted: ${this.state.completedTasks.length}\nFailed: ${this.state.failedTasks.length}\nActions: ${this.state.totalActions}\nSuccess rate: ${(this.state.successRate * 100).toFixed(1)}%\nRecent reflections: ${JSON.stringify(this.state.reflections.slice(-8))}`);
    if (!result?.insight) return [];
    const insight: DHSInsight = { id: `dhs_goal_${Date.now()}`, type: goalAchieved ? ReflectionType.LESSON : ReflectionType.CORRECTION, content: result.insight, confidence: result.confidence, source: [`goal_${Date.now()}`], createdAt: new Date(), metadata: { goal, goalAchieved, suggestions: result.suggestions, needsFollowup: result.needsFollowup, source: 'deepseek' } };
    this.remember(insight);
    return [insight];
  }

  async verifyGoal(goal: string, evidence: any[]): Promise<{ achieved: boolean; confidence: number; reason: string; nextAction?: string }> {
    const usableEvidence = evidence.filter(item => item && item.status === 'completed');
    const hasErrors = evidence.some(item => item?.error);
    const fallback = {
      achieved: evidence.length > 0 && evidence.every(item => item?.status === 'completed') && !hasErrors,
      confidence: evidence.length > 0 && !hasErrors ? 0.55 : 0,
      reason: evidence.length > 0 && !hasErrors ? 'All planned steps completed without execution errors; DHS verification was unavailable at this moment.' : 'Execution evidence does not establish successful completion.',
      nextAction: evidence.length > 0 && !hasErrors ? undefined : 'Generate a revised plan from the latest failure evidence.'
    };
    if (!this.canCall()) return fallback;

    const result: any = await this.analyzeJson(`Act as Layra's independent goal verifier. Goal: ${goal}\nExecution evidence:\n${JSON.stringify(evidence.slice(-12))}\nRequire direct evidence of the stated goal, not task count. You may mark achieved only when the evidence supports the actual goal. Return exactly JSON: {"achieved":true|false,"confidence":0-1,"reason":"...","nextAction":"..."}.`, 900);
    if (!result) return fallback;
    return {
      achieved: Boolean(result.achieved),
      confidence: Math.max(0, Math.min(1, Number(result.confidence ?? 0))),
      reason: String(result.reason || ''),
      nextAction: result.nextAction ? String(result.nextAction) : undefined
    };
  }

  getCallCount(): number { return this.callCount; }
  resetCallCount(): void { this.callCount = 0; this.lastCallTime = 0; }
  isAvailable(): boolean { return Boolean(process.env.DEEPSEEK_API_KEY) && this.canCall(); }
}
