import test from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../config/model-provider.ts';

function clearLayraProviderEnv() {
  for (const key of [
    'LAYRA_MODEL_NAME', 'LAYRA_MODEL', 'LAYRA_MODEL_PROVIDER',
    'LAYRA_MODEL_API_KEY_ENV', 'LAYRA_MODEL_API_ENDPOINT',
    'LAYRA_MODEL_TEMPERATURE', 'LAYRA_MODEL_MAX_TOKENS', 'CUSTOM_MODEL_KEY'
  ]) delete process.env[key];
}

test('provider defaults are configurable and preserve a usable default', async () => {
  clearLayraProviderEnv();
  const { getModelConfig, createModelClient } = await import(MODULE);
  const config = getModelConfig();
  assert.equal(config.provider, 'nvidia');
  assert.equal(config.apiKeyEnv, 'NVIDIA_API_KEY');
  assert.ok(config.apiEndpoint.startsWith('https://'));
  assert.ok(config.model.length > 0);
  assert.equal(createModelClient(), null);
});

test('provider can be switched without changing Layra core code', async () => {
  const { getModelConfig, createModelClient } = await import(MODULE);
  process.env.LAYRA_MODEL_PROVIDER = 'custom';
  process.env.LAYRA_MODEL_API_KEY_ENV = 'CUSTOM_MODEL_KEY';
  process.env.LAYRA_MODEL_API_ENDPOINT = 'https://example.test/v1/chat/completions';
  process.env.LAYRA_MODEL = 'custom/model';
  process.env.CUSTOM_MODEL_KEY = 'test-key';

  const config = getModelConfig();
  assert.equal(config.provider, 'custom');
  assert.equal(config.apiKeyEnv, 'CUSTOM_MODEL_KEY');
  assert.equal(config.model, 'custom/model');
  assert.equal(config.apiEndpoint, 'https://example.test/v1/chat/completions');
  const client = createModelClient();
  assert.equal(client?.provider, 'custom');
  assert.equal(client?.defaultModel, 'custom/model');
  clearLayraProviderEnv();
});
