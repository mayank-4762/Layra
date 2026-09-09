import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { NativeRuntime } = await import('../dist/tools/native-runtime.js');

async function tempWorkspace() {
  return mkdtemp(path.join(tmpdir(), 'layra-test-'));
}

test('native runtime keeps filesystem access inside workspace', async () => {
  const root = await tempWorkspace();
  try {
    await writeFile(path.join(root, 'hello.txt'), 'hello', 'utf8');
    const runtime = new NativeRuntime(root);
    const read = await runtime.filesystemRead({ path: 'hello.txt' });
    assert.equal(read.value, 'hello');
    await assert.rejects(() => runtime.filesystemRead({ path: '../outside.txt' }), /Access denied/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native runtime writes atomically inside workspace', async () => {
  const root = await tempWorkspace();
  try {
    const runtime = new NativeRuntime(root);
    const output = await runtime.filesystemWrite({ path: 'nested/result.txt', content: 'layra' });
    assert.equal(output.value.bytes, 5);
    const read = await runtime.filesystemRead({ path: 'nested/result.txt' });
    assert.equal(read.value, 'layra');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('native runtime blocks shell by default and enforces dangerous command policy', async () => {
  const root = await tempWorkspace();
  const previous = process.env.LAYRA_ALLOW_SHELL;
  try {
    delete process.env.LAYRA_ALLOW_SHELL;
    const runtime = new NativeRuntime(root);
    await assert.rejects(() => runtime.shellExecute({ command: 'echo ok' }), /Shell execution disabled/);
    process.env.LAYRA_ALLOW_SHELL = 'true';
    await assert.rejects(() => runtime.shellExecute({ command: 'rm -rf /' }), /safety policy/);
  } finally {
    if (previous === undefined) delete process.env.LAYRA_ALLOW_SHELL;
    else process.env.LAYRA_ALLOW_SHELL = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('native runtime can abort a shell process', async () => {
  const root = await tempWorkspace();
  const previous = process.env.LAYRA_ALLOW_SHELL;
  try {
    process.env.LAYRA_ALLOW_SHELL = 'true';
    const runtime = new NativeRuntime(root);
    const controller = new AbortController();
    const execution = runtime.shellExecute({ command: 'sleep 10' }, controller.signal);
    setTimeout(() => controller.abort(), 100).unref();
    await assert.rejects(() => execution, /aborted|terminated|signal/i);
  } finally {
    if (previous === undefined) delete process.env.LAYRA_ALLOW_SHELL;
    else process.env.LAYRA_ALLOW_SHELL = previous;
    await rm(root, { recursive: true, force: true });
  }
});
