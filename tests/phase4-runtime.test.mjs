import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

function startMock(handler) {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function stopMock(server) {
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

async function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) { previous[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await fn(); } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

test('Android control client enforces loopback plus pairing token and calls bridge', async () => {
  const mock = await startMock((req, res) => {
    assert.equal(req.headers['x-layra-bridge-token'], 'secret');
    assert.equal(req.url, '/health');
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ success: true, result: { service: 'test-android' } }));
  });
  try {
    const port = new URL(mock.baseUrl).port;
    await withEnv({ LAYRA_ALLOW_ANDROID_CONTROL: 'true', LAYRA_ANDROID_BRIDGE_URL: `http://127.0.0.1:${port}`, LAYRA_ANDROID_BRIDGE_TOKEN: 'secret' }, async () => {
      const { AndroidControlBridge } = await import('../dist/tools/android-control.js');
      const bridge = new AndroidControlBridge();
      assert.equal(bridge.isConfigured(), true);
      assert.deepEqual(await bridge.health(), { service: 'test-android' });
    });
  } finally { await stopMock(mock.server); }
});

test('Android control client rejects remote bridge targets', async () => {
  await withEnv({ LAYRA_ALLOW_ANDROID_CONTROL: 'true', LAYRA_ANDROID_BRIDGE_URL: 'http://192.168.1.10:8765', LAYRA_ANDROID_BRIDGE_TOKEN: 'secret' }, async () => {
    const { AndroidControlBridge } = await import('../dist/tools/android-control.js');
    const bridge = new AndroidControlBridge();
    assert.equal(bridge.isConfigured(), false);
    await assert.rejects(() => bridge.health(), /loopback-only/);
  });
});

test('Browser CDP selects a discovered tab and uses the selected websocket target', async () => {
  class FakeWebSocket {
    static sent = [];
    constructor(url) { this.url = url; this.listeners = {}; setTimeout(() => this.emit('open', {}), 0).unref?.(); }
    addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }
    emit(name, value) { for (const fn of this.listeners[name] || []) fn(value); }
    send(payload) { FakeWebSocket.sent.push({ url: this.url, payload: JSON.parse(payload) }); const request = JSON.parse(payload); setTimeout(() => this.emit('message', { data: JSON.stringify({ id: request.id, result: { ok: true } }) }), 0).unref?.(); }
    close() {}
  }
  const previousWebSocket = globalThis.WebSocket;
  const mock = await startMock((req, res) => {
    assert.equal(req.url, '/json/list');
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify([{ id: 'tab-1', type: 'page', title: 'First', url: 'https://example.com', webSocketDebuggerUrl: 'ws://selected' }, { id: 'tab-2', type: 'page', title: 'Second', url: 'https://other.example', webSocketDebuggerUrl: 'ws://other' }]));
  });
  try {
    globalThis.WebSocket = FakeWebSocket;
    const port = new URL(mock.baseUrl).port;
    await withEnv({ LAYRA_CDP_WS_URL: `ws://127.0.0.1:${port}/devtools/page/default` }, async () => {
      const { BrowserCdp } = await import('../dist/tools/browser-cdp.js');
      const browser = new BrowserCdp();
      const selected = await browser.selectTab('tab-1');
      assert.equal(selected.id, 'tab-1');
      await browser.snapshot();
      assert.equal(FakeWebSocket.sent.at(-1).url, 'ws://selected');
    });
  } finally {
    globalThis.WebSocket = previousWebSocket;
    await stopMock(mock.server);
  }
});
