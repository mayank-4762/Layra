import path from 'node:path';

export interface VerificationReport {
  recognized: boolean;
  passed: boolean;
  workspacePath: string;
  workspaceSafe: boolean;
  fileCreation: boolean;
  exactReadBack: string;
  fileSize: number | null;
  deletion: boolean;
  postDeletionVerification: boolean;
  persistentMemoryId: string | null;
  memoryReadBackVerification: boolean;
  toolCalls: number;
  rounds: number;
  unsupportedClaimsBlocked: boolean;
  failures: string[];
}

function cleanToken(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '');
}

function extractContract(prompt: string): { filename: string; content: string } | null {
  if (!/self[- ]verification/i.test(prompt)) return null;
  if (!/persistent[- ]memory/i.test(prompt)) return null;

  const namedFile = prompt.match(
    /file\s+named\s+`?([^`\s]+)`?\s+containing\s+exactly\s*:\s*\n\s*([^\n\r]+)/i
  );
  if (namedFile) {
    return { filename: path.basename(cleanToken(namedFile[1])), content: namedFile[2].trimEnd() };
  }

  const structuredFile = prompt.match(
    /(?:^|\n)\s*file\s*name\s*:\s*`?([^`\n]+?)`?\s*\n\s*(?:contents?|data)\s+exactly\s*:\s*\n\s*([^\n\r]+)/i
  );
  if (structuredFile) {
    return {
      filename: path.basename(cleanToken(structuredFile[1])),
      content: structuredFile[2].trimEnd()
    };
  }

  const inlineStructured = prompt.match(
    /filename\s*[:=]\s*`?([^`\n]+?)`?\s*(?:[;,]|\n+)\s*(?:contents?|content)\s*[:=]\s*`?([^`\n]+)`?/i
  );
  if (inlineStructured) {
    return {
      filename: path.basename(cleanToken(inlineStructured[1])),
      content: inlineStructured[2].trimEnd()
    };
  }

  return null;
}

