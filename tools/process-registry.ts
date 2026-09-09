import { ChildProcessByStdio, Readable, spawn } from 'child_process';
import path from 'path';

export type ProcessStatus = 'running' | 'completed' | 'failed' | 'killed';
export interface ProcessSnapshot { id: string; command: string; cwd: string; status: ProcessStatus; pid?: number; exitCode?: number | null; signal?: NodeJS.Signals | null; output: string; truncated: boolean; startedAt: string; endedAt?: string; }
interface Session { id: string; command: string; cwd: string; child: ChildProcessByStdio<null, Readable, Readable>; status: ProcessStatus; output: string; truncated: boolean; startedAt: number; endedAt?: number; exitCode?: number | null; signal?: NodeJS.Signals | null; expiresAt?: number; }

/** Bounded foreground/background process lifecycle adapted from OpenClaw's process-session model. */
export class ProcessRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly maxOutputChars: number;
  private readonly ttlMs: number;
  constructor() { this.maxOutputChars = Math.max(10_000, Math.min(2_000_000, Number(process.env.LAYRA_PROCESS_MAX_OUTPUT_CHARS || 200_000))); this.ttlMs = Math.max(60_000, Math.min(3_600_000, Number(process.env.LAYRA_PROCESS_TTL_MS || 1_800_000))); }
  start(command: string, cwd: string, env: NodeJS.ProcessEnv): ProcessSnapshot {
    const shell = process.env.SHELL || (process.env.PREFIX ? path.join(process.env.PREFIX, 'bin', 'sh') : '/bin/sh');
    const child = spawn(shell, ['-lc', command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;
    const session: Session = { id: `proc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, command, cwd, child, status: 'running', output: '', truncated: false, startedAt: Date.now() };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const append = (chunk: string) => { session.output += chunk; if (session.output.length > this.maxOutputChars) { session.output = session.output.slice(-this.maxOutputChars); session.truncated = true; } };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', () => this.finish(session, 'failed', null, null)); child.once('close', (code, signal) => this.finish(session, code === 0 ? 'completed' : 'failed', code, signal));
    this.sessions.set(session.id, session); return this.snapshot(session);
  }
  poll(id: string): ProcessSnapshot { return this.snapshot(this.require(id)); }
  list(): ProcessSnapshot[] { this.sweep(); return [...this.sessions.values()].sort((a,b) => b.startedAt-a.startedAt).map(s => this.snapshot(s)); }
  kill(id: string): ProcessSnapshot { const session = this.require(id); if (session.status === 'running') { session.status = 'killed'; session.child.kill('SIGTERM'); setTimeout(() => { if (!session.child.killed) session.child.kill('SIGKILL'); }, 1000).unref(); } return this.snapshot(session); }
  async wait(id: string, timeoutMs = 30_000): Promise<ProcessSnapshot> { const session = this.require(id); if (session.status !== 'running') return this.snapshot(session); await new Promise<void>(resolve => { const timer = setTimeout(resolve, timeoutMs); session.child.once('close', () => { clearTimeout(timer); resolve(); }); }); return this.snapshot(session); }
  private finish(session: Session, status: ProcessStatus, code: number | null, signal: NodeJS.Signals | null) { if (session.status === 'killed' && status === 'completed') return; session.status = session.status === 'killed' ? 'killed' : status; session.exitCode = code; session.signal = signal; session.endedAt = Date.now(); session.expiresAt = session.endedAt + this.ttlMs; }
  private require(id: string): Session { this.sweep(); const session = this.sessions.get(id); if (!session) throw new Error(`Unknown process session: ${id}`); return session; }
  private snapshot(session: Session): ProcessSnapshot { return { id: session.id, command: session.command, cwd: session.cwd, status: session.status, pid: session.child.pid, exitCode: session.exitCode, signal: session.signal, output: session.output, truncated: session.truncated, startedAt: new Date(session.startedAt).toISOString(), endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined }; }
  private sweep(): void { const now = Date.now(); for (const [id, session] of this.sessions) if (session.expiresAt && session.expiresAt < now) this.sessions.delete(id); }
}
