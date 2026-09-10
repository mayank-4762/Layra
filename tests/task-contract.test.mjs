import test from 'node:test';
import assert from 'node:assert/strict';

function mockExecutor() {
  let filePresent = true;
  return { execute: async (name, params) => {
    if (name === 'system.info') return { success: true, result: { workspaceRoot: '/w', cwd: '/w' } };
    if (name === 'filesystem.write') return { success: true, result: { bytes: Buffer.byteLength('LAYRA_PRODUCTION_TEST_OK', 'utf8') } };
    if (name === 'filesystem.read') return { success: true, result: 'LAYRA_PRODUCTION_TEST_OK' };
    if (name === 'filesystem.list') return { success: true, result: filePresent ? [{ name: params.path === '.' ? 'layra-production-test.txt' : 'layra-production-test.txt', path: 'layra-production-test.txt', size: 24 }] : [] };
    if (name === 'filesystem.delete') { filePresent = false; return { success: true, result: { deleted: true } }; }
    if (name === 'memory.set') return { success: true, result: { id: 'mem_test_contract' } };
    if (name === 'memory.get') return { success: true, result: [{ id: 'mem_test_contract', content: params.query }] };
    throw new Error(name);
  }};
}

test('verification contract recognizes and enforces the full structured verification prompt', async () => {
  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');
  const prompt = [
    'Run the complete real-world self-verification test.',
    '3. Create exactly:',
    'filename: layra-production-test.txt',
    'contents exactly:',
    'LAYRA_PRODUCTION_TEST_OK',
    '10. Record one durable persistent-memory lesson.',
    '11. Read that newly recorded persistent-memory entry back.'
  ].join('\n');
  const out = await enforceVerificationContract(prompt, mockExecutor(), {}, { rounds: 2, toolCalls: 1 });
  assert.ok(out);
  assert.equal(out.result.passed, true);
  assert.equal(out.result.recognized, true);
  assert.equal(out.result.exactReadBack, 'LAYRA_PRODUCTION_TEST_OK');
  assert.equal(out.result.fileSize, 24);
  assert.equal(out.result.persistentMemoryId, 'mem_test_contract');
  assert.equal(out.result.memoryReadBackVerification, true);
});

test('verification contract tolerates persistent-memory wording and natural file instructions', async () => {
  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');
  const prompt = [
    'Run a complete real-world self verification test.',
    'Create a temporary file named layra-production-test.txt.',
    'The contents must be:',
    'LAYRA_PRODUCTION_TEST_OK',
    'Record a durable persistent memory lesson and read it back.'
  ].join('\n');
  const out = await enforceVerificationContract(prompt, mockExecutor(), {}, { rounds: 0, toolCalls: 0 });
  assert.ok(out);
  assert.equal(out.result.passed, true);
  assert.equal(out.result.recognized, true);
});

test('verification checklist headings trigger the deterministic preflight', async () => {
  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');
  const prompt = `workspace safety:
file creation:
exact read-back contents:
file size:
deletion:
post-deletion verification:
persistent-memory ID:
memory read-back verification:
total tool calls:
total rounds:
entire test passed:

PASS RULE:
PASS only when every step above was actually executed and verified.
Otherwise:
entire test passed: NO`;
  const out = await enforceVerificationContract(prompt, mockExecutor(), {}, { rounds: 0, toolCalls: 0 });
  assert.ok(out);
  assert.equal(out.result.recognized, true);
  assert.equal(out.result.passed, true);
  assert.equal(out.result.toolCalls, 8);
  assert.equal(out.result.rounds, 8);
  assert.match(out.content, /entire test passed: PASS/);
});
