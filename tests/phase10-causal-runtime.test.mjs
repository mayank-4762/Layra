import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function runIsolated(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || 'isolated causal runtime failed');
  return JSON.parse(result.stdout.trim());
}

test('phase10 runtime: one successful skill reuse remains insufficient for causal credit', () => {
  const result = runIsolated(`
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { SelfImprovementEngine } from './dist/agent/self-improvement.js';
    import './dist/agent/causal-runtime.js';
    import { recordSkillUsage } from './dist/agent/skill-attribution.js';
    import { MemoryStore } from './dist/core/memory.js';
    import { SkillStore } from './dist/core/skills.js';
    const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
    const engine = new SelfImprovementEngine({ stateDir: dir, memoryStore: new MemoryStore(dir), skillStore: new SkillStore(dir), model: null, apply: false, minConfidence: 0.8, minEvidence: 2 });
    const first = await engine.observe({ goal: 'verify test file', success: true, evidence: [{ id: 'e1', type: 'tool', summary: 'write success', success: true }, { id: 'e2', type: 'tool', summary: 'read verification', success: true }], skillsUsed: ['learned-existing'] });
    const candidate = first.find(item => item.kind === 'skill');
    if (!candidate) throw new Error('skill candidate not produced');
    if (!await engine.promote(candidate)) throw new Error('skill candidate did not promote');
    recordSkillUsage(undefined, [candidate.targetSkill], 'step-1', true);
    const result = await engine.evaluateGoalOutcome('verify test file', true, [{ id: 'e3', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    console.log(JSON.stringify({ improved: result.improved, insufficientData: result.insufficientData, successfulReuse: engine.getStatus().successfulReuse }));
    await rm(dir, { recursive: true, force: true });
  `);
  assert.deepEqual(result.improved, []);
  assert.equal(result.successfulReuse, 0);
  assert.equal(result.insufficientData.length, 1);
});

test('phase10 runtime: repeated comparable skill/control outcomes earn causal credit once', () => {
  const result = runIsolated(`
    import { mkdtemp, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import path from 'node:path';
    import { SelfImprovementEngine } from './dist/agent/self-improvement.js';
    import './dist/agent/causal-runtime.js';
    import { recordSkillUsage } from './dist/agent/skill-attribution.js';
    import { MemoryStore } from './dist/core/memory.js';
    import { SkillStore } from './dist/core/skills.js';
    const dir = await mkdtemp(path.join(tmpdir(), 'layra-causal-runtime-'));
    const engine = new SelfImprovementEngine({ stateDir: dir, memoryStore: new MemoryStore(dir), skillStore: new SkillStore(dir), model: null, apply: false, minConfidence: 0.8, minEvidence: 2 });
    const first = await engine.observe({ goal: 'publish verified artifact', success: true, evidence: [{ id: 'e1', type: 'tool', summary: 'artifact created', success: true }, { id: 'e2', type: 'tool', summary: 'artifact verified', success: true }], skillsUsed: ['learned-existing'] });
    const candidate = first.find(item => item.kind === 'skill');
    if (!candidate?.targetSkill) throw new Error('skill candidate not produced');
    if (!await engine.promote(candidate)) throw new Error('skill candidate did not promote');

    for (let i = 0; i < 3; i++) {
      recordSkillUsage(undefined, [candidate.targetSkill], 'skill-' + i, true);
      const current = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: 's-' + i, type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
      if (current.improved.length) throw new Error('causal credit arrived before controls');
    }

    for (let i = 0; i < 3; i++) {
      recordSkillUsage(undefined, [], 'control-' + i, true);
      const current = await engine.evaluateGoalOutcome('publish verified artifact', false, [{ id: 'c-' + i, type: 'verification', summary: 'control failure', success: false }], [], Date.now() + 1000);
      if (current.improved.length || current.regressed.length) throw new Error('control run changed skill lifecycle');
    }

    recordSkillUsage(undefined, [candidate.targetSkill], 'final-skill', true);
    const firstVerdict = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: 'final', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    const creditedOnce = engine.getStatus().successfulReuse;
    recordSkillUsage(undefined, [candidate.targetSkill], 'repeat-skill', true);
    const repeatVerdict = await engine.evaluateGoalOutcome('publish verified artifact', true, [{ id: 'repeat', type: 'verification', summary: 'verified', success: true }], [candidate.targetSkill], Date.now() + 1000);
    console.log(JSON.stringify({ firstImproved: firstVerdict.improved, firstRegressed: firstVerdict.regressed, repeatImproved: repeatVerdict.improved, successfulReuse: engine.getStatus().successfulReuse, rolledBack: engine.getStatus().rolledBack }));
    await rm(dir, { recursive: true, force: true });
  `);
  assert.equal(result.firstImproved.length, 1);
  assert.equal(result.firstRegressed.length, 0);
  assert.equal(result.repeatImproved.length, 1);
  assert.equal(result.successfulReuse, 1);
});
