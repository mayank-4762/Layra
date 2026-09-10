import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CausalSkillEvaluator } from '../dist/agent/causal-skill-evaluation.js';

test('phase10: one successful skill reuse is inconclusive and cannot earn causal credit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-'));
  try {
    const evaluator = new CausalSkillEvaluator(dir);
    const result = await evaluator.recordObservation({ candidateId: 'c1', skill: 'learned-test', goal: 'test file recovery', condition: 'skill', success: true, evidenceSuccessRate: 1 });
    assert.equal(result.verdict, 'inconclusive');
    assert.equal(result.sampleSkill, 1);
    assert.equal(result.sampleControl, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phase10: repeated comparable skill/control observations produce an improvement verdict', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-'));
  try {
    const evaluator = new CausalSkillEvaluator(dir);
    for (let i = 0; i < 3; i++) {
      await evaluator.recordObservation({ candidateId: 'c2', skill: 'learned-test', goal: 'test file recovery', condition: 'skill', success: true, evidenceSuccessRate: 1 });
      await evaluator.recordObservation({ candidateId: 'c2', skill: 'learned-test', goal: 'test file recovery', condition: 'control', success: false, evidenceSuccessRate: 0 });
    }
    const result = await evaluator.evaluate('c2', 'learned-test', 'test file recovery');
    assert.equal(result.verdict, 'improved');
    assert.equal(result.sampleSkill, 3);
    assert.equal(result.sampleControl, 3);
    assert.ok(result.effectSize >= 0.15);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('phase10: mixed or weak differences remain inconclusive rather than triggering rollback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-'));
  try {
    const evaluator = new CausalSkillEvaluator(dir);
    const skillOutcomes = [true, false, true];
    const controlOutcomes = [true, true, false];
    for (let i = 0; i < 3; i++) {
      await evaluator.recordObservation({ candidateId: 'c3', skill: 'learned-test', goal: 'publish article', condition: 'skill', success: skillOutcomes[i], evidenceSuccessRate: skillOutcomes[i] ? 1 : 0.5 });
      await evaluator.recordObservation({ candidateId: 'c3', skill: 'learned-test', goal: 'publish article', condition: 'control', success: controlOutcomes[i], evidenceSuccessRate: controlOutcomes[i] ? 1 : 0.5 });
    }
    const result = await evaluator.evaluate('c3', 'learned-test', 'publish article');
    assert.equal(result.verdict, 'inconclusive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
