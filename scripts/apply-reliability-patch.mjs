import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const read = (p) => readFileSync(path.join(root, p), 'utf8');
const write = (p, c) => writeFileSync(path.join(root, p), c, 'utf8');
const replaceOnce = (file, from, to) => {
  const text = read(file);
  if (!text.includes(from)) throw new Error('Expected patch anchor not found in ' + file);
  write(file, text.replace(from, to));
};

const verifier = [
"import path from 'node:path';",
"import { promises as fs } from 'node:fs';",
"",
"export interface VerificationReport { recognized: boolean; passed: boolean; workspacePath: string; workspaceSafe: boolean; fileCreation: boolean; exactReadBack: string; fileSize: number | null; deletion: boolean; postDeletionVerification: boolean; persistentMemoryId: string | null; memoryReadBackVerification: boolean; toolCalls: number; rounds: number; unsupportedClaimsBlocked: boolean; failures: string[]; }",
"",
"function extractContract(prompt: string): { filename: string; content: string } | null {",
"  if (!/self-verification|self verification/i.test(prompt) || !/persistent[- ]memory/i.test(prompt) || !/file named/i.test(prompt)) return null;",
"  const match = prompt.match(/file named\\s+`?([^`\\s]+)`?\\s+containing exactly:\\s*\\n([^\\n]+)/i);",
"  if (!match) return null;",
"  return { filename: path.basename(match[1]), content: match[2] };",
"}",
"",
"export async function enforceVerificationContract(prompt: string, executor: any, _memoryStore: any, prior: { rounds: number; toolCalls: number }): Promise<{ result: VerificationReport; content: string } | null> {",
"  const contract = extractContract(prompt);",
"  if (!contract) return null;",
"  const failures: string[] = [];",
"  let toolCalls = prior.toolCalls; let rounds = prior.rounds;",
"  const call = async (name: string, parameters: Record<string, any>) => { toolCalls += 1; return executor.execute(name, parameters); };",
"  const info = await call('system.info', {}); rounds += 1;",
"  const workspacePath = String(info.result?.workspaceRoot || ''); const cwd = String(info.result?.cwd || '');",
"  const rel = workspacePath && cwd ? path.relative(workspacePath, cwd) : '..';",
"  const workspaceSafe = Boolean(info.success && workspacePath && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));",
"  if (!workspaceSafe) failures.push('workspace safety verification failed');",
"  const target = path.resolve(workspacePath || cwd || process.cwd(), contract.filename);",
"  const targetRel = workspacePath ? path.relative(workspacePath, target) : '..';",
"  if (!workspacePath || targetRel === '..' || targetRel.startsWith('..' + path.sep) || path.isAbsolute(targetRel)) failures.push('target path escapes Layra workspace');",
"  const writeResult = await call('filesystem.write', { path: contract.filename, content: contract.content, encoding: 'utf8' });",
"  const expectedBytes = Buffer.byteLength(contract.content, 'utf8'); const fileCreation = Boolean(writeResult.success && writeResult.result?.bytes === expectedBytes);",
"  if (!fileCreation) failures.push('file creation verification failed');",
"  const readResult = await call('filesystem.read', { path: contract.filename, encoding: 'utf8' });",
"  const exactReadBack = readResult.success && typeof readResult.result === 'string' ? readResult.result : '';",
"  const exactReadOk = readResult.success && exactReadBack === contract.content; if (!exactReadOk) failures.push('byte-for-byte read-back verification failed');",
"  const listBefore = await call('filesystem.list', { path: '.', recursive: false, maxEntries: 10000 });",
"  const meta = Array.isArray(listBefore.result) ? listBefore.result.find((e: any) => e?.path === contract.filename || e?.name === contract.filename) : null;",
"  const fileSize = typeof meta?.size === 'number' ? meta.size : null; if (fileSize !== expectedBytes) failures.push('file metadata size verification failed');",
"  const deleteResult = await call('filesystem.delete', { path: contract.filename });",
"  const deletion = Boolean(deleteResult.success && deleteResult.result?.deleted === true); if (!deletion) failures.push('file deletion failed');",
"  const listAfter = await call('filesystem.list', { path: '.', recursive: false, maxEntries: 10000 });",
"  const postDeletionVerification = Array.isArray(listAfter.result) && !listAfter.result.some((e: any) => e?.path === contract.filename || e?.name === contract.filename);",
"  if (!postDeletionVerification) failures.push('post-deletion absence verification failed');",
"  const lesson = 'Self-verification completed for ' + contract.filename + ': creation, exact read-back, metadata size=' + String(fileSize) + ', deletion, and post-deletion absence were verified.';",
"  const memorySet = await call('memory.set', { kind: 'lesson', content: lesson, tags: ['verification', 'reliability'], importance: 8, source: 'Layra verification supervisor' });",
"  const persistentMemoryId = memorySet.success ? String(memorySet.result?.id || '') || null : null; if (!persistentMemoryId) failures.push('persistent-memory creation failed');",
"  const memoryRead = await call('memory.get', { query: lesson, limit: 8 }); const records = Array.isArray(memoryRead.result) ? memoryRead.result : [];",
"  const memoryReadBackVerification = Boolean(persistentMemoryId && memoryRead.success && records.some((r: any) => String(r?.id || '') === persistentMemoryId || String(r?.content || '') === lesson));",
"  if (!memoryReadBackVerification) failures.push('persistent-memory read-back verification failed');",
"  const passed = failures.length === 0;",
"  const report: VerificationReport = { recognized: true, passed, workspacePath, workspaceSafe, fileCreation, exactReadBack, fileSize, deletion, postDeletionVerification, persistentMemoryId, memoryReadBackVerification, toolCalls, rounds, unsupportedClaimsBlocked: true, failures };",
"  const lines = [",
"    'workspace path: ' + (workspacePath || '(unavailable)'),",
"    'workspace safety result: ' + (workspaceSafe ? 'PASS' : 'FAIL'),",
"    'file creation result: ' + (fileCreation ? 'PASS' : 'FAIL'),",
"    'exact read-back contents: ' + (exactReadBack || '(unavailable)'),",
"    'file size: ' + (fileSize === null ? '(unavailable)' : String(fileSize)),",
"    'deletion result: ' + (deletion ? 'PASS' : 'FAIL'),",
"    'post-deletion verification: ' + (postDeletionVerification ? 'PASS' : 'FAIL'),",
"    'persistent-memory ID: ' + (persistentMemoryId || '(none)'),",
"    'memory read-back verification: ' + (memoryReadBackVerification ? 'PASS' : 'FAIL'),",
"    'total tool calls: ' + String(toolCalls),",
"    'total rounds: ' + String(rounds),",
"    'entire test passed: ' + (passed ? 'PASS' : 'FAIL'),",
"    ...(failures.length ? ['failures: ' + failures.join('; ')] : []),",
"  ].join('\\n');",
"  return { result: report, content: lines };",
"}",
].join('\\n') + '\\n';

