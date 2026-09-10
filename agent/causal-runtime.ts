import { CausalEvaluation, CausalSkillEvaluator } from './causal-skill-evaluation';
import { SelfImprovementEngine } from './self-improvement';
import { SkillUsageEvidence } from './skill-attribution';

interface CausalContext {
  originalEvaluate: Function;
  originalRecordReuse: Function;
  active: boolean;
  verdicts: Map<string, CausalEvaluation>;
}

const contexts = new WeakMap<SelfImprovementEngine, CausalContext>();

/**
 * Runtime bridge for causal skill evaluation. It deliberately refuses to let the
 * legacy goal-outcome heuristic award credit: promoted skills need comparable
 * skill-assisted and no-skill control observations first.
 */
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
    const relevant = promoted.filter((candidate: any) => {
      try { return (engine as any).isRelevant(candidate, goal, skillsUsed); } catch { return candidate?.targetSkill && skillsUsed.includes(candidate.targetSkill); }
    }).slice(-20);

    const verdicts = new Map<string, CausalEvaluation>();
    const usage = Array.isArray((engine as any).__lastSkillUsage)
      ? (engine as any).__lastSkillUsage as SkillUsageEvidence[]
      : [];
    const actualSkills = Array.from(new Set(usage.length ? usage.map(item => item.skill) : skillsUsed)).filter(Boolean);
    const evidenceRate = evidence.length ? evidence.filter(item => item.success).length / evidence.length : (success ? 1 : 0);

    if (actualSkills.length) {
      for (const candidate of relevant) {
        if (!actualSkills.includes(candidate.targetSkill)) continue;
        const result = await evaluator.recordObservation({
          candidateId: candidate.id,
          skill: candidate.targetSkill,
          goal,
          condition: 'skill',
          success,
          evidenceSuccessRate: evidenceRate
        });
        verdicts.set(candidate.id, result);
      }
    } else {
      // No skill was executed: use this run as a control observation for relevant promoted candidates.
      for (const candidate of relevant) {
        const result = await evaluator.recordObservation({
          candidateId: candidate.id,
          skill: candidate.targetSkill,
          goal,
          condition: 'control',
          success,
          evidenceSuccessRate: evidenceRate
        });
        verdicts.set(candidate.id, result);
      }
    }

    (engine as any).__lastSkillUsage = undefined;
    contexts.set(engine, { originalEvaluate, originalRecordReuse, active: true, verdicts });

    try {
      const result = await originalEvaluate.call(engine, goal, success, evidence, skillsUsed, startedAt);
      const improved: string[] = [];
      const regressed: string[] = [];
      const neutral: string[] = [];
      const insufficientData: string[] = [];

      for (const [candidateId, verdict] of verdicts) {
        if (verdict.verdict === 'improved') improved.push(candidateId);
        else if (verdict.verdict === 'regressed') regressed.push(candidateId);
        else if (verdict.verdict === 'neutral') neutral.push(candidateId);
        else insufficientData.push(candidateId);
      }

      // Ensure regressions discovered by the causal evaluator trigger rollback even when
      // the legacy heuristic did not include that candidate in its own evaluated set.
      for (const candidateId of regressed) {
        const candidate = promoted.find((item: any) => item.id === candidateId);
        if (candidate && !result.regressed?.includes(candidateId)) {
          await originalRecordReuse.call(engine, candidateId, false);
        }
      }

      return {
        evaluated: Array.from(verdicts.keys()),
        improved,
        regressed,
        neutral,
        insufficientData,
        skillScores: Array.from(verdicts.values())
      };
    } finally {
      contexts.delete(engine);
    }
  };

  proto.recordReuse = async function(candidateId: string, improved: boolean) {
    const engine = this as SelfImprovementEngine;
    const context = contexts.get(engine);
    if (!context?.active) return context ? context.originalRecordReuse.call(engine, candidateId, improved) : originalRecordReuse.call(engine, candidateId, improved);
    const verdict = context.verdicts.get(candidateId);
    if (!verdict || verdict.verdict === 'inconclusive') return false;
    if (verdict.verdict === 'improved') return context.originalRecordReuse.call(engine, candidateId, true);
    if (verdict.verdict === 'regressed') return context.originalRecordReuse.call(engine, candidateId, false);
    return false;
  };
}

// Start monitoring as soon as the module is imported by the CLI.
installCausalSkillEvaluation();