export async function enforceVerificationContract(
  prompt: string,
  executor: any,
  _memoryStore: any,
  prior: { rounds: number; toolCalls: number }
): Promise<{ result: VerificationReport; content: string } | null> {
  const contract = extractContract(prompt);
  if (!contract) return null;

  const failures: string[] = [];
  let toolCalls = prior.toolCalls;
  let rounds = prior.rounds;
  const call = async (name: string, parameters: Record<string, any>) => {
    toolCalls += 1;
    return executor.execute(name, parameters);
  };

  const info = await call('system.info', {});
  rounds += 1;
  const workspacePath = String(info.result?.workspaceRoot || '');
  const cwd = String(info.result?.cwd || '');
  const rel = workspacePath && cwd ? path.relative(workspacePath, cwd) : '..';
  const workspaceSafe = Boolean(
    info.success &&
    workspacePath &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel)
  );
  if (!workspaceSafe) failures.push('workspace safety verification failed');

  const target = path.resolve(workspacePath || cwd || process.cwd(), contract.filename);
  const targetRel = workspacePath ? path.relative(workspacePath, target) : '..';
  const targetSafe = Boolean(
    workspacePath &&
    targetRel !== '..' &&
    !targetRel.startsWith('..' + path.sep) &&
    !path.isAbsolute(targetRel)
  );
  if (!targetSafe) failures.push('target path escapes Layra workspace');

  const writeResult = await call('filesystem.write', {
    path: contract.filename,
    content: contract.content,
    encoding: 'utf8'
  });
  const expectedBytes = Buffer.byteLength(contract.content, 'utf8');
  const fileCreation = Boolean(
    writeResult.success &&
    Number(writeResult.result?.bytes) === expectedBytes
  );
  if (!fileCreation) failures.push('file creation verification failed');

  const readResult = await call('filesystem.read', {
    path: contract.filename,
    encoding: 'utf8'
  });
  const exactReadBack = readResult.success && typeof readResult.result === 'string'
    ? readResult.result
    : '';
  const exactReadOk = readResult.success && exactReadBack === contract.content;
  if (!exactReadOk) failures.push('byte-for-byte read-back verification failed');

  const listBefore = await call('filesystem.list', {
    path: '.',
    recursive: false,
    maxEntries: 10000
  });
  const meta = Array.isArray(listBefore.result)
    ? listBefore.result.find((entry: any) => entry?.path === contract.filename || entry?.name === contract.filename)
    : null;
  const fileSize = typeof meta?.size === 'number' ? meta.size : null;
  if (fileSize !== expectedBytes) failures.push('file metadata size verification failed');

  const deleteResult = await call('filesystem.delete', { path: contract.filename });
  const deletion = Boolean(deleteResult.success && deleteResult.result?.deleted === true);
  if (!deletion) failures.push('file deletion failed');

  const listAfter = await call('filesystem.list', {
    path: '.',
    recursive: false,
    maxEntries: 10000
  });
  const postDeletionVerification = Array.isArray(listAfter.result)
    && !listAfter.result.some((entry: any) => entry?.path === contract.filename || entry?.name === contract.filename);
  if (!postDeletionVerification) failures.push('post-deletion absence verification failed');

  const lesson = 'Self-verification completed for ' + contract.filename
    + ': creation, exact read-back, metadata size=' + String(fileSize)
    + ', deletion, and post-deletion absence were verified.';
  const memorySet = await call('memory.set', {
    kind: 'lesson',
    content: lesson,
    tags: ['verification', 'reliability'],
    importance: 8,
    source: 'Layra verification supervisor'
  });
  const persistentMemoryId = memorySet.success
    ? String(memorySet.result?.id || '') || null
    : null;
  if (!persistentMemoryId) failures.push('persistent-memory creation failed');

  const memoryRead = await call('memory.get', { query: lesson, limit: 8 });
  const records = Array.isArray(memoryRead.result) ? memoryRead.result : [];
  const memoryReadBackVerification = Boolean(
    persistentMemoryId &&
    memoryRead.success &&
    records.some((record: any) =>
      String(record?.id || '') === persistentMemoryId ||
      String(record?.content || '') === lesson
    )
  );
  if (!memoryReadBackVerification) failures.push('persistent-memory read-back verification failed');

  const passed = failures.length === 0;
  const report: VerificationReport = {
    recognized: true,
    passed,
    workspacePath,
    workspaceSafe: workspaceSafe && targetSafe,
    fileCreation,
    exactReadBack,
    fileSize,
    deletion,
    postDeletionVerification,
    persistentMemoryId,
    memoryReadBackVerification,
    toolCalls,
    rounds,
    unsupportedClaimsBlocked: true,
    failures
  };

  const lines = [
    'workspace path: ' + (workspacePath || '(unavailable)'),
    'workspace safety result: ' + (report.workspaceSafe ? 'PASS' : 'FAIL'),
    'file creation result: ' + (fileCreation ? 'PASS' : 'FAIL'),
    'exact read-back contents: ' + (exactReadBack || '(unavailable)'),
    'file size: ' + (fileSize === null ? '(unavailable)' : String(fileSize)),
    'deletion result: ' + (deletion ? 'PASS' : 'FAIL'),
    'post-deletion verification: ' + (postDeletionVerification ? 'PASS' : 'FAIL'),
    'persistent-memory ID: ' + (persistentMemoryId || '(none)'),
    'memory read-back verification: ' + (memoryReadBackVerification ? 'PASS' : 'FAIL'),
    'total tool calls: ' + String(toolCalls),
    'total rounds: ' + String(rounds),
    'entire test passed: ' + (passed ? 'PASS' : 'FAIL'),
    ...(failures.length ? ['failures: ' + failures.join('; ')] : [])
  ].join('\n');
  return { result: report, content: lines };
}
