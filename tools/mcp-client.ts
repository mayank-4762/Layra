import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

interface JsonRpcResponse { id?: number; result?: any; error?: { code?: number; message?: string; data?: any }; }

/** Minimal MCP stdio client. The server command is configuration, never supplied by the model. */
export class LayraMcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private initialized = false;

  configured(): boolean { return process.env.LAYRA_ALLOW_MCP === 'true' && Boolean(process.env.LAYRA_MCP_SERVER_COMMAND); }

  async listTools(signal?: AbortSignal): Promise<any[]> {
    await this.ensureStarted(signal);
    const result = await this.request('tools/list', {}, signal);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, argumentsValue: Record<string, any> = {}, signal?: AbortSignal): Promise<any> {
    const value = String(name || '').trim();
    if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(value)) throw new Error('Invalid MCP tool name');
    await this.ensureStarted(signal);
    return this.request('tools/call', { name: value, arguments: argumentsValue }, signal);
  }

  stop(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('MCP client stopped')); }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill('SIGTERM');
    this.child = null;
    this.initialized = false;
  }

  private async ensureStarted(signal?: AbortSignal): Promise<void> {
    if (!this.configured()) throw new Error('MCP is disabled; set LAYRA_ALLOW_MCP=true and LAYRA_MCP_SERVER_COMMAND');
    if (this.initialized && this.child && !this.child.killed) return;
    const command = String(process.env.LAYRA_MCP_SERVER_COMMAND);
    const args = this.parseArgs(process.env.LAYRA_MCP_SERVER_ARGS || '[]');
    if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) throw new Error('LAYRA_MCP_SERVER_ARGS must be a JSON string array');
    this.child = spawn(command, args as string[], { cwd: process.cwd(), env: this.safeEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', chunk => this.consume(Buffer.from(chunk)));
    this.child.on('exit', () => { this.initialized = false; this.child = null; });
    this.child.on('error', error => { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); this.initialized = false; });
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'layra', version: '3.0.0' } }, signal);
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private request(method: string, params: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error('MCP server is not running'));
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    const timeoutMs = Math.max(1000, Math.min(120000, Number(process.env.LAYRA_MCP_TIMEOUT_MS || 30000)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, timeoutMs);
      const abort = () => { clearTimeout(timer); this.pending.delete(id); reject(new Error('MCP operation aborted')); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: value => { signal?.removeEventListener('abort', abort); clearTimeout(timer); resolve(value); },
        reject: error => { signal?.removeEventListener('abort', abort); clearTimeout(timer); reject(error); },
        timer
      });
      this.child?.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
      this.child?.stdin.write(payload);
    });
  }

  private notify(method: string, params: Record<string, any>): void {
    if (!this.child?.stdin.writable) return;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8');
    this.child.stdin.write(`Content-Length: ${payload.length}\r\n\r\n`);
    this.child.stdin.write(payload);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf(Buffer.from('\r\n\r\n'));
      if (headerEnd < 0) return;
      const headers = this.buffer.subarray(0, headerEnd).toString('utf8');
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      if (!match) { this.buffer = this.buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      try { this.handle(JSON.parse(body) as JsonRpcResponse); } catch { /* ignore malformed server output */ }
    }
  }

  private handle(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(`MCP error ${message.error.code ?? ''}: ${message.error.message || 'request failed'}`));
    else pending.resolve(message.result);
  }

  private parseArgs(value: string): unknown {
    try { return JSON.parse(value); } catch { throw new Error('LAYRA_MCP_SERVER_ARGS must be valid JSON'); }
  }

  private safeEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const allow = new Set(['PATH','HOME','PWD','OLDPWD','TERM','LANG','LC_ALL','TMPDIR','PREFIX','ANDROID_ROOT','ANDROID_DATA','SHELL','USER','USERNAME','LOGNAME','NODE_PATH']);
    for (const [key, value] of Object.entries(process.env)) if (allow.has(key) || key.startsWith('LAYRA_MCP_')) env[key] = value;
    return env;
  }
}
