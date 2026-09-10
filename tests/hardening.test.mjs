import test from 'node:test';
import assert from 'node:assert/strict';

test('DHS verifier fails closed without DeepSeek instead of equating task completion with goal completion', async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const { DHSIntelligence } = await import('../dist/intelligence/dhs.js');
    const dhs = new DHSIntelligence({ currentGoal: 'prove goal', longTermMemory: {} }, {});
    const result = await dhs.verifyGoal('prove goal', [{ status: 'completed', error: null, result: { unrelated: true } }]);
    assert.equal(result.achieved, false);
    assert.match(result.reason, /not sufficient|unavailable|evidence/i);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test('MCP discovery creates first-class model-visible tools behind the MCP permission', async () => {
  const { ToolRegistry } = await import('../dist/tools/registry.js');
  const registry = new ToolRegistry({});
  process.env.LAYRA_ALLOW_MCP = 'true';
  process.env.LAYRA_MCP_SERVER_COMMAND = 'node';
  registry.grantBasicPermissions('test');
  const added = registry.registerMcpTools([{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }]);
  assert.equal(added.length, 1);
  assert.equal(registry.isToolAvailable(added[0]), true);
  assert.equal(registry.resolveMcpTool(added[0]), 'echo');
  delete process.env.LAYRA_ALLOW_MCP;
  delete process.env.LAYRA_MCP_SERVER_COMMAND;
});

test('Android bridge stays disabled by default', async () => {
  const previous = process.env.LAYRA_ALLOW_ANDROID;
  delete process.env.LAYRA_ALLOW_ANDROID;
  try {
    const { AndroidTermuxBridge } = await import('../dist/tools/android-termux.js');
    const bridge = new AndroidTermuxBridge();
    assert.equal(bridge.isConfigured(), false);
    await assert.rejects(() => bridge.toast('test'), /Android\/Termux tools disabled/);
  } finally {
    if (previous === undefined) delete process.env.LAYRA_ALLOW_ANDROID;
    else process.env.LAYRA_ALLOW_ANDROID = previous;
  }
});
