import test from 'node:test';
import assert from 'node:assert/strict';

test('browser and MCP capabilities fail closed when not configured', async () => {
  const { BrowserCdp } = await import('../dist/tools/browser-cdp.js');
  const { LayraMcpClient } = await import('../dist/tools/mcp-client.js');
  const browser = new BrowserCdp();
  if (!process.env.LAYRA_CDP_WS_URL) assert.equal(browser.isConfigured(), false);
  await assert.rejects(() => browser.navigate('http://127.0.0.1:9222'));
  const mcp = new LayraMcpClient();
  if (process.env.LAYRA_ALLOW_MCP !== 'true') await assert.rejects(() => mcp.listTools(), /MCP is disabled/);
  mcp.stop();
});

test('internal delegation remains one runtime and fails without a model instead of spawning another agent', async () => {
  const { LayraDelegator } = await import('../dist/agent/delegation.js');
  const delegator = new LayraDelegator({ getAvailableTools: () => [] }, { execute: async () => ({ success: true, result: null, error: null, executionTime: 0 }) });
  const previousKey = process.env.NVIDIA_API_KEY;
  delete process.env.NVIDIA_API_KEY;
  try {
    const task = await delegator.run('bounded test task', { maxRounds: 1 });
    assert.equal(task.status, 'failed');
    assert.equal(task.result.stoppedReason, 'no_model');
  } finally {
    if (previousKey !== undefined) process.env.NVIDIA_API_KEY = previousKey;
  }
});
