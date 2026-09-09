import { promises as fs } from 'fs';
import path from 'path';
import { createModelClient } from '../config/model-provider';
import { MemoryStore } from '../core/memory';
import { SkillStore } from '../core/skills';
import { assertSafeRelativePath, inspectUntrustedText } from '../core/security';

export type ImprovementKind = 'knowledge' | 'skill' | 'strategy' | 'code';
export type ImprovementStatus = 'proposed' | 'validated' | 'promoted' | 'rejected' | 'rolled_back';

export interface ImprovementEvidence { id: string; type: string; summary: string; success: boolean; }

export interface ImprovementCandidate {
  id: string; kind: ImprovementKind; title: string; rationale: string; change: string;
  evidence: ImprovementEvidence[]; confidence: number; reversible: boolean; status: ImprovementStatus;
  createdAt: string; validatedAt?: string; promotedAt?: string; rollbackOf?: string;
  targetSkill?: string; previousSkillContent?: string | null; sourceGoal?: string;
}

interface ImprovementState {
  version: 3; candidates: ImprovementCandidate[]; promotedCount: number; rejectedCount: number;
  rollbackCount: number; lastRunAt: string | null; successfulReuseCount: number; regressionCount: number;
  lastCuratorRunAt: string | null; reuseEvaluations: number;
}

export interface SelfImprovementOptions {
  stateDir?: string; memoryStore?: MemoryStore; skillStore?: SkillStore;
  model?: { chat(messages: any[], options?: any): Promise<{ content: string }> } | null;
  enabled?: boolean; apply?: boolean; minConfidence?: number; minEvidence?: number; maxCandidates?: number;
}

export interface GoalOutcomeEvaluation {
  evaluated: string[];
  improved: string[];
  regressed: string[];
}

/** Native Layra closed learning loop: observe -> diagnose -> propose -> validate -> promote -> measure -> reuse/rollback. */
export class SelfImprovementEngine {
  private readonly stateDir: string;
  private readonly file: string;
  private readonly improvementsDir: string;
  private readonly backupsDir: string;
  private readonly memory: MemoryStore;
  private readonly skills: SkillStore;
  private readonly model: SelfImprovementOptions['model'];
  private readonly enabled: boolean;
  private readonly apply: boolean;
  private readonly minConfidence: number;
  private readonly minEvidence: number;
  private readonly maxCandidates: number;
  private state: ImprovementState = {
    version: 3, candidates: [], promotedCount: 0, rejectedCount: 0, rollbackCount: 0,
    lastRunAt: null, successfulReuseCount: 0, regressionCount: 0, lastCuratorRunAt: null, reuseEvaluations: 0
  };
  private loaded = false;

