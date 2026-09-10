import { CausalEvaluation, CausalSkillEvaluator } from './causal-skill-evaluation';

export interface SkillUsageInput {
  skill: string;
  stepId: string;
  success: boolean;
  timestamp: string;
}

export class CausalSkillBridge {
  constructor(private readonly evaluator: CausalSkillEvaluator) {}

  async recordGoal(
    goal: string,
    success: boolean,
    evidence: Array<{ success: boolean }>,
    skillsAttempted: SkillUsageInput[],
    candidateIdsBySkill: Map<string, string[]>,
  ): Promise<CausalEvaluation[]> {
    const evidenceSuccessRate = evidence.length ? evidence.filter(item => item.success).length / evidence.length : (success ? 1 : 0);
    const skills = Array.from(new Set(skillsAttempted.map(item => item.skill).filter(Boolean)));
    const evaluations: CausalEvaluation[] = [];

    if (skills.length) {
      for (const skill of skills) {
        const candidates = candidateIdsBySkill.get(skill) || [];
        for (const candidateId of candidates) {
          await this.evaluator.recordObservation({
            candidateId,
            skill,
            goal,
            condition: 'skill',
            success,
            evidenceSuccessRate
          });
        }
        // Keep a current evaluation even when no promoted candidate is attached yet.
        if (candidates.length) {
          for (const candidateId of candidates) evaluations.push(await this.evaluator.evaluate(candidateId, skill, goal));
        }
      }
      return evaluations;
    }

    const status = this.evaluator.getStatus();
    if (!status.evaluationGroups) return evaluations;

    // A no-skill comparable run becomes control evidence for promoted candidates relevant to this goal.
    // The bridge cannot infer causality from unrelated candidates, so relevance is delegated to the evaluator's goal class.
    for (const candidateId of candidateIdsBySkill.values()) {
      for (const id of candidateId) {
        // The caller passes only candidates it has already deemed relevant.
        const match = id.includes('::');
        if (!match) continue;
        const [candidate, skill] = id.split('::');
        await this.evaluator.recordObservation({ candidateId: candidate, skill, goal, condition: 'control', success, evidenceSuccessRate });
        evaluations.push(await this.evaluator.evaluate(candidate, skill, goal));
      }
    }
    return evaluations;
  }
}
