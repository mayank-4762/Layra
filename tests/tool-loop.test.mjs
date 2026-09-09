import test from 'node:test';
import assert from 'node:assert/strict';

test('interactive tool loop executes tools and continues with tool results', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  const calls = [];
  let turn = 0;
  const client = {
    async chatWithTools(messages) {
      turn += 1;
      calls.push(messages.at(-1));
      if (turn === 1) return { content: '', toolCalls: [{ id: 'call_1', name: 'system.time', arguments: {} }], raw: { choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'system.time', arguments: '{}' } }] } }] } };
      return { content: 'Done after observing the tool result.', toolCalls: [], raw: { choices: [{ message: { content: 'Done after observing the tool result.' } }] } };
    }
  };
  const registry = { getAvailableTools: () => [{ name: 'system.time', description: 'time', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true }] };
  const executor = { async execute(name) { assert.equal(name, 'system.time'); return { success: true, result: '2026-01-01T00:00:00.000Z', error: null, executionTime: 1 }; } };
  const result = await runToolLoop([{ role: 'user', content: 'What time is it?' }], registry, executor, { client, maxRounds: 3 });
  assert.equal(result.stoppedReason, 'completed');
  assert.equal(result.toolCalls, 1);
  assert.match(result.content, /Done after observing/);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 1);
});

test('interactive tool loop emits explicit results for calls over the per-round budget', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  const client = {
    async chatWithTools() {
      return { content: '', toolCalls: [
        { id: 'a', name: 'system.time', arguments: {} },
        { id: 'b', name: 'system.time', arguments: {} }
      ], raw: { choices: [{ message: { content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'system.time', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'system.time', arguments: '{}' } }
      ] } }] } };
    }
  };
  const registry = { getAvailableTools: () => [{ name: 'system.time', description: 'time', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true }] };
  const executor = { async execute() { return { success: true, result: 'ok', error: null, executionTime: 1 }; } };
  const result = await runToolLoop([{ role: 'user', content: 'test' }], registry, executor, { client, maxRounds: 1, maxToolCallsPerRound: 1 });
  assert.equal(result.toolCalls, 1);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 2);
  assert.match(result.messages.at(-1).content, /budget exceeded/);
});

test('interactive tool loop honors an already-aborted signal without calling the model', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const client = { async chatWithTools() { called = true; throw new Error('must not call'); } };
  const result = await runToolLoop([{ role: 'user', content: 'stop' }], { getAvailableTools: () => [] }, { execute: async () => { throw new Error('must not execute'); } }, { client, signal: controller.signal });
  assert.equal(result.stoppedReason, 'aborted');
  assert.equal(called, false);
});