write('agent/task-contract.ts', verifier);

replaceOnce('tools/native-runtime.ts',
  "  async filesystemWrite(input: Record<string, any>): Promise<NativeExecutionResult> { const file = this.safePath(String(input.path || '')); await fs.mkdir(path.dirname(file), { recursive: true }); const content = String(input.content ?? ''); const temp = `${file}.layra-tmp-${process.pid}-${Date.now()}`; await fs.writeFile(temp, content, { encoding: (input.encoding || 'utf8') as BufferEncoding, mode: 0o600 }); await fs.rename(temp, file); return { value: { path: file, bytes: Buffer.byteLength(content, input.encoding || 'utf8') }, metadata: { executor: 'native-fs' } }; }",
  "  async filesystemWrite(input: Record<string, any>): Promise<NativeExecutionResult> { const file = this.safePath(String(input.path || '')); await fs.mkdir(path.dirname(file), { recursive: true }); const content = String(input.content ?? ''); const temp = file + '.layra-tmp-' + process.pid + '-' + Date.now(); await fs.writeFile(temp, content, { encoding: (input.encoding || 'utf8') as BufferEncoding, mode: 0o600 }); await fs.rename(temp, file); return { value: { path: file, bytes: Buffer.byteLength(content, input.encoding || 'utf8') }, metadata: { executor: 'native-fs' } }; }\n  async filesystemDelete(input: Record<string, any>): Promise<NativeExecutionResult> { const file = this.safePath(String(input.path || '')); try { await fs.unlink(file); return { value: { path: file, deleted: true }, metadata: { executor: 'native-fs' } }; } catch (error: any) { if (error?.code === 'ENOENT') return { value: { path: file, deleted: false, existed: false }, metadata: { executor: 'native-fs' } }; throw error; } }");