  constructor(options: SelfImprovementOptions = {}) {
    this.stateDir = path.resolve(options.stateDir || process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state'));
    this.file = assertSafeRelativePath(this.stateDir, 'self-improvement.json');
    this.improvementsDir = assertSafeRelativePath(this.stateDir, 'improvements');
    this.backupsDir = assertSafeRelativePath(this.stateDir, 'improvement-backups');
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
      if (Array.isArray(parsed?.candidates)) {
        this.state = {
          version: 3,
          candidates: parsed.candidates.filter(this.validCandidate).map(item => ({
            ...item,
            previousSkillContent: item.previousSkillContent ?? null,
            sourceGoal: item.sourceGoal || undefined
          })),
          promotedCount: Number(parsed.promotedCount || 0), rejectedCount: Number(parsed.rejectedCount || 0),
          rollbackCount: Number(parsed.rollbackCount || 0), lastRunAt: parsed.lastRunAt || null,
          successfulReuseCount: Number(parsed.successfulReuseCount || 0), regressionCount: Number(parsed.regressionCount || 0),
          lastCuratorRunAt: parsed.lastCuratorRunAt || null, reuseEvaluations: Number(parsed.reuseEvaluations || 0)
        };
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load self-improvement state: ${error?.message || String(error)}`);
    }
    await fs.mkdir(this.improvementsDir, { recursive: true });
    await fs.mkdir(this.backupsDir, { recursive: true });
    this.loaded = true;
  }

  async observe(input: { goal: string; success: boolean; evidence: ImprovementEvidence[]; failures?: string[]; lessons?: string[]; skillsUsed?: string[]; }): Promise<ImprovementCandidate[]> {
    await this.load();
    if (!this.enabled) return [];
    const evidence = input.evidence.slice(-20);
    let candidates = this.model
      ? await this.modelCandidates(input.goal, input.success, evidence, input.failures || [], input.lessons || [], input.skillsUsed || [])
      : this.deterministicCandidates(input.goal, input.success, evidence, input.failures || [], input.lessons || [], input.skillsUsed || []);

    if (input.success && input.skillsUsed?.length && input.evidence.length >= this.minEvidence && !candidates.some(item => item.kind === 'skill')) {
      candidates = [...candidates, ...this.deterministicCandidates(input.goal, true, evidence, [], input.lessons || [], input.skillsUsed || []).filter(item => item.kind === 'skill')];
    }

    const bounded = candidates.slice(0, this.maxCandidates).map(candidate => this.normalizeCandidate(candidate, evidence, input.goal));
    this.state.candidates.push(...bounded);
    this.state.candidates = this.state.candidates.slice(-200);
    this.state.lastRunAt = new Date().toISOString();
    await this.persist();

    const results: ImprovementCandidate[] = [];
    for (const candidate of bounded) {
      const valid = await this.validate(candidate);
      if (!valid) {
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

  /** Evaluate a completed goal against improvements that were already promoted before this goal began. */
  async evaluateGoalOutcome(goal: string, success: boolean, evidence: ImprovementEvidence[], skillsUsed: string[] = [], startedAt?: string | number): Promise<GoalOutcomeEvaluation> {
    await this.load();
    if (!this.enabled) return { evaluated: [], improved: [], regressed: [] };
    const startMs = typeof startedAt === 'number' ? startedAt : Date.parse(String(startedAt || ''));
    const threshold = Number.isFinite(startMs) ? startMs : Date.now();
    const relevant = this.state.candidates.filter(candidate => candidate.status === 'promoted'
      && candidate.promotedAt
      && Date.parse(candidate.promotedAt) < threshold
      && this.isRelevant(candidate, goal, skillsUsed));
    const outcome: GoalOutcomeEvaluation = { evaluated: [], improved: [], regressed: [] };
    for (const candidate of relevant.slice(-20)) {
      outcome.evaluated.push(candidate.id);
      const reuseImproved = success && evidence.some(item => item.success);
      if (reuseImproved) outcome.improved.push(candidate.id); else outcome.regressed.push(candidate.id);
      await this.recordReuse(candidate.id, reuseImproved);
    }
    this.state.reuseEvaluations += outcome.evaluated.length;
    await this.persist();
    return outcome;
  }

  async validate(candidate: ImprovementCandidate): Promise<boolean> {
    if (!candidate.reversible || candidate.evidence.length < this.minEvidence || candidate.confidence < this.minConfidence) return false;
    const unsafe = inspectUntrustedText(`${candidate.title}\n${candidate.rationale}\n${candidate.change}`);
    if (unsafe.some(item => item.severity === 'high')) return false;
    if (!candidate.change.trim()) return false;

    if (candidate.kind === 'code') {
      return /diff --git\s+a\/|```diff|```patch/i.test(candidate.change)
        && /(?:test|typecheck|build|verify|verification)/i.test(candidate.change)
        && /(?:rollback|revert|restore|previous version)/i.test(candidate.change);
    }

    if (candidate.kind === 'skill') {
      const match = candidate.change.match(/(?:^|\n)\s*name:\s*([a-z0-9][a-z0-9._-]{0,63})\s*$/im);
      const body = candidate.change.replace(/^---[\s\S]*?---\s*/m, '').trim();
      if (!match || !body || !/(^|\n)##\s+Verification\b/im.test(body)) return false;
    }
    return true;
  }

  async promote(candidate: ImprovementCandidate): Promise<boolean> {
    await this.load();
    if (candidate.kind === 'code') return false;
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
      candidate.targetSkill = name;
      candidate.previousSkillContent = existing?.content ?? null;
      if (existing) await this.backupSkill(candidate, existing.content);
      const content = candidate.change.replace(/^---[\s\S]*?---\s*/m, '').trim();
      await this.skills.upsert(name, content, { description: 'Improved workflow learned by Layra.', version: nextSkillVersion(existing?.content), trusted: false });
    }

    candidate.status = 'promoted';
    candidate.promotedAt = new Date().toISOString();
    this.state.promotedCount += 1;
    await this.persist();
    return true;
  }

  async recordReuse(candidateId: string, improved: boolean): Promise<boolean> {
    await this.load();
    const candidate = this.state.candidates.find(item => item.id === candidateId);
    if (!candidate || candidate.status !== 'promoted') return false;
    if (improved) {
      this.state.successfulReuseCount += 1;
      await this.memory.remember({ kind: 'event', content: `Self-improvement ${candidateId} was reused successfully.`, tags: ['self-improvement', 'reuse'], importance: 7, source: candidateId });
    } else {
      this.state.regressionCount += 1;
      await this.rollback(candidateId, 'Post-promotion evaluation regressed.');
    }
    await this.persist();
    return true;
  }

  async rollback(candidateId: string, reason: string): Promise<boolean> {
    await this.load();
    const candidate = this.state.candidates.find(item => item.id === candidateId);
    if (!candidate || candidate.status !== 'promoted') return false;

    if (candidate.kind === 'skill' && candidate.targetSkill) {
      if (candidate.previousSkillContent) {
        await this.skills.upsert(candidate.targetSkill, candidate.previousSkillContent, { description: 'Restored prior Layra skill version.', version: nextSkillVersion(candidate.previousSkillContent), trusted: false });
      } else {
        await this.archiveSkill(candidate.targetSkill, candidate.id);
      }
    }
    await this.memory.remember({ kind: 'event', content: `Self-improvement ${candidateId} rolled back: ${reason}`, tags: ['self-improvement', 'rollback'], importance: 9, source: candidateId });
    candidate.status = 'rolled_back';
    candidate.rollbackOf = reason.slice(0, 500);
    this.state.rollbackCount += 1;
    await this.persist();
    return true;
  }

  async curate(limit = 12): Promise<{ inspected: number; archived: number; duplicates: number; stale: number }> {
    await this.load();
    const skills = await this.skills.list();
    const learned = skills.filter(item => item.name.startsWith('learned-')).slice(0, Math.max(1, limit));
    let archived = 0; let duplicates = 0; let stale = 0;
    const seen = new Map<string, { name: string; content: string }>();
    for (const item of learned) {
      const content = (await this.skills.read(item.name))?.content || '';
      const normalized = normalizeSkillContent(content);
      if (!normalized) continue;
      const existing = seen.get(normalized);
      if (existing) {
        duplicates += 1;
        await this.archiveSkill(item.name, 'duplicate');
        archived += 1;
        continue;
      }
      seen.set(normalized, { name: item.name, content });
      const ageMs = Date.now() - skillMtime(item.path);
      if (ageMs > 1000 * 60 * 60 * 24 * 90) {
        stale += 1;
        await this.memory.remember({ kind: 'event', content: `Learned skill ${item.name} is stale and was flagged for review.`, tags: ['self-improvement', 'curator', 'stale'], importance: 5, source: 'curator' });
      }
    }
    this.state.lastCuratorRunAt = new Date().toISOString();
    await this.persist();
    return { inspected: learned.length, archived, duplicates, stale };
  }

  getStatus() {
    return {
      enabled: this.enabled, apply: this.apply, minConfidence: this.minConfidence, minEvidence: this.minEvidence,
      candidates: this.state.candidates.length, promoted: this.state.promotedCount, rejected: this.state.rejectedCount,
      rolledBack: this.state.rollbackCount, successfulReuse: this.state.successfulReuseCount,
      regressions: this.state.regressionCount, reuseEvaluations: this.state.reuseEvaluations,
      learnedSkills: this.state.candidates.filter(item => item.kind === 'skill' && item.status === 'promoted').length,
      activePromoted: this.state.candidates.filter(item => item.status === 'promoted').length,
      lastRunAt: this.state.lastRunAt, lastCuratorRunAt: this.state.lastCuratorRunAt
    };
  }

  private canAutoPromote(candidate: ImprovementCandidate): boolean {
    return this.apply && candidate.kind !== 'code' && candidate.confidence >= this.minConfidence && candidate.evidence.length >= this.minEvidence;
  }

  private async modelCandidates(goal: string, success: boolean, evidence: ImprovementEvidence[], failures: string[], lessons: string[], skillsUsed: string[]): Promise<Array<Partial<ImprovementCandidate>>> {
    try {
      const response = await this.model!.chat([
        { role: 'system', content: 'You are Layra self-improvement. Analyze evidence only. Propose at most 3 reversible, low-risk improvements. Code candidates are proposal-only and must include a diff/patch plus explicit test, typecheck/build, verification, and rollback boundaries. Prefer reusable knowledge, skills, and strategies. Return strict JSON: {"candidates":[{"kind":"knowledge|skill|strategy|code","title":"","rationale":"","change":"","confidence":0-1,"reversible":true}]}. Skill candidates must include a YAML line `name: learned-name` and a `## Verification` section.' },
        { role: 'user', content: JSON.stringify({ goal, success, evidence, failures, lessons, skillsUsed }) }
      ], { temperature: 0.1, maxTokens: 1600 });
      const parsed = parseJson(response.content);
      return Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    } catch {
      return this.deterministicCandidates(goal, success, evidence, failures, lessons, skillsUsed);
    }
  }

  private deterministicCandidates(goal: string, success: boolean, evidence: ImprovementEvidence[], failures: string[], lessons: string[], skillsUsed: string[]): Array<Partial<ImprovementCandidate>> {
    const out: Array<Partial<ImprovementCandidate>> = [];
    if (!success && failures.length) out.push({ kind: 'knowledge', title: 'Failure pattern', rationale: 'A failure occurred during the goal attempt and should remain available to future planning.', change: `When working on ${goal}, account for this observed failure pattern: ${failures.slice(0, 3).join(' | ')}`, confidence: 0.85, reversible: true });
    if (lessons.length) out.push({ kind: 'knowledge', title: 'Execution lesson', rationale: 'A lesson was derived from observed execution evidence.', change: lessons[0].trim(), confidence: 0.82, reversible: true });
    if (success && evidence.length >= this.minEvidence && skillsUsed.length) {
      const name = `learned-${slug(goal).slice(0, 45) || 'workflow'}`;
      out.push({ kind: 'skill', title: `Reusable workflow: ${goal}`, rationale: 'The workflow produced sufficient evidence for procedural reuse.', change: `name: ${name}\n\n# ${goal}\n\n## Procedure\n${evidence.slice(-8).map((item, index) => `${index + 1}. ${item.summary}`).join('\n')}\n\n## Verification\nConfirm the same goal-specific outcome from fresh evidence; do not infer success from step completion alone.`, confidence: 0.84, reversible: true });
    }
    if (skillsUsed.length >= 2) out.push({ kind: 'strategy', title: 'Prefer previously successful procedures', rationale: 'Existing skills were involved in the observed workflow.', change: `For goals similar to ${goal}, retrieve relevant skills before planning and prefer the procedure with the strongest recent evidence.`, confidence: 0.81, reversible: true });
    return out;
  }

  private normalizeCandidate(candidate: Partial<ImprovementCandidate>, evidence: ImprovementEvidence[], sourceGoal: string): ImprovementCandidate {
    return {
      id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, kind: candidate.kind || 'knowledge',
      title: String(candidate.title || 'Untitled improvement').slice(0, 160), rationale: String(candidate.rationale || '').slice(0, 1200),
      change: String(candidate.change || '').slice(0, 12000), evidence: evidence.slice(-20), confidence: clamp(Number(candidate.confidence ?? 0.5), 0, 1),
      reversible: candidate.reversible !== false, status: 'proposed', createdAt: new Date().toISOString(), targetSkill: candidate.targetSkill,
      previousSkillContent: candidate.previousSkillContent ?? null, sourceGoal: String(candidate.sourceGoal || sourceGoal).slice(0, 500)
    };
  }

  private readonly validCandidate = (candidate: any): candidate is ImprovementCandidate => {
    if (!candidate || typeof candidate !== 'object') return false;
    if (typeof candidate.id !== 'string' || !candidate.id) return false;
    if (!['knowledge', 'skill', 'strategy', 'code'].includes(candidate.kind)) return false;
    if (typeof candidate.title !== 'string' || typeof candidate.rationale !== 'string' || typeof candidate.change !== 'string') return false;
    if (!Array.isArray(candidate.evidence)) return false;
    if (typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return false;
    if (typeof candidate.reversible !== 'boolean') return false;
    if (!['proposed', 'validated', 'promoted', 'rejected', 'rolled_back'].includes(candidate.status)) return false;
    if (typeof candidate.createdAt !== 'string' || !candidate.createdAt) return false;
    return candidate.evidence.every((item: any) => item && typeof item.id === 'string' && typeof item.type === 'string' && typeof item.summary === 'string' && typeof item.success === 'boolean');
  };

  private isRelevant(candidate: ImprovementCandidate, goal: string, skillsUsed: string[]): boolean {
    if (candidate.targetSkill && skillsUsed.includes(candidate.targetSkill)) return true;
    const source = tokenize(candidate.sourceGoal || candidate.title);
    const current = tokenize(goal);
    if (!source.size || !current.size) return false;
    let shared = 0;
    for (const token of current) if (source.has(token)) shared += 1;
    const union = new Set([...source, ...current]).size;
    return shared >= 2 && shared / union >= 0.25;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = JSON.stringify(this.state, null, 2);
    await fs.writeFile(temp, body, 'utf8');
    await fs.rename(temp, this.file);
  }

  private async writeProposal(candidate: ImprovementCandidate): Promise<void> {
    const safe = candidate.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = assertSafeRelativePath(this.improvementsDir, `${safe}.md`);
    const boundary = candidate.kind === 'code'
      ? ['## Validation Boundary', '- Review the proposed diff in isolation.', '- Run typecheck, build, and the relevant test suite in an isolated worktree.', '- Verify the intended behavior from fresh evidence.', '- Revert the isolated change completely on regression.', '']
      : [];
    const body = [`# ${candidate.title}`, '', `- ID: ${candidate.id}`, `- Kind: ${candidate.kind}`, `- Status: ${candidate.status}`, `- Confidence: ${candidate.confidence.toFixed(2)}`, `- Evidence count: ${candidate.evidence.length}`, `- Reversible: ${candidate.reversible}`, `- Source goal: ${candidate.sourceGoal || 'unknown'}`, '', '## Rationale', candidate.rationale, '', '## Proposed Change', candidate.kind === 'code' ? '```diff' : '```text', candidate.change, '```', '', ...boundary, '## Evidence', ...candidate.evidence.map(item => `- ${item.id}: ${item.summary} (success=${item.success})`), ''].join('\n');
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, body, 'utf8');
    await fs.rename(temp, file);
  }

  private async backupSkill(candidate: ImprovementCandidate, content: string): Promise<void> {
    const file = assertSafeRelativePath(this.backupsDir, `${candidate.id}.md`);
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, content, 'utf8');
    await fs.rename(temp, file);
  }

  private async archiveSkill(name: string, reason: string): Promise<void> {
    const skill = await this.skills.read(name);
    if (!skill) return;
    const archiveRoot = assertSafeRelativePath(this.backupsDir, 'archive');
    await fs.mkdir(archiveRoot, { recursive: true });
    const archiveDir = assertSafeRelativePath(archiveRoot, `${name}-${reason}-${Date.now()}`);
    await fs.mkdir(archiveDir, { recursive: true });
    const backupFile = assertSafeRelativePath(archiveDir, 'SKILL.md');
    await fs.writeFile(backupFile, skill.content, 'utf8');
    const sourceDir = path.dirname(skill.path);
    await fs.rm(sourceDir, { recursive: true, force: true });
    await this.memory.remember({ kind: 'event', content: `Archived learned skill ${name} (${reason}) from the active catalog without losing its content.`, tags: ['self-improvement', 'curator', 'archive'], importance: 6, source: 'curator' });
  }
}

function nextSkillVersion(content?: string): string {
  const match = content?.match(/^version:\s*(\d+)\.(\d+)\.(\d+)/mi);
  if (!match) return '0.1.0';
  const patch = Number(match[3]) + 1;
  return `${Number(match[1])}.${Number(match[2])}.${patch}`;
}
function skillMtime(file: string): number {
  try { return require('fs').statSync(file).mtimeMs; } catch { return Date.now(); }
}
function normalizeSkillContent(content: string): string {
  return content.replace(/^---[\s\S]*?---/m, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function clamp(value: number, min: number, max: number): number { return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min; }
function slug(value: string): string { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function tokenize(value: string): Set<string> {
  const stop = new Set(['the','a','an','and','or','to','of','for','on','in','with','from','then','when','this','that','is','are','be','by','into','your','layra']);
  return new Set(String(value).toLowerCase().split(/[^a-z0-9]+/).filter(item => item.length >= 3 && !stop.has(item)));
}
function parseJson(value: string): any { const text = String(value || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim(); try { return JSON.parse(text); } catch { const start = text.indexOf('{'); const end = text.lastIndexOf('}'); if (start >= 0 && end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch {} } return null; } }
