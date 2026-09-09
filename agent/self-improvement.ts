import { promises as fs } from 'fs';
import path from 'path';
import { createModelClient } from '../config/model-provider';
import { MemoryStore } from '../core/memory';
import { SkillStore } from '../core/skills';
import { assertSafeRelativePath, inspectUntrustedText } from '../core/security';

export type ImprovementKind = 'knowledge' | 'skill' | 'strategy' | 'code';
export type ImprovementStatus = 'proposed' | 'validated' | 'promoted' | 'rejected' | 'rolled_back';

export interface ImprovementEvidence {
  id: string;
  type: string;
  summary: string;
  success: boolean;
}

export interface ImprovementCandidate {
  id: string;
  kind: ImprovementKind;
  title: string;
  rationale: string;
  change: string;
  evidence: ImprovementEvidence[];
  confidence: number;
  reversible: boolean;
  status: ImprovementStatus;
  createdAt: string;
  validatedAt?: string;
  promotedAt?: string;
  rollbackOf?: string;
}

interface ImprovementState {
  version: 1;
  candidates: ImprovementCandidate[];
  promotedCount: number;
  rejectedCount: number;
  rollbackCount: number;
  lastRunAt: string | null;
}

export interface SelfImprovementOptions {
  stateDir?: string;
  memoryStore?: MemoryStore;
  skillStore?: SkillStore;
  model?: { chat(messages: any[], options?: any): Promise<{ content: string }> } | null;
  enabled?: boolean;
  apply?: boolean;
  minConfidence?: number;
  minEvidence?: number;
  maxCandidates?: number;
}

/**
 * Native Layra closed learning loop.
 *
 * The engine observes outcomes, distills reusable lessons/skills/strategies,
 * validates candidates, promotes only bounded low-risk changes, and keeps
 * enough provenance to roll back a promotion. Executable source changes are
 * always proposal-only in this phase.
 */
export class SelfImprovementEngine {
  private readonly stateDir: string;
  private readonly file: string;
  private readonly improvementsDir: string;
  private readonly memory: MemoryStore;
  private readonly skills: SkillStore;
  private readonly model: SelfImprovementOptions['model'];
  private readonly enabled: boolean;
  private readonly apply: boolean;
  private readonly minConfidence: number;
  private readonly minEvidence: number;
  private readonly maxCandidates: number;
  private state: ImprovementState = {
    version: 1,
    candidates: [],
    promotedCount: 0,
    rejectedCount: 0,
    rollbackCount: 0,
    lastRunAt: null
  };
  private loaded = false;

