import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CausalSkillEvaluator } from '../dist/agent/causal-skill-evaluation.js';

test('phase10 runtime: one successful observation remains insufficient for causal credit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
  try {
    const evaluator = new CausalSkillEvaluator(dir);
    const result = await evaluator.recordObservation({ candidateId: 'runtime-c1', skill: 'learned-runtime', goal: 'verify test file', condition: 'skill', success: true, evidenceSuccessRate: 1 });
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.sampleSkill, 1);
    assert.equal(result.sampleControl, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phase10 runtime: repeated comparable skill/control observations earn causal credit exactly at threshold', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
  try {
    const evaluator = new CausalSkillEvaluator(dir);
    for (let i = 0; i < 3; i++) {
      await evaluator.recordObservation({ candidateId: 'runtime-c2', skill: 'learned-runtime', goal: 'publish verified artifact', condition: 'skill', success: true, evidenceSuccessRate: 1 });
      await evaluator.recordObservation({ candidateId: 'runtime-c2', skill: 'learned-runtime', goal: 'publish verified artifact', condition: 'control', success: false, evidenceSuccessRate: 0 });
    }
    const result = await evaluator.evaluate('runtime-c2', 'learned-runtime', 'publish verified artifact');
    assert.equal(result.verdict, 'improved');
    assert.equal(result.sampleSkill, 3);
    assert.equal(result.sampleControl, 3);
    assert.ok(result.effectSize >= 0.15);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
