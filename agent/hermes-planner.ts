import { AgentState } from './state';
import { ToolRegistry } from '../tools/registry';
import { BasePlanner, PlannerResult, PlannedStep, SimplePlanner } from './planner';
import { createModelClient } from '../config/model-provider';
import { MemoryStore } from '../core/memory';
import { SkillStore } from '../core/skills';
import { normalizeSkillRefs } from './skill-attribution';

/**
 * Integrated Hermes-derived reasoning/planning capability.
 * The implementation lives inside Layra; no `hermes` executable is spawned.
 */
export class HermesPlanner extends BasePlanner {
  private readonly fallback: SimplePlanner;
  private readonly memory: MemoryStore;
  private readonly skills: SkillStore;

  constructor(state: AgentState, toolRegistry: ToolRegistry) {
    super(state, toolRegistry, { maxSteps: Math.max(1, Number(process.env.LAYRA_MAX_PLAN_STEPS || 8)), allowParallel: true, requireVerification: true, riskTolerance: 'medium' });
    this.fallback = new SimplePlanner(state, toolRegistry, { maxSteps: this.options.maxSteps, allowParallel: true, requireVerification: true, riskTolerance: 'medium' });
    this.memory = new MemoryStore();
    this.skills = new SkillStore();
  }

  async plan(goal: string, context: Record<string, any> = {}): Promise<PlannerResult> {
    await this.memory.load();
    const client = createModelClient();
    if (!client) {
      this.state.shortTermMemory.relevantSkillsForGoal = [];
      return this.fallback.plan(goal, context);
    }
    const memories = await this.memory.search(goal, 8);
    const skills = await this.skills.findRelevant(goal, 4);
    const allowedSkillRefs = new Set(skills.map(skill => skill.name));
    this.state.shortTermMemory.relevantSkillsForGoal = skills.map(skill => skill.name).slice(0, 4);
    const toolCatalog = this.toolRegistry.getAvailableTools().map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, returns: tool.returns, risk: tool.permissions }));
    const prompt = { goal, availableTools: toolCatalog, relevantMemory: memories, relevantSkills: skills.map(skill => ({ name: skill.name, description: skill.description, content: skill.content.slice(0, 8000) })), state: { currentGoal: this.state.currentGoal, recentActions: this.state.executionHistory.slice(-8), recentReflections: this.state.reflections.slice(-8), previousPlans: this.state.planningHistory.slice(-3) }, context };
    try {
      const response = await client.chat([
        { role: 'system', content: [
          'You are Layra\'s integrated planning capability.',
          'Plan real work, not a conversation. Select only tools from availableTools.',
          `Return at most ${this.options.maxSteps} steps. IDs must be unique and dependencies must reference valid step IDs.`,
          'Prefer the smallest useful sequence; independent read-only work may run in parallel.',
          'Each step may include skillRefs: an array naming only relevantSkills that this step will intentionally follow. Do not add a skillRef merely because a skill is relevant elsewhere in the goal.',
          'A skill reference is an execution attribution: Layra records it only after this step receives a real tool result.',
          'Every step needs an explicit expectedOutcome and verificationRequired=true for consequential work.',
          'Do not claim that an action has already happened.',
          'Return ONLY JSON matching the requested plan schema.'
        ].join(' ') },
        { role: 'user', content: JSON.stringify(prompt) }
      ], { temperature: 0.15, maxTokens: 5000 });
      const parsed = this.parseJson(response.content);
      const normalized: PlannerResult = { steps: Array.isArray(parsed?.steps) ? parsed.steps.map((step: any, index: number) => this.normalizeStep(step, index, allowedSkillRefs)).filter(Boolean) as PlannedStep[] : [], confidence: Math.max(0, Math.min(1, Number(parsed?.confidence ?? 0.5))), reasoning: String(parsed?.reasoning || 'Model-generated plan'), alternatives: [] };
      const validation = this.validatePlan(normalized);
      if (!validation.isValid || !normalized.steps.length) return this.fallback.plan(goal, { ...context, planningError: validation.issues });
      return this.optimizePlan(normalized);
    } catch (error) {
      this.state.shortTermMemory.lastPlanningError = error instanceof Error ? error.message : String(error);
      return this.fallback.plan(goal, { ...context, planningError: this.state.shortTermMemory.lastPlanningError });
    }
  }

  validatePlan(plan: PlannerResult): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];
    if (!plan.steps.length) issues.push('Plan contains no steps');
    if (plan.steps.length > this.options.maxSteps) issues.push(`Plan exceeds maxSteps=${this.options.maxSteps}`);
    const ids = new Set<string>();
    const byId = new Map<string, PlannedStep>();
    for (const step of plan.steps) {
      if (!step.id) issues.push('Step has no id');
      if (ids.has(step.id)) issues.push(`Duplicate step id: ${step.id}`);
      ids.add(step.id); byId.set(step.id, step);
      if (!this.toolRegistry.isToolAvailable(step.tool)) issues.push(`Unavailable tool: ${step.tool}`);
      if (!step.description || !step.expectedOutcome) issues.push(`Incomplete step: ${step.id}`);
      if ((step.skillRefs || []).length > 4) issues.push(`Too many skill references for ${step.id}`);
      if (new Set(step.skillRefs || []).size !== (step.skillRefs || []).length) issues.push(`Duplicate skill reference for ${step.id}`);
      for (const dep of step.dependsOn) {
        if (dep === step.id) issues.push(`Self dependency on ${step.id}`);
        if (!plan.steps.some(item => item.id === dep)) issues.push(`Missing dependency ${dep} for ${step.id}`);
      }
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) { issues.push(`Cyclic dependency involving ${id}`); return; }
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dep of byId.get(id)?.dependsOn || []) visit(dep);
      visiting.delete(id); visited.add(id);
    };
    for (const step of plan.steps) visit(step.id);
    return { isValid: issues.length === 0, issues };
  }

  optimizePlan(plan: PlannerResult): PlannerResult {
    const byId = new Map(plan.steps.map(step => [step.id, step]));
    const memo = new Map<string, number>();
    const depth = (id: string): number => {
      const saved = memo.get(id); if (saved !== undefined) return saved;
      const step = byId.get(id); if (!step || !step.dependsOn.length) { memo.set(id, 0); return 0; }
      const value = 1 + Math.max(...step.dependsOn.map(dep => depth(dep)));
      memo.set(id, value); return value;
    };
    const steps = [...plan.steps].sort((a, b) => depth(a.id) - depth(b.id) || b.priority - a.priority);
    return { ...plan, steps };
  }

  canExecuteInParallel(step1: PlannedStep, step2: PlannedStep): boolean {
    if (step1.dependsOn.includes(step2.id) || step2.dependsOn.includes(step1.id)) return false;
    const writes = (name: string) => name === 'filesystem.write' || name === 'web.post' || name === 'shell.execute';
    if (writes(step1.tool) || writes(step2.tool)) return false;
    return true;
  }

  estimateTotalDuration(plan: PlannerResult): number { return plan.steps.reduce((sum, step) => sum + Math.max(1, step.estimatedDuration), 0); }
  calculatePlanRisk(plan: PlannerResult): 'low' | 'medium' | 'high' { if (plan.steps.some(step => step.riskLevel === 'high')) return 'high'; if (plan.steps.some(step => step.riskLevel === 'medium')) return 'medium'; return 'low'; }

  private normalizeStep(step: any, index: number, allowedSkillRefs: Set<string>): PlannedStep | null {
    if (!step || typeof step !== 'object' || typeof step.tool !== 'string') return null;
    const risk = step.riskLevel === 'high' || step.riskLevel === 'medium' ? step.riskLevel : 'low';
    return { id: String(step.id || `plan_${Date.now()}_${index}`), description: String(step.description || `Execute ${step.tool}`), tool: step.tool, parameters: step.parameters && typeof step.parameters === 'object' ? step.parameters : {}, dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [], estimatedDuration: Math.max(1, Number(step.estimatedDuration || 5)), priority: Math.max(0, Number(step.priority || 1)), riskLevel: risk, verificationRequired: step.verificationRequired !== false, expectedOutcome: String(step.expectedOutcome || 'Successful tool execution'), skillRefs: normalizeSkillRefs(step.skillRefs, allowedSkillRefs) };
  }

  private parseJson(content: string): any { const candidate = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || content; const start = candidate.indexOf('{'); const end = candidate.lastIndexOf('}'); if (start < 0 || end <= start) throw new Error('Planner returned no JSON object'); return JSON.parse(candidate.slice(start, end + 1)); }
}