  constructor(options: SelfImprovementOptions = {}) {
    this.stateDir = path.resolve(options.stateDir || process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state'));
    this.file = assertSafeRelativePath(this.stateDir, 'self-improvement.json');
    this.improvementsDir = assertSafeRelativePath(this.stateDir, 'improvements');
    this.memory = options.memoryStore || new MemoryStore(this.stateDir);
    this.skills = options.skillStore || new SkillStore();
    this.model = options.model === undefined ? createModelClient() : options.model;
    this.enabled = options.enabled ?? process.env.LAYRA_SELF_IMPROVEMENT_ENABLED !== 'false';
    this.apply = options.apply ?? process.env.LAYRA_SELF_IMPROVEMENT_APPLY === 'true';
    this.minConfidence = clamp(Number(options.minConfidence ?? process.env.LAYRA_SELF_IMPROVEMENT_MIN_CONFIDENCE ?? 0.8), 0, 1);
    this.minEvidence = Math.max(1, Math.floor(Number(options.minEvidence ?? process.env.LAYRA_SELF_IMPROVEMENT_MIN_EVIDENCE ?? 2)));
    this.maxCandidates = Math.max(1, Math.min(20, Math.floor(Number(options.maxCandidates ?? process.env.LAYRA_SELF_IMPROVEMENT_MAX_CANDIDATES ?? 3))));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<ImprovementState>;
      if (parsed?.version === 1 && Array.isArray(parsed.candidates)) {
        this.state = {
          version: 1,
          candidates: parsed.candidates.filter(this.validCandidate),
          promotedCount: Number(parsed.promotedCount || 0),
          rejectedCount: Number(parsed.rejectedCount || 0),
          rollbackCount: Number(parsed.rollbackCount || 0),
          lastRunAt: parsed.lastRunAt || null
        };
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load self-improvement state: ${error?.message || String(error)}`);
    }
    await fs.mkdir(this.improvementsDir, { recursive: true });
    this.loaded = true;
  }

  async observe(input: {
    goal: string;
    success: boolean;
    evidence: ImprovementEvidence[];
    failures?: string[];
    lessons?: string[];
    skillsUsed?: string[];
  }): Promise<ImprovementCandidate[]> {
    await this.load();
    if (!this.enabled) return [];
    const evidence = input.evidence.slice(-20);
    if (evidence.length < this.minEvidence && input.success) return [];
    const candidates = this.model
      ? await this.modelCandidates(input.goal, input.success, evidence, input.failures || [], input.lessons || [], input.skillsUsed || [])
      : this.deterministicCandidates(input.goal, input.success, evidence, input.failures || [], input.lessons || [], input.skillsUsed || []);

    const bounded = candidates.slice(0, this.maxCandidates).map(candidate => this.normalizeCandidate(candidate, evidence));
    for (const candidate of bounded) this.state.candidates.push(candidate);
    this.state.candidates = this.state.candidates.slice(-200);
    this.state.lastRunAt = new Date().toISOString();
    await this.persist();

    const results: ImprovementCandidate[] = [];
    for (const candidate of bounded) {
      const validated = await this.validate(candidate);
      if (!validated) {
        candidate.status = 'rejected';
        this.state.rejectedCount += 1;
        results.push(candidate);
        await this.persist();
        continue;
      }
      candidate.status = 'validated';
      candidate.validatedAt = new Date().toISOString();
      await this.writeProposal(candidate);
      if (this.canAutoPromote(candidate)) await this.promote(candidate);
      results.push(candidate);
      await this.persist();
    }
    return results;
  }

  async validate(candidate: ImprovementCandidate): Promise<boolean> {
    if (!candidate.reversible || candidate.evidence.length < this.minEvidence || candidate.confidence < this.minConfidence) return false;
    if (candidate.kind === 'code') return false;
    const unsafe = inspectUntrustedText(`${candidate.title}\n${candidate.rationale}\n${candidate.change}`);
    if (unsafe.some(item => item.severity === 'high')) return false;
    if (!candidate.change.trim()) return false;

    if (candidate.kind === 'skill') {
      const match = candidate.change.match(/(?:^|\n)\s*name:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/im);
      const body = candidate.change.replace(/^---[\s\S]*?---\s*/m, '').trim();
      if (!match || !body) return false;
      if (!/(^|\n)##\s+Verification\b/im.test(body)) return false;
    }
    return true;
  }

  async promote(candidate: ImprovementCandidate): Promise<boolean> {
    await this.load();
    if (!(await this.validate(candidate)) || candidate.status !== 'validated') return false;
    if (candidate.kind === 'knowledge') {
      await this.memory.remember({ kind: 'lesson', content: candidate.change.trim(), tags: ['self-improvement', 'learned'], importance: candidate.confidence * 10, source: `improvement:${candidate.id}` });
    } else if (candidate.kind === 'strategy') {
      await this.memory.remember({ kind: 'procedure', content: candidate.change.trim(), tags: ['self-improvement', 'strategy'], importance: candidate.confidence * 10, source: `improvement:${candidate.id}` });
    } else if (candidate.kind === 'skill') {
      const match = candidate.change.match(/(?:^|\n)\s*name:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/im);
      if (!match) return false;
      const name = match[1];
      const existing = await this.skills.read(name);
      if (existing) {
        await this.memory.remember({ kind: 'event', content: `Backed up skill ${name} before self-improvement promotion ${candidate.id}.`, tags: ['self-improvement', 'rollback'], importance: 8, source: `improvement:${candidate.id}` });
      }
      const body = candidate.change.replace(/^---[\s\S]*?---\s*/m, '').trim();
      await this.skills.upsert(name, body, { description: `Improved workflow learned by Layra.`, version: '0.2.0', trusted: false });
    } else {
      return false;
    }
    candidate.status = 'promoted';
    candidate.promotedAt = new Date().toISOString();
    this.state.promotedCount += 1;
    return true;
  }

  async rollback(candidateId: string, reason: string): Promise<boolean> {
    await this.load();
    const candidate = this.state.candidates.find(item => item.id === candidateId);
    if (!candidate || candidate.status !== 'promoted') return false;
    // Knowledge/strategy promotions are intentionally append-only; rollback
    // records a compensating event rather than deleting history.
    await this.memory.remember({ kind: 'event', content: `Self-improvement ${candidateId} rolled back: ${reason}`, tags: ['self-improvement', 'rollback'], importance: 9, source: candidateId });
    candidate.status = 'rolled_back';
    candidate.rollbackOf = reason.slice(0, 500);
    this.state.rollbackCount += 1;
    await this.persist();
    return true;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      apply: this.apply,
      minConfidence: this.minConfidence,
      minEvidence: this.minEvidence,
      candidates: this.state.candidates.length,
      promoted: this.state.promotedCount,
      rejected: this.state.rejectedCount,
      rolledBack: this.state.rollbackCount,
      lastRunAt: this.state.lastRunAt
    };
  }

  private canAutoPromote(candidate: ImprovementCandidate): boolean {
    return this.apply && candidate.kind !== 'code' && candidate.confidence >= this.minConfidence && candidate.evidence.length >= this.minEvidence;
  }

  private async modelCandidates(goal: string, success: boolean, evidence: ImprovementEvidence[], failures: string[], lessons: string[], skillsUsed: string[]): Promise<ImprovementCandidate[]> {
    try {
      const response = await this.model!.chat([
        { role: 'system', content: 'You are Layra self-improvement. Analyze evidence only. Propose at most 3 reversible, low-risk improvements. Do not propose executable code changes. Prefer reusable knowledge, skills, and strategies. Return strict JSON: {"candidates":[{"kind":"knowledge|skill|strategy|code","title":"","rationale":"","change":"","confidence":0-1}]}. Skill candidates must include a YAML line `name: learned-name` and a `## Verification` section. Never put shell execution instructions that bypass safety.' },
        { role: 'user', content: JSON.stringify({ goal, success, evidence, failures, lessons, skillsUsed }) }
      ], { temperature: 0.1, maxTokens: 1400 });
      const parsed = parseJson(response.content);
      return Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    } catch {
      return this.deterministicCandidates(goal, success, evidence, failures, lessons, skillsUsed);
    }
  }

  private deterministicCandidates(goal: string, success: boolean, evidence: ImprovementEvidence[], failures: string[], lessons: string[], skillsUsed: string[]): Array<Partial<ImprovementCandidate>> {
    const out: Array<Partial<ImprovementCandidate>> = [];
    if (!success && failures.length) {
      out.push({ kind: 'knowledge', title: 'Failure pattern', rationale: 'A failure occurred during the goal attempt and should remain available to future planning.', change: `When working on ${goal}, account for this observed failure pattern: ${failures.slice(0, 3).join(' | ')}` , confidence: 0.85, reversible: true });
    }
    if (lessons.length) {
      out.push({ kind: 'knowledge', title: 'Execution lesson', rationale: 'A lesson was derived from observed execution evidence.', change: lessons[0].trim(), confidence: 0.82, reversible: true });
    }
    if (success && evidence.length >= this.minEvidence && skillsUsed.length) {
      const name = `learned-${slug(goal).slice(0, 45) || 'workflow'}`;
      out.push({ kind: 'skill', title: `Reusable workflow: ${goal}`, rationale: 'The workflow produced sufficient evidence for procedural reuse.', change: `name: ${name}\n\n# ${goal}\n\n## Procedure\n${evidence.slice(-8).map((item, index) => `${index + 1}. ${item.summary}`).join('\n')}\n\n## Verification\nConfirm the same goal-specific outcome from fresh evidence; do not infer success from step completion alone.`, confidence: 0.84, reversible: true });
    }
    if (skillsUsed.length >= 2) {
      out.push({ kind: 'strategy', title: 'Prefer previously successful procedures', rationale: 'Existing skills were involved in the observed workflow.', change: `For goals similar to ${goal}, retrieve relevant skills before planning and prefer the procedure with the strongest recent evidence.`, confidence: 0.81, reversible: true });
    }
    return out;
  }

  private normalizeCandidate(candidate: Partial<ImprovementCandidate>, evidence: ImprovementEvidence[]): ImprovementCandidate {
    return {
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      kind: candidate.kind || 'knowledge',
      title: String(candidate.title || 'Untitled improvement').slice(0, 160),
      rationale: String(candidate.rationale || '').slice(0, 1200),
      change: String(candidate.change || '').slice(0, 8000),
      evidence: evidence.slice(-20),
      confidence: clamp(Number(candidate.confidence ?? 0.5), 0, 1),
      reversible: candidate.reversible !== false,
      status: 'proposed',
      createdAt: new Date().toISOString()
    };
  }

  private async writeProposal(candidate: ImprovementCandidate): Promise<void> {
    const safe = candidate.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = assertSafeRelativePath(this.improvementsDir, `${safe}.md`);
    const body = [
      `# ${candidate.title}`,
      '',
      `- ID: ${candidate.id}`,
      `- Kind: ${candidate.kind}`,
      `- Status: ${candidate.status}`,
      `- Confidence: ${candidate.confidence.toFixed(2)}`,
      `- Evidence count: ${candidate.evidence.length}`,
      `- Reversible: ${candidate.reversible}`,
      '',
      '## Rationale',
      candidate.rationale,
      '',
      '## Proposed Change',
      '```text',
      candidate.change,
      '```',
      '',
      '## Evidence',
      ...candidate.evidence.map(item => `- ${item.id}: ${item.summary} (success=${item.success})`),
      ''
    ].join('\n');
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, body, 'utf8');
    await fs.rename(temp, file);
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temp, this.file);
  }

  private validCandidate(value: any): value is ImprovementCandidate {
    return Boolean(value && typeof value.id === 'string' && ['knowledge', 'skill', 'strategy', 'code'].includes(value.kind) && typeof value.title === 'string' && typeof value.change === 'string' && Array.isArray(value.evidence) && typeof value.confidence === 'number');
  }
}

function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }
function slug(value: string): string { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function parseJson(value: string): any {
  const text = String(value || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch { const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} } return null; }
}
