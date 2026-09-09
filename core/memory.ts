import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeRelativePath } from './security';

export interface MemoryRecord {
  id: string;
  kind: 'fact' | 'lesson' | 'preference' | 'procedure' | 'event';
  content: string;
  tags: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  source?: string;
}

interface MemoryFile { version: 3; records: MemoryRecord[]; }
export type MemoryDocument = 'MEMORY.md' | 'USER.md';

/** Durable structured + human-readable memory used by all Layra capabilities. */
export class MemoryStore {
  private readonly root: string;
  private readonly file: string;
  private readonly documentsRoot: string;
  private cache: MemoryFile = { version: 3, records: [] };
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(root = process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state')) {
    this.root = path.resolve(root);
    this.file = assertSafeRelativePath(this.root, 'memory.json');
    this.documentsRoot = path.resolve(process.env.LAYRA_MEMORY_DIR || path.join(process.cwd(), 'memory'));
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as any;
      if ((parsed?.version === 2 || parsed?.version === 3) && Array.isArray(parsed.records)) this.cache = { version: 3, records: parsed.records.filter(this.validRecord) };
      else if (parsed?.version === 1 && Array.isArray(parsed.records)) this.cache = { version: 3, records: parsed.records.filter(this.validRecord) };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load durable memory: ${error?.message || String(error)}`);
    }
    this.loaded = true;
    await fs.mkdir(this.documentsRoot, { recursive: true, mode: 0o700 });
    for (const name of ['MEMORY.md', 'USER.md'] as MemoryDocument[]) {
      const file = path.join(this.documentsRoot, name);
      try { await fs.access(file); } catch { await this.atomicDocumentWrite(name, `# ${name.slice(0, -3)}\n\n`); }
    }
    if (!(await this.exists())) await this.persist();
  }

  async remember(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.load();
    const now = new Date().toISOString();
    const record: MemoryRecord = { ...input, id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: now, updatedAt: now, tags: Array.from(new Set(input.tags.map(String))).slice(0, 32), importance: Math.max(0, Math.min(10, Number(input.importance))) };
    this.cache.records.push(record);
    this.compact();
    await this.persist();
    await this.appendHumanReadable(record);
    return record;
  }

  async update(id: string, patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'importance'>>): Promise<boolean> {
    await this.load();
    const record = this.cache.records.find(item => item.id === id);
    if (!record) return false;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    this.compact();
    await this.persist();
    return true;
  }

  async search(query: string, limit = 8): Promise<MemoryRecord[]> {
    await this.load();
    const bounded = Math.max(1, Math.min(100, Number(limit || 8)));
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    if (!terms.length) return this.cache.records.slice(-bounded).reverse();
    return this.cache.records.map(record => {
      const haystack = `${record.content} ${record.tags.join(' ')} ${record.kind} ${record.source || ''}`.toLowerCase();
      const exact = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
      const phrase = query.trim() && haystack.includes(query.toLowerCase().trim()) ? 2 : 0;
      return { record, score: exact + phrase + record.importance * 0.05 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt)).slice(0, bounded).map(item => item.record);
  }

  async recent(limit = 20): Promise<MemoryRecord[]> { await this.load(); return this.cache.records.slice(-Math.max(1, Math.min(100, Number(limit || 20)))).reverse(); }
  async count(): Promise<number> { await this.load(); return this.cache.records.length; }

  async readDocument(name: MemoryDocument): Promise<string> {
    await this.load();
    return fs.readFile(assertSafeRelativePath(this.documentsRoot, name), 'utf8');
  }

  async writeDocument(name: MemoryDocument, content: string): Promise<void> {
    await this.load();
    await this.atomicDocumentWrite(name, content);
  }

  private compact(): void {
    const max = Math.max(100, Number(process.env.LAYRA_MAX_MEMORY_RECORDS || 2000));
    if (this.cache.records.length <= max) return;
    this.cache.records.sort((a, b) => b.importance - a.importance || b.updatedAt.localeCompare(a.updatedAt));
    this.cache.records.length = max;
    this.cache.records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }

  private validRecord(value: any): value is MemoryRecord { return Boolean(value && typeof value.id === 'string' && typeof value.content === 'string' && typeof value.kind === 'string' && Array.isArray(value.tags)); }
  private async exists(): Promise<boolean> { try { await fs.access(this.file); return true; } catch { return false; } }
  private async persist(): Promise<void> { this.writeTail = this.writeTail.then(async () => { await fs.mkdir(this.root, { recursive: true }); const temp = `${this.file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, this.file); }); return this.writeTail; }
  private async appendHumanReadable(record: MemoryRecord): Promise<void> { const target: MemoryDocument = record.kind === 'preference' ? 'USER.md' : 'MEMORY.md'; const existing = await this.readDocument(target); const line = `- [${record.kind}] ${record.content.replace(/\r?\n/g, ' ').slice(0, 600)}${record.source ? ` — source: ${record.source}` : ''}\n`; const trimmed = existing.endsWith('\n') ? existing : `${existing}\n`; await this.atomicDocumentWrite(target, `${trimmed}${line}`); }
  private async atomicDocumentWrite(name: MemoryDocument, content: string): Promise<void> { await fs.mkdir(this.documentsRoot, { recursive: true, mode: 0o700 }); const file = assertSafeRelativePath(this.documentsRoot, name); const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, file); }
}
