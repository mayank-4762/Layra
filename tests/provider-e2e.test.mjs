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

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

test('OpenAI-compatible model client performs a real local HTTP request and parses the response', async () => {
  const mock = await startMock(async (req, res) => {
    const payload = await readBody(req);
    assert.equal(req.method, 'POST');
    assert.equal(payload.model, 'mock/model');
    assert.equal(payload.messages[0].content, 'hello');
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  });
  const previous = { provider: process.env.LAYRA_MODEL_PROVIDER, env: process.env.LAYRA_MODEL_API_KEY_ENV, endpoint: process.env.LAYRA_MODEL_API_ENDPOINT, model: process.env.LAYRA_MODEL, key: process.env.MOCK_MODEL_KEY };
  process.env.LAYRA_MODEL_PROVIDER = 'mock'; process.env.LAYRA_MODEL_API_KEY_ENV = 'MOCK_MODEL_KEY'; process.env.LAYRA_MODEL_API_ENDPOINT = `${mock.baseUrl}/v1/chat/completions`; process.env.LAYRA_MODEL = 'mock/model'; process.env.MOCK_MODEL_KEY = 'test-key';
  try {
    const { createModelClient } = await import('../dist/config/model-provider.js');
    const client = createModelClient();
    assert.ok(client);
    const result = await client.chat([{ role: 'user', content: 'hello' }], { maxTokens: 10 });
    assert.equal(result.content, 'OK');
  } finally {
    const restore = (key, value) => value === undefined ? delete process.env[key] : (process.env[key] = value);
    restore('LAYRA_MODEL_PROVIDER', previous.provider); restore('LAYRA_MODEL_API_KEY_ENV', previous.env); restore('LAYRA_MODEL_API_ENDPOINT', previous.endpoint); restore('LAYRA_MODEL', previous.model); restore('MOCK_MODEL_KEY', previous.key);
    await stopMock(mock.server);
  }
});

test('DeepSeek client performs a real local HTTP request with JSON response mode', async () => {
  const mock = await startMock(async (req, res) => {
    const payload = await readBody(req);
    assert.equal(payload.model, 'mock-deepseek');
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ insight: 'verified', confidence: 0.9 }) } }] }));
  });
  const { DeepSeekClient } = await import('../dist/deepseek-client.js');
  const client = new DeepSeekClient({ apiKey: 'test-key', baseUrl: mock.baseUrl, model: 'mock-deepseek' });
  try {
    const result = await client.analyze('test evidence', { json: true });
    assert.equal(result.insight, 'verified');
    assert.equal(result.confidence, 0.9);
  } finally {
    await stopMock(mock.server);
  }
});
