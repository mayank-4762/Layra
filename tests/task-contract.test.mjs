import test from 'node:test';
import assert from 'node:assert/strict';

test('verification contract enforces exact execution evidence', async () => {
  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');
  const prompt = [
    'Run the complete real-world self-verification test below.',
    'Create exactly this temporary file:',
    'filename: layra-production-test.txt',
    'contents exactly:',
    'LAYRA_PRODUCTION_TEST_OK',
    'Record ONE durable persistent-memory lesson.',
    'Read the newly recorded persistent-memory entry back and verify that it exists.'
  ].join('\n');
  let filePresent = true;
  const executor = { execute: async (name, params) => {
    if (name === 'system.info') return { success: true, result: { workspaceRoot: '/w', cwd: '/w' } };
    if (name === 'filesystem.write') return { success: true, result: { bytes: 24 } };
    if (name === 'filesystem.read') return { success: true, result: 'LAYRA_PRODUCTION_TEST_OK' };
    if (name === 'filesystem.list') return { success: true, result: filePresent ? [{ name: 'layra-production-test.txt', path: 'layra-production-test.txt', size: 24 }] : [] };
    if (name === 'filesystem.delete') { filePresent = false; return { success: true, result: { deleted: true } }; }
    if (name === 'memory.set') return { success: true, result: { id: 'mem_test_contract' } };
    if (name === 'memory.get') return { success: true, result: [{ id: 'mem_test_contract', content: params.query }] };
    throw new Error(name);
  }};
  const out = await enforceVerificationContract(prompt, executor, {}, { rounds: 2, toolCalls: 1 });
  assert.ok(out);
  assert.equal(out.result.recognized, true);
  assert.equal(out.result.passed, true);
  assert.equal(out.result.workspaceSafe, true);
  assert.equal(out.result.fileCreation, true);
  assert.equal(out.result.exactReadBack, 'LAYRA_PRODUCTION_TEST_OK');
  assert.equal(out.result.fileSize, 24);
  assert.equal(out.result.deletion, true);
  assert.equal(out.result.postDeletionVerification, true);
  assert.equal(out.result.persistentMemoryId, 'mem_test_contract');
  assert.equal(out.result.memoryReadBackVerification, true);
});
