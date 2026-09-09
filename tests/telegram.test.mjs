import test from 'node:test';
import assert from 'node:assert/strict';

const { TelegramGateway } = await import('../dist/integrations/telegram.js');

test('Telegram gateway stays disabled without a bot token', async () => {
  const previous = process.env.LAYRA_TELEGRAM_BOT_TOKEN;
  delete process.env.LAYRA_TELEGRAM_BOT_TOKEN;
  try {
    const gateway = new TelegramGateway({ getStatistics: () => ({}) });
    assert.equal(gateway.isConfigured(), false);
    await gateway.start();
    assert.equal(gateway.isConfigured(), false);
  } finally {
    if (previous === undefined) delete process.env.LAYRA_TELEGRAM_BOT_TOKEN;
    else process.env.LAYRA_TELEGRAM_BOT_TOKEN = previous;
  }
});

test('Telegram gateway recognizes an explicit bot token', () => {
  const gateway = new TelegramGateway({ getStatistics: () => ({}) }, { botToken: 'test-token' });
  assert.equal(gateway.isConfigured(), true);
  gateway.stop();
});
