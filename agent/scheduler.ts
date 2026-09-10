import { promises as fs } from 'fs';
import path from 'path';

export interface ScheduledJob {
  id: string;
  prompt: string;
  runAt: string;
  intervalMs?: number;
  enabled: boolean;
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
}

interface SchedulerFile { version: 1; jobs: ScheduledJob[]; }

/** Durable timer primitives. Jobs are data; execution is supplied by the single Layra runtime. */
export class LayraScheduler {
  private readonly file: string;
  private data: SchedulerFile = { version: 1, jobs: [] };
  private loaded = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private callback: ((job: ScheduledJob) => void | Promise<void>) | undefined;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(root = process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state')) { this.file = path.join(path.resolve(root), 'scheduler.json'); }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, 'utf8')) as SchedulerFile;
      if (!Array.isArray(this.data.jobs)) this.data = { version: 1, jobs: [] };
    } catch (error: any) { if (error?.code !== 'ENOENT') throw new Error(`Unable to load scheduler: ${error?.message || String(error)}`); }
    this.loaded = true;
  }

  async add(prompt: string, runAt: string | Date, intervalMs?: number): Promise<ScheduledJob> {
    await this.load();
    const date = new Date(runAt);
    if (!prompt.trim() || Number.isNaN(date.getTime())) throw new Error('A non-empty prompt and valid runAt are required');
    const interval = intervalMs === undefined ? undefined : Math.max(1000, Math.floor(Number(intervalMs)));
    const now = new Date().toISOString();
    const job: ScheduledJob = { id: `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, prompt: prompt.trim(), runAt: date.toISOString(), ...(interval ? { intervalMs: interval } : {}), enabled: true, nextRunAt: date.toISOString(), createdAt: now };
    this.data.jobs.push(job);
    await this.persist();
    this.arm();
    return { ...job };
  }

  async list(): Promise<ScheduledJob[]> { await this.load(); return this.data.jobs.map(job => ({ ...job })).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)); }
  async remove(id: string): Promise<boolean> { await this.load(); const before = this.data.jobs.length; this.data.jobs = this.data.jobs.filter(job => job.id !== id); if (before !== this.data.jobs.length) await this.persist(); this.arm(); return before !== this.data.jobs.length; }
  async due(now = new Date()): Promise<ScheduledJob[]> { await this.load(); return this.data.jobs.filter(job => job.enabled && new Date(job.nextRunAt).getTime() <= now.getTime()).map(job => ({ ...job })); }
  async markRun(id: string, ranAt = new Date()): Promise<void> { await this.load(); const job = this.data.jobs.find(item => item.id === id); if (!job) return; job.lastRunAt = ranAt.toISOString(); if (job.intervalMs) job.nextRunAt = new Date(ranAt.getTime() + job.intervalMs).toISOString(); else job.enabled = false; await this.persist(); this.arm(); }

  start(onDue: (job: ScheduledJob) => void | Promise<void>): void {
    this.running = true;
    this.callback = onDue;
    void this.load().then(() => this.arm()).catch(error => { console.error(`Layra scheduler failed to load: ${error instanceof Error ? error.message : String(error)}`); });
  }

  stop(): void { this.running = false; this.callback = undefined; if (this.timer) clearTimeout(this.timer); this.timer = null; }

  private arm(): void {
    if (!this.running || !this.loaded) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      try {
        const jobs = await this.due();
        for (const job of jobs) { await this.markRun(job.id); await this.callback?.(job); }
      } catch (error) { console.error(`Layra scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`); }
      finally { this.arm(); }
    }, Math.max(250, Math.min(60_000, this.nextDelay()))).unref();
  }

  private nextDelay(): number {
    const times = this.data.jobs.filter(job => job.enabled).map(job => new Date(job.nextRunAt).getTime()).filter(Number.isFinite);
    if (!times.length) return 60_000;
    return Math.max(250, Math.min(60_000, Math.min(...times) - Date.now()));
  }

  private async persist(): Promise<void> {
    this.writeTail = this.writeTail.then(async () => { await fs.mkdir(path.dirname(this.file), { recursive: true }); const temp = `${this.file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, this.file); });
    return this.writeTail;
  }
}
