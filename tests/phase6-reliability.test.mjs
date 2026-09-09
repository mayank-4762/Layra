import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Phase6ReliabilitySupervisor } = await import('../dist/agent/reliability.js');

function makeState() {
  return {
    id: 'phase6-test-state',
    currentGoal: 'verify reliability',
    currentPlan: [{ id: 'step-1', status: 'completed', description: 'done', tool: 'system.info' }],
    totalActions: 0,
    successRate: 1,
    completedTasks: [],
    failedTasks: [],
    activeTasks: [],
    shortTermMemory: {}
  };
}

test('Phase 6 persists a validated checkpoint and records outcome scores', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layra-phase6-'));
  const checkpointPath = path.join(dir, 'checkpoint.json');
  const state = makeState();
  const agent = { getState: () => state, stop: () => { agent.stopped = true; }, stopped: false };
  const supervisor = new Phase6ReliabilitySupervisor(agent, { checkpointPath, intervalMs: 10 });

  supervisor.start();
  state.completedTasks.push({ id: 't1', description: 'success', assignedTo: 'system.info', status: 'completed' });
  state.failedTasks.push({ id: 't2', description: 'failure', assignedTo: 'system.info', status: 'failed', error: 'expected test failure' });
  state.totalActions = 2;
  state.successRate = 0.5;
  await new Promise(resolve => setTimeout(resolve, 40));
  await supervisor.stop('test_complete');

  assert.equal(supervisor.isRunning(), false);
  assert.equal(fs.existsSync(checkpointPath), true);
  const loaded = supervisor.loadCheckpoint();
  assert.equal(loaded?.schemaVersion, 1);
  assert.equal(loaded?.stateId, 'phase6-test-state');
  assert.equal(loaded?.metrics.completedTasks, 1);
  assert.equal(loaded?.metrics.failedTasks, 1);
  assert.equal(state.shortTermMemory.phase6OutcomeScores.length, 1);
  assert.equal(state.shortTermMemory.phase6OutcomeScores[0].score, 0.5);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase 6 stops execution at the configured action budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layra-phase6-budget-'));
  const state = makeState();
  state.totalActions = 2;
  let stopped = false;
  const agent = { getState: () => state, stop: () => { stopped = true; } };
  const supervisor = new Phase6ReliabilitySupervisor(agent, {
    checkpointPath: path.join(dir, 'checkpoint.json'),
    intervalMs: 10,
    maxTotalActions: 2
  });

  supervisor.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  await supervisor.stop('test_complete');

  assert.equal(stopped, true);
  assert.equal(supervisor.wasStoppedForBudget(), true);
  assert.match(String(state.shortTermMemory.phase6StopReason), /Maximum total actions/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Phase 6 detects a stuck in-progress task', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layra-phase6-stuck-'));
  const state = makeState();
  state.activeTasks = [{ status: 'in_progress', startedAt: new Date(Date.now() - 1000) }];
  let stopped = false;
  const agent = { getState: () => state, stop: () => { stopped = true; } };
  const supervisor = new Phase6ReliabilitySupervisor(agent, {
    checkpointPath: path.join(dir, 'checkpoint.json'),
    intervalMs: 10,
    maxTaskAgeMs: 100
  });

  supervisor.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  await supervisor.stop('test_complete');

  assert.equal(stopped, true);
  assert.match(String(state.shortTermMemory.phase6StopReason), /exceeded maximum age/);
  fs.rmSync(dir, { recursive: true, force: true });
});
