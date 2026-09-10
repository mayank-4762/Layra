import { CausalEvaluation, CausalSkillEvaluator } from './causal-skill-evaluation';
import { SelfImprovementEngine } from './self-improvement';
import { clearLatestSkillUsageEvidence, latestSkillUsageEvidence } from './skill-attribution';

interface CausalContext {
  originalRecordReuse: Function;
  active: boolean;
  verdicts: Map<string, CausalEvaluation>;
  skillAssisted: boolean;
}

const contexts = new WeakMap<SelfImprovementEngine, CausalContext>();

/** Runtime bridge: causal credit requires repeated comparable skill/control evidence. */
export function installCausalSkillEvaluation(): void {
  const proto = SelfImprovementEngine.prototype as any;
  if (proto.__causalSkillInstalled) return;
  proto.__causalSkillInstalled = true;

  const originalEvaluate = proto.evaluateGoalOutcome;
  const originalRecordReuse = proto.recordReuse;

  proto.evaluateGoalOutcome = async function(
    goal: string,
    success: boolean,
    evidence: Array<{ id?: string; type?: string; summary?: string; success: boolean }>,
    skillsUsed: string[] = [],
    startedAt?: string | number
  ) {
    const engine = this as SelfImprovementEngine;
    const state = (engine as any).state;
    const stateDir = (engine as any).stateDir;
    const evaluator = new CausalSkillEvaluator(stateDir);
    await evaluator.load();

    const promoted = Array.isArray(state?.candidates)
      ? state.candidates.filter((candidate: any) => candidate?.status === 'promoted' && candidate?.targetSkill)
      : [];
    const usage = Array.isArray(latestSkillUsageEvidence) ? latestSkillUsageEvidence.slice(-100) : [];
    const actualSkills = Array.from(new Set(usage.map(item => item.skill).filter(Boolean)));
    const relevantSkills = actualSkills.length ? actualSkills : skillsUsed;
    const relevantCandidates = promoted.filter((candidate: any) => {
      try { return candidate?.targetSkill && relevantSkills.includes(candidate.targetSkill) && (engine as any).isRelevant(candidate, goal, relevantSkills); }
      catch { return candidate?.targetSkill && relevantSkills.includes(candidate.targetSkill); }
    }).slice(-20);
    const evidenceRate = evidence.length ? evidence.filter(item => item.success).length / evidence.length : (success ? 1 : 0);
    const verdicts = new Map<string, CausalEvaluation>();

    if (relevantSkills.length) {
      for (const candidate of relevantCandidates) {
        const result = await evaluator.recordObservation({ candidateId: candidate.id, skill: candidate.targetSkill, goal, condition: 'skill', success, evidenceSuccessRate: evidenceRate });
        verdicts.set(candidate.id, result);
      }
    } else {
      const controlCandidates = promoted.filter((candidate: any) => {
        try { return (engine as any).isRelevant(candidate, goal, []); }
        catch { return false; }
      }).slice(-20);
      for (const candidate of controlCandidates) {
        const result = await evaluator.recordObservation({ candidateId: candidate.id, skill: candidate.targetSkill, goal, condition: 'control', success, evidenceSuccessRate: evidenceRate });
        verdicts.set(candidate.id, result);
      }
    }

    contexts.set(engine, { originalRecordReuse, active: true, verdicts, skillAssisted: relevantSkills.length > 0 });
    try {
      await originalEvaluate.call(engine, goal, success, evidence, relevantSkills, startedAt);
      const improved: string[] = [];
      const regressed: string[] = [];
      const insufficientData: string[] = [];
      for (const [candidateId, verdict] of verdicts) {
        if (verdict.verdict === 'improved') improved.push(candidateId);
        else if (verdict.verdict === 'regressed') regressed.push(candidateId);
        else insufficientData.push(candidateId);
      }

      if (contexts.get(engine)?.skillAssisted) {
        for (const candidateId of regressed) {
          const candidate = promoted.find((item: any) => item.id === candidateId);
          if (candidate && candidate.causalLastVerdict !== 'regressed') {
            await originalRecordReuse.call(engine, candidateId, false);
          }
        }
      }

      return { evaluated: Array.from(verdicts.keys()), improved, regressed, neutral: [], insufficientData, skillScores: Array.from(verdicts.values()) };
    } finally {
      contexts.delete(engine);
      clearLatestSkillUsageEvidence();
    }
  };

  proto.recordReuse = async function(candidateId: string, _improved: boolean) {
    const engine = this as SelfImprovementEngine;
    const context = contexts.get(engine);
    if (!context?.active || !context.skillAssisted) return false;
    const verdict = context.verdicts.get(candidateId);
    if (!verdict || verdict.verdict === 'inconclusive') return false;
    const state = (engine as any).state;
    const candidate = Array.isArray(state?.candidates) ? state.candidates.find((item: any) => item.id === candidateId) : null;
    const previous = candidate?.causalLastVerdict;
    if (previous === verdict.verdict) return false;
    if (candidate) candidate.causalLastVerdict = verdict.verdict;
    return context.originalRecordReuse.call(engine, candidateId, verdict.verdict === 'improved');
  };
}

installCausalSkillEvaluation();
