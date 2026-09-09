import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

export interface NativeExecutionResult { value: any; metadata: Record<string, any>; }

/**
 * Native execution/control plane derived from OpenClaw-style tool lifecycle concepts.
 * No OpenClaw Gateway or second agent process is required.
 */
export class NativeRuntime {
  readonly workspaceRoot: string;
  private readonly shellTimeoutMs: number;

  constructor(workspaceRoot = process.env.LAYRA_WORKSPACE_ROOT || process.cwd()) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.shellTimeoutMs = Math.max(1000, Number(process.env.LAYRA_SHELL_TIMEOUT_MS || 30000));
  }

  async filesystemRead(input: Record<string, any>): Promise<NativeExecutionResult> {
    const file = this.safePath(String(input.path || ''));
    return { value: await fs.readFile(file, { encoding: (input.encoding || 'utf8') as BufferEncoding }), metadata: { executor: 'native-fs', path: file } };
  }

  async filesystemList(input: Record<string, any>): Promise<NativeExecutionResult> {
    const root = this.safePath(String(input.path || '.'));
    const recursive = Boolean(input.recursive);
    const maxEntries = Math.max(1, Math.min(10000, Number(input.maxEntries || 1000)));
    const result: any[] = [];
    const visit = async (dir: string): Promise<void> => {
      if (result.length >= maxEntries) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (result.length >= maxEntries) break;
        const full = path.join(dir, entry.name);
        const stat = await fs.stat(full);
        result.push({ name: entry.name, path: path.relative(this.workspaceRoot, full) || '.', isDirectory: entry.isDirectory(), size: stat.size, modified: stat.mtime.toISOString() });
        if (recursive && entry.isDirectory()) await visit(full);
      }
    };
    await visit(root);
    return { value: result, metadata: { executor: 'native-fs', recursive, truncated: result.length >= maxEntries } };
  }

  async filesystemWrite(input: Record<string, any>): Promise<NativeExecutionResult> {
    const file = this.safePath(String(input.path || ''));
    await fs.mkdir(path.dirname(file), { recursive: true });
    const content = String(input.content ?? '');
    const temp = `${file}.layra-tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temp, content, { encoding: (input.encoding || 'utf8') as BufferEncoding, mode: 0o600 });
    await fs.rename(temp, file);
    return { value: { path: file, bytes: Buffer.byteLength(content, input.encoding || 'utf8') }, metadata: { executor: 'native-fs' } };
  }

  async shellExecute(input: Record<string, any>, signal?: AbortSignal): Promise<NativeExecutionResult> {
    const command = String(input.command || '').trim();
    if (!command) throw new Error('Command is required');
    if (process.env.LAYRA_ALLOW_SHELL !== 'true') throw new Error('Shell execution disabled; set LAYRA_ALLOW_SHELL=true to enable it');
    this.assertCommandSafe(command);
    const timeoutMs = Math.max(1000, Math.min(this.shellTimeoutMs, Number(input.timeoutMs || this.shellTimeoutMs)));
    const cwd = this.safePath(String(input.cwd || '.'));
    return this.runProcess(command, cwd, timeoutMs, signal);
  }

  async webGet(input: Record<string, any>, signal?: AbortSignal): Promise<NativeExecutionResult> {
    const url = new URL(String(input.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
    const timeoutMs = Math.max(1000, Math.min(60000, Number(input.timeoutMs || 20000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal, headers: { 'User-Agent': 'Layra/3.0' } });
      const text = await response.text();
      return { value: { status: response.status, ok: response.ok, url: response.url, headers: Object.fromEntries(response.headers.entries()), body: text.slice(0, Math.max(1000, Math.min(200000, Number(input.maxBytes || 50000)))) }, metadata: { executor: 'native-http' } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  async webPost(input: Record<string, any>, signal?: AbortSignal): Promise<NativeExecutionResult> {
    if (process.env.LAYRA_ALLOW_WEB_POST !== 'true') throw new Error('HTTP POST disabled; set LAYRA_ALLOW_WEB_POST=true to enable it');
    const url = new URL(String(input.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
    const timeoutMs = Math.max(1000, Math.min(60000, Number(input.timeoutMs || 20000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const body = typeof input.data === 'string' ? input.data : JSON.stringify(input.data ?? null);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Layra/3.0', ...(input.headers || {}) };
      const response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
      const text = await response.text();
      return { value: { status: response.status, ok: response.ok, url: response.url, headers: Object.fromEntries(response.headers.entries()), body: text.slice(0, 200000) }, metadata: { executor: 'native-http' } };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }

  systemInfo(): NativeExecutionResult {
    return { value: { platform: process.platform, arch: process.arch, node: process.version, pid: process.pid, cwd: process.cwd(), workspaceRoot: this.workspaceRoot }, metadata: { executor: 'native-system' } };
  }

  private safePath(input: string): string {
    const candidate = path.resolve(this.workspaceRoot, input || '.');
    const relative = path.relative(this.workspaceRoot, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Access denied: path escapes Layra workspace (${input})`);
    return candidate;
  }

  private assertCommandSafe(command: string): void {
    const denied = [
      /(^|\s)(rm|rmdir)\s+-rf\s+([/\\]|~|\$HOME)/i,
      /(^|\s)mkfs(\.|\s)/i,
      /(^|\s)dd\s+if=/i,
      /(^|\s)shutdown(\s|$)/i,
      /(^|\s)reboot(\s|$)/i,
      /(^|\s)chmod\s+777\s+/i,
      />\s*\/dev\//i,
      /curl\s+[^\n]*\|\s*(sh|bash)/i,
      /wget\s+[^\n]*\|\s*(sh|bash)/i
    ];
    if (denied.some(pattern => pattern.test(command))) throw new Error('Command rejected by Layra execution safety policy');
  }

  private runProcess(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<NativeExecutionResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-lc', command], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); }, timeoutMs);
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 200000) stdout = stdout.slice(-200000); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 200000) stderr = stderr.slice(-200000); });
      child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
      child.once('close', (code, signalName) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) return reject(new Error('Shell execution aborted'));
        if (timedOut) return reject(new Error(`Shell execution timed out after ${timeoutMs}ms`));
        resolve({ value: { code, signal: signalName, stdout, stderr }, metadata: { executor: 'native-shell', cwd } });
      });
    });
  }
}
