import { AgentState } from './state';
import { ToolRegistry } from '../tools/registry';

export interface PlannerOptions { maxSteps: number; allowParallel: boolean; requireVerification: boolean; riskTolerance: 'low' | 'medium' | 'high'; }
export interface PlannerResult { steps: PlannedStep[]; confidence: number; reasoning: string; alternatives: PlannedStep[][]; }
export interface PlannedStep {
  id: string; description: string; tool: string; parameters: Record<string, any>; dependsOn: string[];
  estimatedDuration: number; priority: number; riskLevel: 'low' | 'medium' | 'high'; verificationRequired: boolean; expectedOutcome: string;
  /** Skills the planner intends this step to follow; usage is only recorded after execution produces a result. */
  skillRefs?: string[];
}

export abstract class BasePlanner {
  protected readonly state: AgentState; protected readonly toolRegistry: ToolRegistry; protected readonly options: PlannerOptions;
  constructor(state: AgentState, toolRegistry: ToolRegistry, options: Partial<PlannerOptions> = {}) {
    this.state = state; this.toolRegistry = toolRegistry;
    this.options = { maxSteps: options.maxSteps ?? 5, allowParallel: options.allowParallel ?? false, requireVerification: options.requireVerification ?? true, riskTolerance: options.riskTolerance ?? 'medium' };
  }
  public abstract plan(goal: string, context?: Record<string, any>): Promise<PlannerResult>;
  public abstract validatePlan(plan: PlannerResult): { isValid: boolean; issues: string[] };
  public abstract optimizePlan(plan: PlannerResult): PlannerResult;
  public abstract canExecuteInParallel(step1: PlannedStep, step2: PlannedStep): boolean;
  public abstract estimateTotalDuration(plan: PlannerResult): number;
  public abstract calculatePlanRisk(plan: PlannerResult): 'low' | 'medium' | 'high';
  protected validateParameters(toolName: string, _parameters: Record<string, any>): boolean { return Boolean(this.toolRegistry.getTool(toolName)); }
  protected filterAvailableSteps(steps: PlannedStep[]): PlannedStep[] { return steps.filter(step => this.toolRegistry.isToolAvailable(step.tool)); }
}

/** Conservative fallback used only when Hermes is unavailable. It never relies on stale project-specific paths. */
export class SimplePlanner extends BasePlanner {
  public async plan(goal: string, _context?: Record<string, any>): Promise<PlannerResult> {
    const steps: PlannedStep[] = [];
    const urls = goal.match(/https?:\/\/[^\s)]+/g) || [];
    const firstUrl = urls[0];
    if (firstUrl && this.toolRegistry.isToolAvailable('web.get')) {
      steps.push({ id: 'simple_web_1', description: `Fetch referenced URL: ${firstUrl}`, tool: 'web.get', parameters: { url: firstUrl }, dependsOn: [], estimatedDuration: 5, priority: 1, riskLevel: 'low', verificationRequired: true, expectedOutcome: 'Successful retrieval of the referenced URL', skillRefs: [] });
    }
    if (this.toolRegistry.isToolAvailable('filesystem.list')) {
      steps.push({ id: steps.length ? 'simple_workspace_2' : 'simple_workspace_1', description: 'Inspect the Layra workspace to gather local evidence', tool: 'filesystem.list', parameters: { path: '.', recursive: false }, dependsOn: steps.length ? [steps[0].id] : [], estimatedDuration: 2, priority: 1, riskLevel: 'low', verificationRequired: true, expectedOutcome: 'Workspace evidence relevant to the goal', skillRefs: [] });
    }
    if (!steps.length && this.toolRegistry.isToolAvailable('system.info')) {
      steps.push({ id: 'simple_system_1', description: 'Inspect Layra runtime information', tool: 'system.info', parameters: {}, dependsOn: [], estimatedDuration: 1, priority: 1, riskLevel: 'low', verificationRequired: true, expectedOutcome: 'Runtime information available for planning', skillRefs: [] });
    }
    const bounded = steps.slice(0, this.options.maxSteps);
    return { steps: bounded, confidence: bounded.length ? 0.35 : 0, reasoning: `Conservative fallback planning for goal: ${goal}`, alternatives: [] };
  }
  public validatePlan(plan: PlannerResult): { isValid: boolean; issues: string[] } {
    const issues: string[] = [];
    if (!plan.steps.length) issues.push('Plan contains no steps');
    if (plan.steps.length > this.options.maxSteps) issues.push(`Plan exceeds maxSteps=${this.options.maxSteps}`);
    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (ids.has(step.id)) issues.push(`Duplicate step id: ${step.id}`);
      ids.add(step.id);
      if (!this.toolRegistry.isToolAvailable(step.tool)) issues.push(`Unavailable tool: ${step.tool}`);
      for (const dep of step.dependsOn) { if (!plan.steps.some(candidate => candidate.id === dep)) issues.push(`Missing dependency ${dep} for ${step.id}`); if (dep === step.id) issues.push(`Self dependency on ${step.id}`); }
    }
    return { isValid: issues.length === 0, issues };
  }
  public optimizePlan(plan: PlannerResult): PlannerResult { return plan; }
  public canExecuteInParallel(step1: PlannedStep, step2: PlannedStep): boolean { return !step1.dependsOn.includes(step2.id) && !step2.dependsOn.includes(step1.id); }
  public estimateTotalDuration(plan: PlannerResult): number { return plan.steps.reduce((sum, step) => sum + step.estimatedDuration, 0); }
  public calculatePlanRisk(plan: PlannerResult): 'low' | 'medium' | 'high' { if (plan.steps.some(s => s.riskLevel === 'high')) return 'high'; if (plan.steps.some(s => s.riskLevel === 'medium')) return 'medium'; return 'low'; }
}
