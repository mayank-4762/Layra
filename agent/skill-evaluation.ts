import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeRelativePath } from '../core/security';

export interface SkillExperimentRecord {
  id: string;
  skill: string | null;
  taskClass: string;
  goal: string;
  skillStepSuccess: boolean | null;
  goalSuccess: boolean;
  verificationPassed: boolean;
  durationMs: number;
  evidenceCount: number;
  timestamp: string;
}

export type SkillEffect = 'improved' | 'regressed' | 'neutral' | 'insufficient_data';

export interface SkillEffectScore {
  skill: string;
  taskClass: string;
  skillUses: number;
  skillSuccesses: number;
  baselineUses: number;
  baselineSuccesses: number;
  skillSuccessRate: number;
  baselineSuccessRate: number;
  successDelta: number;
  skillWilsonLow: number;
  skillWilsonHigh: number;
  baselineWilsonLow: number;
  baselineWilsonHigh: number;
  durationDeltaMs: number | null;
  confidence: number;
  effect: SkillEffect;
}

export interface SkillEvaluationResult {
  taskClass: string;
  baselineRecorded: boolean;
  scores: SkillEffectScore[];
}

interface PersistedState {
  version: 1;
  records: SkillExperimentRecord[];
}

const MAX_RECORDS = 2000;
const MIN_COMPARABLE_RUNS = 5;

/**
 * Evidence tracker for learned skills.
 * A skill is never considered beneficial merely because one goal succeeded.
 * It is compared with no-skill runs from the same normalized task class and
 * only receives an improvement/regression verdict when confidence intervals
 * separate with enough comparable observations.
 */
export class SkillEvaluationStore {
  private readonly file: string;
  private readonly state: PersistedState = { version: 1, records: [] };
  private loaded = false;

  constructor(stateDir?: string) {
    const root = path.resolve(stateDir || process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state'));
    this.file = assertSafeRelativePath(root, 'skill-evaluations.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<PersistedState>;
      if (Array.isArray(parsed.records)) {
        this.state.records = parsed.records.filter(this.validRecord).slice(-MAX_RECORDS);
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load skill evaluation state: ${error?.message || String(error)}`);
    }
    this.loaded = true;
  }

  async record(input: Omit<SkillExperimentRecord, 'id' | 'timestamp'> & { timestamp?: string }): Promise<SkillExperimentRecord> {
    await this.load();
    const record: SkillExperimentRecord = {
      ...input,
      id: `skill_exp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: input.timestamp || new Date().toISOString()
    };
    this.state.records.push(record);
    this.state.records = this.state.records.slice(-MAX_RECORDS);
    await this.persist();
    return record;
  }

  async evaluate(taskClass: string, skills: string[]): Promise<SkillEvaluationResult> {
    await this.load();
    const normalizedClass = normalizeTaskClass(taskClass);
    const comparable = this.state.records.filter(record => record.taskClass === normalizedClass);
    const uniqueSkills = Array.from(new Set(skills.filter(Boolean)));
    const baselineRecorded = uniqueSkills.length === 0;
    const scores: SkillEffectScore[] = [];

    for (const skill of uniqueSkills) {
      const skillRuns = comparable.filter(record => record.skill === skill);
      const baselineRuns = comparable.filter(record => record.skill === null);
      const score = scoreSkill(skill, normalizedClass, skillRuns, baselineRuns);
      scores.push(score);
    }

    return { taskClass: normalizedClass, baselineRecorded, scores };
  }

  async recordAndEvaluate(input: Omit<SkillExperimentRecord, 'id' | 'timestamp'> & { timestamp?: string }): Promise<SkillEvaluationResult> {
    await this.record(input);
    return this.evaluate(input.taskClass, input.skill ? [input.skill] : []);
  }

  getRecords(): SkillExperimentRecord[] {
    return this.state.records.slice();
  }

  private validRecord = (record: any): record is SkillExperimentRecord => {
    if (!record || typeof record !== 'object') return false;
    if (typeof record.id !== 'string' || !record.id) return false;
    if (record.skill !== null && typeof record.skill !== 'string') return false;
    if (typeof record.taskClass !== 'string' || !record.taskClass) return false;
    if (typeof record.goal !== 'string') return false;
    if (record.skillStepSuccess !== null && typeof record.skillStepSuccess !== 'boolean') return false;
    if (typeof record.goalSuccess !== 'boolean' || typeof record.verificationPassed !== 'boolean') return false;
    if (!Number.isFinite(record.durationMs) || record.durationMs < 0) return false;
    if (!Number.isInteger(record.evidenceCount) || record.evidenceCount < 0) return false;
    return typeof record.timestamp === 'string' && !!record.timestamp;
  };

  private async persist(): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}

function scoreSkill(skill: string, taskClass: string, skillRuns: SkillExperimentRecord[], baselineRuns: SkillExperimentRecord[]): SkillEffectScore {
  const skillSuccesses = skillRuns.filter(record => record.goalSuccess && record.verificationPassed).length;
  const baselineSuccesses = baselineRuns.filter(record => record.goalSuccess && record.verificationPassed).length;
  const skillSuccessRate = skillRuns.length ? skillSuccesses / skillRuns.length : 0;
  const baselineSuccessRate = baselineRuns.length ? baselineSuccesses / baselineRuns.length : 0;
  const skillWilson = wilson(skillSuccesses, skillRuns.length);
  const baselineWilson = wilson(baselineSuccesses, baselineRuns.length);
  const successDelta = skillSuccessRate - baselineSuccessRate;
  const durationDeltaMs = skillRuns.length && baselineRuns.length
    ? mean(skillRuns.map(record => record.durationMs)) - mean(baselineRuns.map(record => record.durationMs))
    : null;

  let effect: SkillEffect = 'insufficient_data';
  if (skillRuns.length >= MIN_COMPARABLE_RUNS && baselineRuns.length >= MIN_COMPARABLE_RUNS) {
    if (skillWilson.low > baselineWilson.high) effect = 'improved';
    else if (skillWilson.high < baselineWilson.low) effect = 'regressed';
    else effect = 'neutral';
  }

  const separation = Math.max(0, Math.max(skillWilson.low - baselineWilson.high, baselineWilson.low - skillWilson.high));
  const confidence = Math.min(0.99, Math.max(0.1, effect === 'insufficient_data' ? Math.min(0.5, 0.1 + Math.min(skillRuns.length, baselineRuns.length) / 20) : 0.5 + separation));
  return {
    skill, taskClass, skillUses: skillRuns.length, skillSuccesses, baselineUses: baselineRuns.length, baselineSuccesses,
    skillSuccessRate, baselineSuccessRate, successDelta,
    skillWilsonLow: skillWilson.low, skillWilsonHigh: skillWilson.high,
    baselineWilsonLow: baselineWilson.low, baselineWilsonHigh: baselineWilson.high,
    durationDeltaMs, confidence, effect
  };
}

function wilson(successes: number, total: number): { low: number; high: number } {
  if (!total) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denom;
  const spread = (z / denom) * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function normalizeTaskClass(value: string): string {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'on', 'in', 'with', 'from', 'then', 'when', 'this', 'that', 'is', 'are', 'be', 'by', 'into', 'your', 'layra']);
  const tokens = Array.from(new Set(String(value).toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length >= 3 && !stop.has(token)))).sort();
  return tokens.slice(0, 8).join(' ') || 'unknown';
}
