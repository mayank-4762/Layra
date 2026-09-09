import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { assertSafeRelativePath } from './security';
import type { MemoryRecord } from './memory';

/** Obsidian-compatible local knowledge vault. Markdown is the interoperability layer; Layra remains the runtime memory authority. */
export class KnowledgeVault {
  private readonly root: string;
  private readonly memoryRoot: string;
  private readonly dailyRoot: string;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(baseRoot = process.env.LAYRA_VAULT_DIR || path.join(process.cwd(), 'LayraVault')) {
    this.root = path.resolve(baseRoot);
    this.memoryRoot = path.join(this.root, 'Memory');
    this.dailyRoot = path.join(this.root, 'Daily');
  }

  async initialize(): Promise<void> {
    for (const directory of [this.root, this.memoryRoot, this.dailyRoot]) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await this.writeIfMissing('00-Index.md', '# Layra Knowledge Vault\n\nThis vault is generated and maintained by Layra. Markdown files are portable and Obsidian-compatible.\n\n## Memory\n\n- [[Memory/Index]]\n');
    await this.writeIfMissing('Memory/Index.md', '# Memory Index\n\n');
  }

  async upsert(record: MemoryRecord): Promise<string> {
    await this.initialize();
    const kind = safeSegment(record.kind);
    const slug = `${slugify(record.content).slice(0, 70) || 'memory'}-${record.id}`;
    const relative = path.posix.join('Memory', kind, `${slug}.md`);
    const target = assertSafeRelativePath(this.root, relative.split('/').join(path.sep));
    const links = Array.isArray((record as any).relatedIds) ? (record as any).relatedIds.map(String).slice(0, 12) : [];
    const tags = record.tags.map(tag => `#${slugify(tag).replace(/-/g, '_')}`).filter(Boolean).slice(0, 20);
    const frontmatter = [
      '---',
      `id: ${yamlScalar(record.id)}`,
      `type: ${yamlScalar(record.kind)}`,
      `created: ${yamlScalar(record.createdAt)}`,
      `updated: ${yamlScalar(record.updatedAt)}`,
      `importance: ${record.importance.toFixed(2)}`,
      `source: ${yamlScalar(record.source || 'Layra')}`,
      `tags: [${record.tags.slice(0, 20).map(yamlScalar).join(', ')}]`,
      '---', '',
      `# ${escapeHeading(record.content.slice(0, 120))}`,
      '',
      record.content.trim(),
      '',
      tags.length ? `Tags: ${tags.join(' ')}` : '',
      links.length ? `Related: ${links.map(id => `[[${findVaultBasename(id)}]]`).join(' ')}` : '',
      ''
    ].filter(Boolean).join('\n');
    await this.atomicWrite(target, frontmatter);
    return relative;
  }

  async appendDaily(records: MemoryRecord[], date = new Date()): Promise<void> {
    await this.initialize();
    if (!records.length) return;
    const day = date.toISOString().slice(0, 10);
    const relative = path.posix.join('Daily', `${day}.md`);
    const target = assertSafeRelativePath(this.root, relative.split('/').join(path.sep));
    const existing = await this.readOrEmpty(target);
    const seen = new Set((existing.match(/^## Memory (.*?)$/gm) || []).map(value => value.slice(10)));
    const sections = records.filter(record => !seen.has(record.id)).map(record => `## Memory ${record.id}\n\n- **Type:** ${record.kind}\n- **Importance:** ${record.importance.toFixed(2)}\n- **Source:** ${escapeInline(record.source || 'Layra')}\n\n${record.content.trim()}\n`).join('\n');
    if (sections) await this.atomicWrite(target, `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${sections}\n`);
  }

  async rebuildIndex(records: MemoryRecord[]): Promise<void> {
    await this.initialize();
    const grouped = new Map<string, MemoryRecord[]>();
    for (const record of records) { const list = grouped.get(record.kind) || []; list.push(record); grouped.set(record.kind, list); }
    const body = ['# Memory Index', '', `Last rebuilt: ${new Date().toISOString()}`, '', `Total records: ${records.length}`, ''];
    for (const [kind, items] of grouped) {
      body.push(`## ${kind}`, '');
      for (const record of items.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)) {
        const relative = `Memory/${safeSegment(kind)}/${slugify(record.content).slice(0, 70) || 'memory'}-${record.id}`;
        body.push(`- [[${relative}]] — importance ${record.importance.toFixed(2)} — ${escapeInline(record.content.slice(0, 180))}`);
      }
      body.push('');
    }
    const target = assertSafeRelativePath(this.root, 'Memory/Index.md');
    await this.atomicWrite(target, `${body.join('\n')}\n`);
  }

  getRoot(): string { return this.root; }
  private async writeIfMissing(relative: string, content: string): Promise<void> {
    const target = assertSafeRelativePath(this.root, relative.split('/').join(path.sep));
    try { await fs.access(target); } catch { await this.atomicWrite(target, content); }
  }
  private async readOrEmpty(file: string): Promise<string> { try { return await fs.readFile(file, 'utf8'); } catch (error: any) { if (error?.code === 'ENOENT') return ''; throw error; } }
  private async atomicWrite(file: string, content: string): Promise<void> {
    this.writeTail = this.writeTail.then(async () => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 }); await fs.rename(tmp, file); });
    return this.writeTail;
  }
}

function slugify(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}
function safeSegment(value: string): string { return slugify(value) || 'other'; }
function yamlScalar(value: string): string { return JSON.stringify(value.replace(/\r?\n/g, ' ').slice(0, 500)); }
function escapeHeading(value: string): string { return value.replace(/[#\r\n]/g, ' ').trim() || 'Memory'; }
function escapeInline(value: string): string { return value.replace(/[\r\n]/g, ' ').replace(/\[\[/g, '[ [').replace(/\]\]/g, '] ]').slice(0, 500); }
function findVaultBasename(id: string): string { return id; }
export const knowledgeVaultKey = (record: Pick<MemoryRecord, 'id'>): string => createHash('sha256').update(record.id).digest('hex').slice(0, 16);
