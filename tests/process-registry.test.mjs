import test from 'node:test';
import assert from 'node:assert/strict';

test('background process registry starts, polls, waits, and retains bounded output', async () => {
  const { ProcessRegistry } = await import('../dist/tools/process-registry.js');
  const registry = new ProcessRegistry();
  const started = registry.start('printf "hello"', process.cwd(), { PATH: process.env.PATH || '' });
  assert.match(started.id, /^proc_/);
  const done = await registry.wait(started.id, 5000);
  assert.equal(done.status, 'completed');
  assert.match(done.output, /hello/);
  assert.equal(registry.poll(started.id).status, 'completed');
});

test('background process registry can kill a running process', async () => {
  const { ProcessRegistry } = await import('../dist/tools/process-registry.js');
  const registry = new ProcessRegistry();
  const started = registry.start('sleep 10', process.cwd(), { PATH: process.env.PATH || '' });
  const killed = registry.kill(started.id);
  assert.equal(killed.status, 'killed');
  await registry.wait(started.id, 3000);
  assert.equal(registry.poll(started.id).status, 'killed');
});
