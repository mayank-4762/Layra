import { promises as fs } from 'fs';
import path from 'path';

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

interface MemoryFile { version: 1; records: MemoryRecord[]; }

/** Unified persistent memory inspired by Hermes' durable memory/session model. */
export class MemoryStore {
  private readonly file: string;
  private cache: MemoryFile = { version: 1, records: [] };
  private loaded = false;

  constructor(root = process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state')) {
    this.file = path.join(path.resolve(root), 'memory.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as MemoryFile;
      if (parsed?.version === 1 && Array.isArray(parsed.records)) this.cache = parsed;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  async remember(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    await this.load();
    const now = new Date().toISOString();
    const record: MemoryRecord = { ...input, id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: now, updatedAt: now };
    this.cache.records.push(record);
    this.compact();
    await this.persist();
    return record;
  }

  async update(id: string, patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'importance'>>): Promise<boolean> {
    await this.load();
    const record = this.cache.records.find(item => item.id === id);
    if (!record) return false;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    await this.persist();
    return true;
  }

  async search(query: string, limit = 8): Promise<MemoryRecord[]> {
    await this.load();
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    if (!terms.length) return this.cache.records.slice(-limit).reverse();
    return this.cache.records
      .map(record => {
        const haystack = `${record.content} ${record.tags.join(' ')}`.toLowerCase();
        let score = record.importance * 0.1;
        for (const term of terms) if (haystack.includes(term)) score += 1;
        return { record, score };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .slice(0, limit)
      .map(item => item.record);
  }

  async recent(limit = 20): Promise<MemoryRecord[]> {
    await this.load();
    return this.cache.records.slice(-limit).reverse();
  }

  private compact(): void {
    const max = Math.max(100, Number(process.env.LAYRA_MAX_MEMORY_RECORDS || 2000));
    if (this.cache.records.length <= max) return;
    this.cache.records.sort((a, b) => (b.importance - a.importance) || b.updatedAt.localeCompare(a.updatedAt));
    this.cache.records.length = max;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.cache, null, 2), 'utf8');
    await fs.rename(temp, this.file);
  }
}