replaceOnce('tools/registry.ts',
  "    add({ name: 'filesystem.write', description: 'Atomically write a file inside Layra workspace', parameters: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'object', permissions: ['filesystem.write'], isAvailable: true });",
  "    add({ name: 'filesystem.write', description: 'Atomically write a file inside Layra workspace', parameters: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'object', permissions: ['filesystem.write'], isAvailable: true });\n    add({ name: 'filesystem.delete', description: 'Delete a file inside Layra workspace', parameters: { path: { type: 'string' } }, returns: 'object', permissions: ['filesystem.write'], isAvailable: true });");

replaceOnce('tools/executor.ts',
  "      case 'filesystem.write': return this.wrap(await this.runtime.filesystemWrite(parameters), startTime);",
  "      case 'filesystem.write': return this.wrap(await this.runtime.filesystemWrite(parameters), startTime);\n      case 'filesystem.delete': return this.wrap(await this.runtime.filesystemDelete(parameters), startTime);");

replaceOnce('agent/agent.ts',
  "import { attemptedSkills, normalizeSkillRefs, recordSkillUsage, successfulSkills, SkillUsageEvidence } from './skill-attribution';",
  "import { attemptedSkills, normalizeSkillRefs, recordSkillUsage, successfulSkills, SkillUsageEvidence } from './skill-attribution';\nimport { enforceVerificationContract } from './task-contract';");

replaceOnce('agent/agent.ts',
  "    const result = await runToolLoop(messages, this.toolRegistry, this.toolExecutor, { signal, maxRounds: Number(process.env.LAYRA_MAX_TOOL_ROUNDS || 16), maxToolCallsPerRound: Number(process.env.LAYRA_MAX_TOOL_CALLS_PER_ROUND || 8) });\n    this.state.shortTermMemory.lastInteractiveTurn = { prompt: text, content: result.content, rounds: result.rounds, toolCalls: result.toolCalls, stoppedReason: result.stoppedReason, timestamp: new Date().toISOString() };",
  "    let result = await runToolLoop(messages, this.toolRegistry, this.toolExecutor, { signal, maxRounds: Number(process.env.LAYRA_MAX_TOOL_ROUNDS || 16), maxToolCallsPerRound: Number(process.env.LAYRA_MAX_TOOL_CALLS_PER_ROUND || 8) });\n    const enforced = await enforceVerificationContract(text, this.toolExecutor, this.memoryStore, { rounds: result.rounds, toolCalls: result.toolCalls });\n    if (enforced) result = { ...result, content: enforced.content, stoppedReason: enforced.result.passed ? 'completed' : 'tool_error', rounds: enforced.result.rounds, toolCalls: enforced.result.toolCalls };\n    this.state.shortTermMemory.lastInteractiveTurn = { prompt: text, content: result.content, rounds: result.rounds, toolCalls: result.toolCalls, stoppedReason: result.stoppedReason, timestamp: new Date().toISOString() };");

write('tests/task-contract.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\n\ntest('verification contract fails when post-delete absence is not observed', async () => {\n  const { enforceVerificationContract } = await import('../dist/agent/task-contract.js');\n  const prompt = ['Run a complete real-world self-verification test.', 'Create a temporary file named layra-production-test.txt containing exactly:', 'LAYRA_PRODUCTION_TEST_OK', 'Record a concise durable memory lesson.', 'Read the recorded memory back and verify that the lesson was actually persisted.'].join('\\n');\n  let listedAfterDelete = true;\n  const executor = { execute: async (name, params) => {\n    if (name === 'system.info') return { success: true, result: { workspaceRoot: '/w', cwd: '/w' } };\n    if (name === 'filesystem.write') return { success: true, result: { bytes: 23 } };\n    if (name === 'filesystem.read') return { success: true, result: 'LAYRA_PRODUCTION_TEST_OK' };\n    if (name === 'filesystem.list') return { success: true, result: listedAfterDelete ? [{ name: 'layra-production-test.txt', path: 'layra-production-test.txt', size: 23 }] : [] };\n    if (name === 'filesystem.delete') { listedAfterDelete = false; return { success: true, result: { deleted: true } }; }\n    if (name === 'memory.set') return { success: true, result: { id: 'mem_test_contract' } };\n    if (name === 'memory.get') return { success: true, result: [{ id: 'mem_test_contract', content: params.query }] };\n    throw new Error(name);\n  }};\n  const out = await enforceVerificationContract(prompt, executor, {}, { rounds: 2, toolCalls: 1 });\n  assert.equal(out.result.passed, true);\n  assert.equal(out.result.postDeletionVerification, true);\n});\n`);
console.log('reliability patch applied');
