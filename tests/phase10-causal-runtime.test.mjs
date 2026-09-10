import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SelfImprovementEngine } from '../dist/agent/self-improvement.js';
import '../dist/agent/causal-runtime.js';
import { recordSkillUsage } from '../dist/agent/skill-attribution.js';
import { MemoryStore } from '../dist/core/memory.js';
import { SkillStore } from '../dist/core/skills.js';

test('phase10 runtime: one successful skill reuse remains insufficient for causal credit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
  try {
    const engine = new SelfImprovementEngine({ stateDir: dir, memoryStore: new MemoryStore(dir), skillStore: new SkillStore(dir), model: null, apply: true, minConfidence: 0.8, minEvidence: 2 });
    const first = await engine.observe({ goal: 'verify test file', success: true, evidence: [{ id: 'e1', type: 'tool', summary: 'write success', success: true }, { id: 'e2', type: 'tool', summary: 'read verification', success: true }], skillsUsed: ['learned-existing'] });
    const candidate = first.find(item => item.kind === 'skill');
    assert.ok(candidate);
    assert.equal(candidate.status, 'promoted');
    recordSkillUsage(undefined, [candidate.targetSkill], 'step-1', true);
    const result = await engine.evaluateGoalOutcome('verify test file', true, [{ id: 'e3', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    assert.deepEqual(result.improved, []);
    assert.ok(result.insufficientData.includes(candidate.id));
    assert.equal(engine.getStatus().successfulReuse, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phase10 runtime: three skill and three control outcomes earn causal credit once', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
  try {
    const engine = new SelfImprovementEngine({ stateDir: dir, memoryStore: new MemoryStore(dir), skillStore: new SkillStore(dir), model: null, apply: true, minConfidence: 0.8, minEvidence: 2 });
    const first = await engine.observe({ goal: 'publish verified artifact', success: true, evidence: [{ id: 'e1', type: 'tool', summary: 'artifact created', success: true }, { id: 'e2', type: 'tool', summary: 'artifact verified', success: true }], skillsUsed: ['learned-existing'] });
    const candidate = first.find(item => item.kind === 'skill');
    assert.ok(candidate?.targetSkill);

    for (let i = 0; i < 3; i++) {
      recordSkillUsage(undefined, [candidate.targetSkill], `skill-${i}`, true);
      const result = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: `s-${i}-1`, type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
      if (i < 2) assert.equal(result.improved.length, 0);
    }

    for (let i = 0; i < 3; i++) {
      recordSkillUsage(undefined, [], `control-${i}`, true);
      const result = await engine.evaluateGoalOutcome('publish verified artifact', false, [{ id: `c-${i}-1`, type: 'verification', summary: 'control failure', success: false }], [], Date.now() + 1000);
      assert.ok(result.skillScores.length >= 1);
    }

    recordSkillUsage(undefined, [candidate.targetSkill], 'final-skill', true);
    const final = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: 'final-1', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    assert.deepEqual(final.improved, [candidate.id]);
    assert.equal(engine.getStatus().successfulReuse, 1);

    recordSkillUsage(undefined, [candidate.targetSkill], 'repeat-skill', true);
    const repeat = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: 'repeat-1', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    assert.deepEqual(repeat.improved, [candidate.id]);
    assert.equal(engine.getStatus().successfulReuse, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
