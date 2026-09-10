import test from 'node:test';
import assert from 'node:assert/strict';

test('tool loop preflights a recognized verification contract before calling the model', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  let modelCalled = false;
  let filePresent = true;
  const executor = {
    execute: async (name, params) => {
      if (name === 'system.info') return { success: true, result: { workspaceRoot: '/w', cwd: '/w' } };
      if (name === 'filesystem.write') return { success: true, result: { bytes: 24 } };
      if (name === 'filesystem.read') return { success: true, result: 'LAYRA_PRODUCTION_TEST_OK' };
      if (name === 'filesystem.list') return { success: true, result: filePresent ? [{ name: 'layra-production-test.txt', path: 'layra-production-test.txt', size: 24 }] : [] };
      if (name === 'filesystem.delete') { filePresent = false; return { success: true, result: { deleted: true } }; }
      if (name === 'memory.set') return { success: true, result: { id: 'mem_preflight_test' } };
      if (name === 'memory.get') return { success: true, result: [{ id: 'mem_preflight_test', content: params.query }] };
      throw new Error(`unexpected tool: ${name}`);
    }
  };
  const client = { chatWithTools: async () => { modelCalled = true; throw new Error('model must not be called for deterministic verification'); } };
  const prompt = [
    'Run the complete real-world self-verification test below.',
    'Create exactly this temporary file:',
    'filename: layra-production-test.txt',
    'contents exactly:',
    'LAYRA_PRODUCTION_TEST_OK',
    'Record ONE durable persistent-memory lesson.',
    'Read the newly recorded persistent-memory entry back and verify that it exists.'
  ].join('\n');
  const result = await runToolLoop([{ role: 'user', content: prompt }], {}, executor, { client });
  assert.equal(modelCalled, false);
  assert.equal(result.stoppedReason, 'completed');
  assert.match(result.content, /entire test passed: PASS/);
  assert.equal(result.rounds, 7);
  assert.equal(result.toolCalls, 8);
});
