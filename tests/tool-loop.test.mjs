import test from 'node:test';
import assert from 'node:assert/strict';

test('interactive tool loop executes tools and continues with provider-safe tool results', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  const calls = [];
  let turn = 0;
  const client = {
    async chatWithTools(messages) {
      turn += 1;
      calls.push(messages.at(-1));
      if (turn === 1) return { content: '', toolCalls: [{ id: 'call_1', name: 'filesystem.read', arguments: { path: 'x.txt' } }], raw: { choices: [{ message: { content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'filesystem_read', arguments: '{"path":"x.txt"}' } }] } }] } };
      assert.equal(messages.at(-1).role, 'tool');
      assert.equal(messages.at(-1).name, 'filesystem_read');
      return { content: 'Done after observing the tool result.', toolCalls: [], raw: { choices: [{ message: { content: 'Done after observing the tool result.' } }] } };
    }
  };
  const registry = { getAvailableTools: () => [{ name: 'filesystem.read', description: 'Read', parameters: {}, returns: 'string', permissions: ['filesystem.read'], isAvailable: true }] };
  const executor = { async execute(name) { assert.equal(name, 'filesystem.read'); return { success: true, result: 'file contents', error: null, executionTime: 1 }; } };
  const result = await runToolLoop([{ role: 'user', content: 'Read x.txt' }], registry, executor, { client, maxRounds: 3 });
  assert.equal(result.stoppedReason, 'completed');
  assert.equal(result.toolCalls, 1);
  assert.match(result.content, /Done after observing/);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 1);
});

test('interactive tool loop emits explicit provider-safe results for calls over the per-round budget', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  const client = {
    async chatWithTools() {
      return { content: '', toolCalls: [
        { id: 'a', name: 'system.time', arguments: {} },
        { id: 'b', name: 'system.time', arguments: {} }
      ], raw: { choices: [{ message: { content: '', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'system_time', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'system_time', arguments: '{}' } }
      ] } }] } };
    }
  };
  const registry = { getAvailableTools: () => [{ name: 'system.time', description: 'time', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true }] };
  const executor = { async execute() { return { success: true, result: 'ok', error: null, executionTime: 1 }; } };
  const result = await runToolLoop([{ role: 'user', content: 'test' }], registry, executor, { client, maxRounds: 1, maxToolCallsPerRound: 1 });
  assert.equal(result.toolCalls, 1);
  assert.equal(result.messages.filter(m => m.role === 'tool').length, 2);
  assert.equal(result.messages.at(-1).name, 'system_time');
  assert.match(result.messages.at(-1).content, /budget exceeded/);
});

test('interactive tool loop supports long multi-step goals beyond the old 8-round ceiling', async () => {
  const { runToolLoop } = await import('../dist/agent/tool-loop.js');
  let turn = 0;
  const client = {
    async chatWithTools() {
      turn += 1;
      if (turn <= 10) return {
        content: '',
        toolCalls: [{ id: `step_${turn}`, name: 'system.time', arguments: {} }],
        raw: { choices: [{ message: { content: '', tool_calls: [{ id: `step_${turn}`, type: 'function', function: { name: 'system_time', arguments: '{}' } }] } }] }
      };
      return { content: 'Long multi-step goal completed.', toolCalls: [], raw: { choices: [{ message: { content: 'Long multi-step goal completed.' } }] } };
    }
  };
  const registry = { getAvailableTools: () => [{ name: 'system.time', description: 'time', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true }] };
  const executor = { async execute() { return { success: true, result: 'ok', error: null, executionTime: 1 }; } };
  const result = await runToolLoop([{ role: 'user', content: 'Complete a long multi-step workflow' }], registry, executor, { client, maxRounds: 12, maxToolCallsPerRound: 1 });
  assert.equal(result.stoppedReason, 'completed');
  assert.equal(result.rounds, 11);
  assert.equal(result.toolCalls, 10);
  assert.match(result.content, /Long multi-step goal completed/);
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
