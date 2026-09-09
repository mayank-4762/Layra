import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repo = process.cwd();

async function nodeModuleTest() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'layra-memory-'));
  const previous = {
    state: process.env.LAYRA_STATE_DIR,
    memory: process.env.LAYRA_MEMORY_DIR,
    vault: process.env.LAYRA_VAULT_DIR
  };
  process.env.LAYRA_STATE_DIR = root;
  process.env.LAYRA_MEMORY_DIR = path.join(root, 'docs');
  process.env.LAYRA_VAULT_DIR = path.join(root, 'vault');
  try {
    const { MemoryStore } = await import(path.join(repo, 'dist/core/memory.js'));
    const store = new MemoryStore(root);
    const first = await store.remember({ kind: 'lesson', content: 'Browser verification should happen after every external action.', tags: ['browser', 'verification'], importance: 9, source: 'test' });
    assert.ok(first.vaultPath?.startsWith('Memory/lesson/'));
    const duplicate = await store.remember({ kind: 'lesson', content: 'Browser verification should happen after every external action.', tags: ['browser'], importance: 7, source: 'test-2' });
    assert.equal(duplicate.id, first.id);
    const related = await store.remember({ kind: 'procedure', content: 'Use browser verification after external actions.', tags: ['browser', 'verification'], importance: 8, source: 'test' });
    const neighbors = await store.related(first.id, 5);
    assert.ok(neighbors.some(item => item.id === related.id));
    const results = await store.search('browser verification', 5);
    assert.equal(results[0].id, first.id);
    await store.consolidate();
    const index = await readFile(path.join(root, 'vault', 'Memory', 'Index.md'), 'utf8');
    assert.match(index, /Browser verification/);
    const memoryFile = await readFile(path.join(root, 'vault', 'Memory', 'lesson', `${first.id}.md`), 'utf8');
    assert.match(memoryFile, /type: "lesson"/);
    assert.match(memoryFile, /Related: \[\[mem_/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key === 'state' ? 'LAYRA_STATE_DIR' : key === 'memory' ? 'LAYRA_MEMORY_DIR' : 'LAYRA_VAULT_DIR'];
      else process.env[key === 'state' ? 'LAYRA_STATE_DIR' : key === 'memory' ? 'LAYRA_MEMORY_DIR' : 'LAYRA_VAULT_DIR'] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

await execFileAsync(process.execPath, ['-e', "import('./dist/core/memory.js').then(()=>console.log('memory module ok'))"], { cwd: repo });
await nodeModuleTest();
console.log('phase5-memory: ok');
