import test from 'node:test';
import assert from 'node:assert/strict';


test('scheduler persists one-shot and recurring jobs', async () => {
  const { LayraScheduler } = await import('../dist/agent/scheduler.js');
  const root = `/tmp/layra-phase3-${process.pid}-${Date.now()}`;
  const scheduler = new LayraScheduler(root);
  const one = await scheduler.add('one-shot task', new Date(Date.now() - 1000));
  const recurring = await scheduler.add('recurring task', new Date(Date.now() - 1000), 10_000);
  const due = await scheduler.due();
  assert.equal(due.length, 2);
  await scheduler.markRun(one.id);
  await scheduler.markRun(recurring.id);
  const jobs = await scheduler.list();
  assert.equal(jobs.find(job => job.id === one.id).enabled, false);
  assert.equal(jobs.find(job => job.id === recurring.id).enabled, true);
  scheduler.stop();
});

test('scheduler rejects invalid jobs', async () => {
  const { LayraScheduler } = await import('../dist/agent/scheduler.js');
  const scheduler = new LayraScheduler(`/tmp/layra-phase3-invalid-${process.pid}-${Date.now()}`);
  await assert.rejects(() => scheduler.add('', 'not-a-date'));
  scheduler.stop();
});
