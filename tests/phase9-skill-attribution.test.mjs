import test from 'node:test';
import assert from 'node:assert/strict';
import { attemptedSkills, normalizeSkillRefs, recordSkillUsage, successfulSkills } from '../dist/agent/skill-attribution.js';
import { HybridAgent } from '../dist/agent/agent.js';

const now = '2026-09-09T12:00:00.000Z';

function step(id, skillRefs) {
  return {
    id,
    description: `Execute ${id}`,
    tool: 'system.info',
    parameters: {},
    dependsOn: [],
    estimatedDuration: 1,
    actualDuration: null,
    status: 'pending',
    result: null,
    error: null,
    priority: 1,
    riskLevel: 'low',
    verificationRequired: true,
    expectedOutcome: 'Successful execution',
    skillRefs
  };
}

test('phase9: skill refs are bounded, deduplicated, and restricted to retrieved skills', () => {
  assert.deepEqual(
    normalizeSkillRefs(['learned-a', 'learned-a', 'unknown', 'learned-b', 'learned-c', 'learned-d', 'learned-e'], ['learned-a', 'learned-b', 'learned-c', 'learned-d', 'learned-e']),
    ['learned-a', 'learned-b', 'learned-c', 'learned-d']
  );
});

test('phase9: usage evidence is recorded only after step execution results', () => {
  const afterSuccess = recordSkillUsage(undefined, ['learned-a', 'learned-b'], 'step-1', true, now);
  assert.deepEqual(afterSuccess, [
    { skill: 'learned-a', stepId: 'step-1', success: true, timestamp: now },
    { skill: 'learned-b', stepId: 'step-1', success: true, timestamp: now }
  ]);
  const afterFailure = recordSkillUsage(afterSuccess, ['learned-c'], 'step-2', false, now);
  assert.deepEqual(successfulSkills(afterFailure), ['learned-a', 'learned-b']);
  assert.deepEqual(attemptedSkills(afterFailure), ['learned-a', 'learned-b', 'learned-c']);
});

test('phase9: replan paths retain prior skill execution evidence until goal finalization', async () => {
  const agent = new HybridAgent();
  const state = agent.getState();
  state.currentGoal = 'exercise attribution';

  const session = agent['sessionStore'];
  session.event = async () => {};
  const executor = agent['toolExecutor'];
  executor.executeWithTimeout = async () => ({ success: true, result: { ok: true }, error: null, metadata: { executor: 'test' } });

  await agent['executeStep'](step('step-success', ['learned-execution']));
  assert.deepEqual(state.shortTermMemory.skillExecutionEvidence.map(item => item.skill), ['learned-execution']);
  assert.deepEqual(successfulSkills(state.shortTermMemory.skillExecutionEvidence), ['learned-execution']);

  state.currentPlan = [];
  const next = step('step-success-2', ['learned-execution-2']);
  await agent['executeStep'](next);
  assert.deepEqual(successfulSkills(state.shortTermMemory.skillExecutionEvidence), ['learned-execution', 'learned-execution-2']);
});
