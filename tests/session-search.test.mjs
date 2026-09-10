import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import path from 'path';

test('session search retrieves matching durable journal events with a bound', async () => {
  const { searchSessionEvents } = await import('../dist/core/session-search.js');
  const root = `/tmp/layra-session-search-${process.pid}-${Date.now()}`;
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'events.jsonl'), [
    JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', eventType: 'tool_completed', description: 'filesystem read succeeded', data: { path: 'a' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:01:00Z', eventType: 'tool_failed', description: 'web request failed', data: { url: 'x' } }),
    JSON.stringify({ timestamp: '2026-01-01T00:02:00Z', eventType: 'tool_completed', description: 'filesystem write succeeded', data: { path: 'b' } })
  ].join('\n'));
  const results = await searchSessionEvents('filesystem', 1, root);
  assert.equal(results.length, 1);
  assert.match(results[0].description, /filesystem/);
});
