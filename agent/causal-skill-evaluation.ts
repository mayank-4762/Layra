import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeRelativePath } from '../core/security';

export type SkillCondition = 'skill' | 'control';
export type CausalVerdict = 'improved' | 'regressed' | 'inconclusive';

export interface SkillExperimentObservation {
  id: string;
  candidateId: string;
  skill: string;
  goalClass: string;
  condition: SkillCondition;
  success: boolean;
  evidenceSuccessRate: number;
  timestamp: string;
}

export interface CausalEvaluation {
  verdict: CausalVerdict;
  sampleSkill: number;
  sampleControl: number;
  skillSuccessRate: number;
  controlSuccessRate: number;
  skillEvidenceRate: number;
  controlEvidenceRate: number;
  effectSize: number;
  reason: string;
}

interface PersistedState {
  version: 1;
  observations: SkillExperimentObservation[];
}

/**
 * Reuse evaluator that refuses to treat one successful reuse as causal evidence.
 * A skill can only be judged when comparable skill-assisted and control outcomes
 * exist for the same normalized task class.
 */
export class CausalSkillEvaluator {
  private readonly stateDir: string;
  private readonly file: string;
  private state: PersistedState = { version: 1, observations: [] };
  private loaded = false;

  constructor(stateDir?: string) {
    this.stateDir = path.resolve(stateDir || process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state'));
    this.file = assertSafeRelativePath(this.stateDir, 'skill-causal-evaluation.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedState>;
      if (Array.isArray(parsed?.observations)) {
        this.state = {
          version: 1,
          observations: parsed.observations.filter(this.validObservation).slice(-2000)
        };
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load causal skill state: ${error?.message || String(error)}`);
    }
    await fs.mkdir(this.stateDir, { recursive: true });
    this.loaded = true;
  }

  async recordObservation(input: {
    candidateId: string;
    skill: string;
    goal: string;
    condition: SkillCondition;
    success: boolean;
    evidenceSuccessRate: number;
    timestamp?: string;
  }): Promise<CausalEvaluation> {
    await this.load();
    const observation: SkillExperimentObservation = {
      id: `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      candidateId: String(input.candidateId),
      skill: String(input.skill),
      goalClass: classifyGoal(input.goal),
      condition: input.condition,
      success: Boolean(input.success),
      evidenceSuccessRate: clamp(Number(input.evidenceSuccessRate), 0, 1),
      timestamp: input.timestamp || new Date().toISOString()
    };
    this.state.observations.push(observation);
    this.state.observations = this.state.observations.slice(-2000);
    await this.persist();
    return this.evaluateObservation(observation);
  }

  async evaluate(candidateId: string, skill: string, goal: string): Promise<CausalEvaluation> {
    await this.load();
    const goalClass = classifyGoal(goal);
    const observations = this.state.observations.filter(item => item.candidateId === candidateId && item.skill === skill && item.goalClass === goalClass);
    return this.evaluateSet(observations);
  }

  getStatus() {
    const groups = new Set(this.state.observations.map(item => `${item.candidateId}|${item.skill}|${item.goalClass}`));
    return {
      observations: this.state.observations.length,
      evaluationGroups: groups.size,
      comparableGroups: Array.from(groups).filter(group => {
        const [candidateId, skill, goalClass] = group.split('|');
        const set = this.state.observations.filter(item => item.candidateId === candidateId && item.skill === skill && item.goalClass === goalClass);
        return set.filter(item => item.condition === 'skill').length >= 3 && set.filter(item => item.condition === 'control').length >= 3;
      }).length
    };
  }

  private evaluateObservation(observation: SkillExperimentObservation): CausalEvaluation {
    return this.evaluateSet(this.state.observations.filter(item => item.candidateId === observation.candidateId && item.skill === observation.skill && item.goalClass === observation.goalClass));
  }

  private evaluateSet(observations: SkillExperimentObservation[]): CausalEvaluation {
    const skill = observations.filter(item => item.condition === 'skill');
    const control = observations.filter(item => item.condition === 'control');
    const skillSuccessRate = rate(skill.map(item => item.success ? 1 : 0));
    const controlSuccessRate = rate(control.map(item => item.success ? 1 : 0));
    const skillEvidenceRate = rate(skill.map(item => item.evidenceSuccessRate));
    const controlEvidenceRate = rate(control.map(item => item.evidenceSuccessRate));
    const effectSize = ((skillSuccessRate + skillEvidenceRate) / 2) - ((controlSuccessRate + controlEvidenceRate) / 2);

    if (skill.length < 3 || control.length < 3) {
      return {
        verdict: 'inconclusive', sampleSkill: skill.length, sampleControl: control.length,
        skillSuccessRate, controlSuccessRate, skillEvidenceRate, controlEvidenceRate, effectSize,
        reason: 'Need at least 3 comparable skill and 3 control observations before assigning causal credit.'
      };
    }

    if (effectSize >= 0.15 && skillSuccessRate >= controlSuccessRate) {
      return { verdict: 'improved', sampleSkill: skill.length, sampleControl: control.length, skillSuccessRate, controlSuccessRate, skillEvidenceRate, controlEvidenceRate, effectSize, reason: 'Repeated comparable outcomes favor the skill-assisted condition.' };
    }
    if (effectSize <= -0.15 && skillSuccessRate <= controlSuccessRate) {
      return { verdict: 'regressed', sampleSkill: skill.length, sampleControl: control.length, skillSuccessRate, controlSuccessRate, skillEvidenceRate, controlEvidenceRate, effectSize, reason: 'Repeated comparable outcomes favor the control condition.' };
    }
    return { verdict: 'inconclusive', sampleSkill: skill.length, sampleControl: control.length, skillSuccessRate, controlSuccessRate, skillEvidenceRate, controlEvidenceRate, effectSize, reason: 'Comparable data exists, but the observed effect is too small or mixed to assign causal credit.' };
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }

  private readonly validObservation = (item: any): item is SkillExperimentObservation => {
    return Boolean(item && typeof item.id === 'string' && typeof item.candidateId === 'string' && typeof item.skill === 'string'
      && typeof item.goalClass === 'string' && (item.condition === 'skill' || item.condition === 'control')
      && typeof item.success === 'boolean' && typeof item.evidenceSuccessRate === 'number'
      && Number.isFinite(item.evidenceSuccessRate) && item.evidenceSuccessRate >= 0 && item.evidenceSuccessRate <= 1
      && typeof item.timestamp === 'string');
  };
}

function classifyGoal(goal: string): string {
  const stop = new Set(['the','a','an','and','or','to','of','for','on','in','with','from','then','when','this','that','is','are','be','by','into','your','layra','do','create','make','build','write','check','test']);
  const tokens = Array.from(new Set(String(goal).toLowerCase().split(/[^a-z0-9]+/).filter(item => item.length >= 3 && !stop.has(item)))).sort();
  return tokens.slice(0, 8).join('-') || 'generic';
}
function rate(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }
