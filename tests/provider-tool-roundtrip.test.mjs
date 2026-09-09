import test from 'node:test';
import assert from 'node:assert/strict';

const PROTOCOL = '../dist/core/tool-protocol.js';

test('provider tool-call round trip preserves internal and external names', async () => {
  const { toProviderToolName, toInternalToolName, toOpenAICompatibleTools, extractModelTurn } = await import(PROTOCOL);
  const tools = [
    { name: 'filesystem.read', description: 'Read', parameters: {}, returns: 'string', permissions: ['filesystem.read'], isAvailable: true },
    { name: 'browser.select_tab', description: 'Select tab', parameters: {}, returns: 'object', permissions: ['browser.control'], isAvailable: true }
  ];

  const schema = toOpenAICompatibleTools(tools);
  assert.deepEqual(schema.map(tool => tool.function.name), ['filesystem_read', 'browser_select_tab']);
  assert.match(schema[0].function.name, /^[A-Za-z0-9_-]+$/);
  assert.equal(toInternalToolName('filesystem_read', tools), 'filesystem.read');
  assert.equal(toInternalToolName('browser_select_tab', tools), 'browser.select_tab');

  const raw = {
    choices: [{ message: { content: '', tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'filesystem_read', arguments: '{}' } },
      { id: 'call_2', type: 'function', function: { name: 'browser_select_tab', arguments: '{}' } }
    ] } }]
  };
  const turn = extractModelTurn(raw, tools);
  assert.deepEqual(turn.toolCalls.map(call => call.name), ['filesystem.read', 'browser.select_tab']);
  assert.equal(toProviderToolName(turn.toolCalls[0].name), 'filesystem_read');
});
