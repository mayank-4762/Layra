export interface SkillUsageEvidence {
  skill: string;
  stepId: string;
  success: boolean;
  timestamp: string;
}

const MAX_SKILL_REFS_PER_STEP = 4;

/** Process-local snapshot used only for goal-finalization attribution. The persisted source of truth remains AgentState. */
export let latestSkillUsageEvidence: SkillUsageEvidence[] = [];

export function clearLatestSkillUsageEvidence(): void {
  latestSkillUsageEvidence = [];
}

/** Keep model-provided skill references bounded and, when supplied, limited to skills actually retrieved for the goal. */
export function normalizeSkillRefs(refs: unknown, allowed?: Iterable<string>): string[] {
  if (!Array.isArray(refs)) return [];
  const allowedSet = allowed ? new Set(Array.from(allowed, String)) : null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of refs) {
    const skill = String(value || '').trim();
    if (!skill || seen.has(skill)) continue;
    if (allowedSet && !allowedSet.has(skill)) continue;
    seen.add(skill);
    result.push(skill);
    if (result.length >= MAX_SKILL_REFS_PER_STEP) break;
  }
  return result;
}

/** Record the skill references attached to a step only after that step actually reaches a tool result. */
export function recordSkillUsage(
  existing: SkillUsageEvidence[] | undefined,
  refs: unknown,
  stepId: string,
  success: boolean,
  timestamp = new Date().toISOString()
): SkillUsageEvidence[] {
  const boundedRefs = normalizeSkillRefs(refs);
  const next = Array.isArray(existing) ? existing.slice(-100) : [];
  if (!boundedRefs.length) {
    latestSkillUsageEvidence = next;
    return next;
  }
  for (const skill of boundedRefs) next.push({ skill, stepId, success, timestamp });
  latestSkillUsageEvidence = next.slice(-100);
  return latestSkillUsageEvidence;
}

export function successfulSkills(records: SkillUsageEvidence[] | undefined): string[] {
  return Array.from(new Set((records || []).filter(record => record.success).map(record => record.skill)));
}

export function attemptedSkills(records: SkillUsageEvidence[] | undefined): string[] {
  return Array.from(new Set((records || []).map(record => record.skill)));
}
