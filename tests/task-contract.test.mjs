import test from 'node:test';
import assert from 'node:assert/strict';

test('verification contract recognizes and enforces the full structured verification prompt', async () => {
  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');
  const prompt = [
    'Run the complete real-world self-verification test.',
    '',
    'Do NOT assume success.',
    'Do NOT substitute filenames, contents, or steps.',
    'Do NOT claim PASS unless every required postcondition is actually verified.',
    '',
    '1. Identify the current Layra workspace path.',
    '2. Verify the workspace is inside Layra\'s allowed workspace/sandbox.',
    '',
    '3. Create exactly:',
    'filename: layra-production-test.txt',
    'contents exactly:',
    'LAYRA_PRODUCTION_TEST_OK',
    '',
    '4. Read the file back.',
    '5. Verify the contents are byte-for-byte identical.',
    '',
    '6. Inspect the file metadata.',
    '7. Verify its exact filesystem size.',
    '',
    '8. Delete exactly:',
    'layra-production-test.txt',
    '',
    '9. Independently verify that the file no longer exists.',
    '',
    '10. Record one durable persistent-memory lesson describing the creation, exact read-back verification, metadata/size check, deletion, and post-deletion verification.',
    '',
    '11. Read that newly recorded persistent-memory entry back.',
    '12. Verify that it actually exists and contains the lesson.',
    '',
    '13. Produce ONLY an evidence-based final report.'
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
  assert.ok(out, 'structured prompt must be recognized');
  assert.equal(out.result.passed, true);
  assert.equal(out.result.recognized, true);
  assert.equal(out.result.workspaceSafe, true);
  assert.equal(out.result.fileCreation, true);
  assert.equal(out.result.exactReadBack, 'LAYRA_PRODUCTION_TEST_OK');
  assert.equal(out.result.fileSize, 24);
  assert.equal(out.result.deletion, true);
  assert.equal(out.result.postDeletionVerification, true);
  assert.equal(out.result.persistentMemoryId, 'mem_test_contract');
  assert.equal(out.result.memoryReadBackVerification, true);
  assert.equal(out.result.unsupportedClaimsBlocked, true);
});
