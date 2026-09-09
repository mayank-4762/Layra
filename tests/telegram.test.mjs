import test from 'node:test';
import assert from 'node:assert/strict';

const { TelegramGateway } = await import('../dist/integrations/telegram.js');

test('Telegram gateway stays disabled without a bot token and allow-list', async () => {
  const gateway = new TelegramGateway({ getStatistics: () => ({}) });
  assert.equal(gateway.isConfigured(), false);
  await gateway.start();
  assert.equal(gateway.isConfigured(), false);
});

test('Telegram gateway requires an explicit allowed user ID', () => {
  const withoutUser = new TelegramGateway({ getStatistics: () => ({}) }, { botToken: 'test-token' });
  assert.equal(withoutUser.isConfigured(), false);

  const withUser = new TelegramGateway({ getStatistics: () => ({}) }, {
    botToken: 'test-token',
    allowedUserIds: new Set([123456789])
  });
  assert.equal(withUser.isConfigured(), true);
  withUser.stop();
});
