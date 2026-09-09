import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeRelativePath } from './security';
import { KnowledgeVault } from './knowledge-vault';

export interface MemoryRecord {
  id: string;
  kind: 'fact' | 'lesson' | 'preference' | 'procedure' | 'event';
  content: string;
  tags: string[];
  importance: number;
  createdAt: string;
  updatedAt: string;
  source?: string;
  relatedIds?: string[];
  vaultPath?: string;
}
interface MemoryFile { version: 4; records: MemoryRecord[]; }
export type MemoryDocument = 'MEMORY.md' | 'USER.md';

/** Durable structured memory with an optional Obsidian-compatible knowledge-vault projection. */
export class MemoryStore {
  private readonly root: string;
  private readonly file: string;
  private readonly documentsRoot: string;
  private readonly vault: KnowledgeVault;
  private cache: MemoryFile = { version: 4, records: [] };
  private loaded = false;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(root = process.env.LAYRA_STATE_DIR || path.join(process.cwd(), '.state')) {
    this.root = path.resolve(root);
    this.file = assertSafeRelativePath(this.root, 'memory.json');
    this.documentsRoot = path.resolve(process.env.LAYRA_MEMORY_DIR || path.join(process.cwd(), 'memory'));
    this.vault = new KnowledgeVault();
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as any;
      if ([1, 2, 3, 4].includes(parsed?.version) && Array.isArray(parsed.records)) this.cache = { version: 4, records: parsed.records.filter(this.validRecord) };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error(`Unable to load durable memory: ${error?.message || String(error)}`);
    }
    this.loaded = true;
    await fs.mkdir(this.documentsRoot, { recursive: true, mode: 0o700 });
    for (const name of ['MEMORY.md', 'USER.md'] as MemoryDocument[]) {
      const file = path.join(this.documentsRoot, name);
      try { await fs.access(file); } catch { await this.atomicDocumentWrite(name, `# ${name.slice(0, -3)}\n\n`); }
    }
    if (process.env.LAYRA_OBSIDIAN_VAULT !== 'false') await this.vault.initialize();
    if (!(await this.exists())) await this.persist();
  }

  async remember(input: Omit<MemoryRecord, 'id' | 'createdAt' | 'updatedAt' | 'relatedIds' | 'vaultPath'>): Promise<MemoryRecord> {
    await this.load();
    const normalized = normalize(input.content);
    const duplicate = this.cache.records.find(item => item.kind === input.kind && normalize(item.content) === normalized);
    if (duplicate) {
      const updated: MemoryRecord = { ...duplicate, tags: Array.from(new Set([...duplicate.tags, ...input.tags.map(String)])).slice(0, 32), importance: Math.max(duplicate.importance, Math.min(10, Number(input.importance))), updatedAt: new Date().toISOString(), source: input.source || duplicate.source };
      const relatedIds = this.findRelatedIds(updated, 8);
      updated.relatedIds = relatedIds;
      const vaultPath = await this.projectToVault(updated);
      updated.vaultPath = vaultPath;
      Object.assign(duplicate, updated);
      await this.persist();
      return duplicate;
    }
    const now = new Date().toISOString();
    const record: MemoryRecord = { ...input, id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, createdAt: now, updatedAt: now, tags: Array.from(new Set(input.tags.map(String))).slice(0, 32), importance: Math.max(0, Math.min(10, Number(input.importance))), relatedIds: [] };
    record.relatedIds = this.findRelatedIds(record, 8);
    this.cache.records.push(record);
    this.compact();
    record.vaultPath = await this.projectToVault(record);
    await this.persist();
    await this.appendHumanReadable(record);
    await this.consolidateProjection();
    return record;
  }

  async update(id: string, patch: Partial<Pick<MemoryRecord, 'content' | 'tags' | 'importance'>>): Promise<boolean> {
    await this.load();
    const record = this.cache.records.find(item => item.id === id);
    if (!record) return false;
    Object.assign(record, patch, { updatedAt: new Date().toISOString() });
    record.relatedIds = this.findRelatedIds(record, 8).filter(value => value !== id);
    record.vaultPath = await this.projectToVault(record);
    this.compact();
    await this.persist();
    return true;
  }

  async search(query: string, limit = 8): Promise<MemoryRecord[]> {
    await this.load();
    const bounded = Math.max(1, Math.min(100, Number(limit || 8)));
    const text = query.trim().toLowerCase();
    const terms = text.split(/[^a-z0-9_]+/).filter(Boolean);
    if (!terms.length) return this.cache.records.slice(-bounded).reverse();
    const now = Date.now();
    return this.cache.records.map(record => {
      const haystack = `${record.content} ${record.tags.join(' ')} ${record.kind} ${record.source || ''}`.toLowerCase();
      const exact = terms.reduce((n, term) => n + (haystack.includes(term) ? 1 : 0), 0);
      const phrase = text && haystack.includes(text) ? terms.length : 0;
      const ageDays = Math.max(0, (now - Date.parse(record.updatedAt)) / 86_400_000);
      const recency = 1 / (1 + ageDays / 30);
      const graphBoost = record.relatedIds?.some(id => this.cache.records.find(item => item.id === id && terms.some(term => item.content.toLowerCase().includes(term)))) ? 0.75 : 0;
      return { record, score: exact + phrase + record.importance * 0.15 + recency + graphBoost };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt)).slice(0, bounded).map(item => item.record);
  }

  async recent(limit = 20): Promise<MemoryRecord[]> { await this.load(); return this.cache.records.slice(-Math.max(1, Math.min(100, Number(limit || 20)))).reverse(); }
  async count(): Promise<number> { await this.load(); return this.cache.records.length; }
  async related(id: string, limit = 8): Promise<MemoryRecord[]> { await this.load(); const record = this.cache.records.find(item => item.id === id); if (!record) return []; const ids = new Set((record.relatedIds || []).slice(0, Math.max(1, Math.min(50, Number(limit || 8))))); return this.cache.records.filter(item => ids.has(item.id)); }
  async consolidate(): Promise<void> { await this.load(); await this.consolidateProjection(); }
  async rebuildVaultIndex(): Promise<void> { await this.load(); if (process.env.LAYRA_OBSIDIAN_VAULT !== 'false') await this.vault.rebuildIndex(this.cache.records); }
  getVaultRoot(): string { return this.vault.getRoot(); }

  async readDocument(name: MemoryDocument): Promise<string> { await this.load(); return fs.readFile(assertSafeRelativePath(this.documentsRoot, name), 'utf8'); }
  async writeDocument(name: MemoryDocument, content: string): Promise<void> { await this.load(); await this.atomicDocumentWrite(name, content); }

  private findRelatedIds(record: MemoryRecord, limit: number): string[] {
    const tags = new Set(record.tags.map(normalize));
    return this.cache.records.filter(item => item.id !== record.id).map(item => {
      const overlap = item.tags.map(normalize).filter(tag => tags.has(tag)).length;
      const sharedWords = tokenSet(item.content).filter(word => tokenSet(record.content).includes(word)).length;
      return { id: item.id, score: overlap * 3 + Math.min(4, sharedWords) + item.importance * 0.02 };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.id);
  }

  private async projectToVault(record: MemoryRecord): Promise<string | undefined> {
    if (process.env.LAYRA_OBSIDIAN_VAULT === 'false') return undefined;
    return this.vault.upsert(record);
  }
  private async consolidateProjection(): Promise<void> {
    if (process.env.LAYRA_OBSIDIAN_VAULT === 'false') return;
    const important = this.cache.records.filter(item => item.importance >= 7 || item.kind === 'lesson').slice(-20);
    await this.vault.appendDaily(important);
    if (this.cache.records.length % 10 === 0 || important.length) await this.vault.rebuildIndex(this.cache.records);
  }
  private compact(): void {
    const max = Math.max(100, Number(process.env.LAYRA_MAX_MEMORY_RECORDS || 2000));
    if (this.cache.records.length <= max) return;
    this.cache.records.sort((a, b) => (b.importance * 0.7 + recencyScore(b.updatedAt)) - (a.importance * 0.7 + recencyScore(a.updatedAt)));
    this.cache.records.length = max;
    this.cache.records.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
  private validRecord(value: any): value is MemoryRecord { return Boolean(value && typeof value.id === 'string' && typeof value.content === 'string' && typeof value.kind === 'string' && Array.isArray(value.tags)); }
  private async exists(): Promise<boolean> { try { await fs.access(this.file); return true; } catch { return false; } }
  private async persist(): Promise<void> { this.writeTail = this.writeTail.then(async () => { await fs.mkdir(this.root, { recursive: true }); const temp = `${this.file}.${process.pid}.tmp`; await fs.writeFile(temp, JSON.stringify(this.cache, null, 2), { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, this.file); }); return this.writeTail; }
  private async appendHumanReadable(record: MemoryRecord): Promise<void> { const target: MemoryDocument = record.kind === 'preference' ? 'USER.md' : 'MEMORY.md'; const existing = await this.readDocument(target); const link = record.vaultPath ? ` — vault: ${record.vaultPath}` : ''; const line = `- [${record.kind}] ${record.content.replace(/\r?\n/g, ' ').slice(0, 600)}${record.source ? ` — source: ${record.source}` : ''}${link}\n`; const trimmed = existing.endsWith('\n') ? existing : `${existing}\n`; await this.atomicDocumentWrite(target, `${trimmed}${line}`); }
  private async atomicDocumentWrite(name: MemoryDocument, content: string): Promise<void> { await fs.mkdir(this.documentsRoot, { recursive: true, mode: 0o700 }); const file = assertSafeRelativePath(this.documentsRoot, name); const temp = `${file}.${process.pid}.tmp`; await fs.writeFile(temp, content, { encoding: 'utf8', mode: 0o600 }); await fs.rename(temp, file); }
}

function normalize(value: string): string { return value.trim().toLowerCase().replace(/\s+/g, ' '); }
function tokenSet(value: string): string[] { return Array.from(new Set(normalize(value).split(/[^a-z0-9_]+/).filter(token => token.length > 2))); }
function recencyScore(value: string): number { const days = Math.max(0, (Date.now() - Date.parse(value)) / 86_400_000); return 1 / (1 + days / 30); }
