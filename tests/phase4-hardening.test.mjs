import test from 'node:test';
import assert from 'node:assert/strict';

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('Phase 4 registers Android control and browser target tools only when explicitly enabled', async () => {
  const { ToolRegistry } = await import('../dist/tools/registry.js');
  const { registerAndroidControlTools } = await import('../dist/tools/phase4-tool-registration.js');
  const state = { availableTools: [], toolPermissions: [] };
  const registry = new ToolRegistry({});
  await withEnv({ LAYRA_ALLOW_ANDROID_CONTROL: undefined, LAYRA_ANDROID_BRIDGE_URL: undefined, LAYRA_ANDROID_BRIDGE_TOKEN: undefined, LAYRA_ALLOW_BROWSER: undefined, LAYRA_CDP_WS_URL: undefined }, async () => {
    registerAndroidControlTools(registry, state);
    assert.equal(registry.isToolAvailable('android.control.tap'), false);
    assert.equal(registry.isToolAvailable('browser.select_tab'), false);
  });
  await withEnv({ LAYRA_ALLOW_ANDROID_CONTROL: 'true', LAYRA_ANDROID_BRIDGE_URL: 'http://127.0.0.1:8765', LAYRA_ANDROID_BRIDGE_TOKEN: 'token', LAYRA_ALLOW_BROWSER: 'true', LAYRA_CDP_WS_URL: 'ws://127.0.0.1:9222/devtools/page/x' }, async () => {
    const registry2 = new ToolRegistry({});
    const state2 = { availableTools: [], toolPermissions: [] };
    registerAndroidControlTools(registry2, state2);
    assert.equal(registry2.isToolAvailable('android.control.tap'), true);
    assert.equal(registry2.isToolAvailable('browser.select_tab'), true);
    assert.ok(state2.availableTools.some(tool => tool.name === 'android.control.tap'));
  });
});

test('MCP dynamic registration replaces stale remote tools', async () => {
  const { ToolRegistry } = await import('../dist/tools/registry.js');
  const registry = new ToolRegistry({});
  const first = registry.registerMcpTools([{ name: 'first-tool', description: 'one', inputSchema: { type: 'object' } }]);
  assert.equal(first.length, 1);
  assert.equal(registry.resolveMcpTool(first[0]), 'first-tool');
  const second = registry.registerMcpTools([{ name: 'second-tool', description: 'two', inputSchema: { type: 'object' } }]);
  assert.equal(second.length, 1);
  assert.equal(registry.resolveMcpTool(first[0]), null);
  assert.equal(registry.resolveMcpTool(second[0]), 'second-tool');
});
