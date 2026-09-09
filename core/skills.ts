import { promises as fs } from 'fs';
import path from 'path';
import { assertSafeRelativePath, assertSafeSkillName, inspectUntrustedText } from './security';

export interface Skill { name: string; description: string; content: string; path: string; }
export interface SkillMetadata { name: string; description: string; version?: string; tools?: string[]; trusted?: boolean; }

/** Procedural memory: reusable skills learned from successful work, with provenance and safety checks. */
export class SkillStore {
  private readonly roots: string[];
  constructor(workspaceRoot = process.env.LAYRA_WORKSPACE_ROOT || process.cwd()) {
    const root = path.resolve(workspaceRoot);
    this.roots = [path.join(root, 'skills'), path.join(path.resolve(process.env.LAYRA_STATE_DIR || path.join(root, '.state')), 'skills')];
  }

  async list(): Promise<Array<Pick<Skill, 'name' | 'description' | 'path'> & { metadata: SkillMetadata }>> {
    const skills: Array<Pick<Skill, 'name' | 'description' | 'path'> & { metadata: SkillMetadata }> = [];
    for (const root of this.roots) {
      for (const name of await this.directories(root)) {
        const file = path.join(root, name, 'SKILL.md');
        try {
          const content = await fs.readFile(file, 'utf8');
          const metadata = this.parseMetadata(content, name);
          if (!metadata.trusted && inspectUntrustedText(content).some(f => f.severity === 'high')) continue;
          if (!skills.some(item => item.name === name)) skills.push({ name, description: metadata.description, path: file, metadata });
        } catch { /* malformed skills are excluded from the effective surface */ }
      }
    }
    return skills;
  }

  async findRelevant(query: string, limit = 6): Promise<Skill[]> {
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    const all = await this.list();
    const ranked = all.map(item => {
      const hay = `${item.name} ${item.description} ${(item.metadata.tools || []).join(' ')}`.toLowerCase();
      return { item, score: terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) };
    }).filter(item => !terms.length || item.score > 0).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    const selected: Skill[] = [];
    for (const entry of ranked.slice(0, Math.max(1, Math.min(limit, 20)))) {
      const content = await fs.readFile(entry.item.path, 'utf8');
      selected.push({ ...entry.item, content });
    }
    return selected;
  }

  async read(name: string): Promise<Skill | null> {
    const safe = assertSafeSkillName(name);
    for (const root of this.roots) {
      const file = assertSafeRelativePath(root, path.join(safe, 'SKILL.md'));
      try {
        const content = await fs.readFile(file, 'utf8');
        const metadata = this.parseMetadata(content, safe);
        if (!metadata.trusted && inspectUntrustedText(content).some(f => f.severity === 'high')) return null;
        return { name: safe, description: metadata.description, content, path: file };
      } catch { /* continue to next root */ }
    }
    return null;
  }

  async upsert(name: string, content: string, metadata: Partial<SkillMetadata> = {}): Promise<string> {
    const safe = assertSafeSkillName(name);
    if (inspectUntrustedText(content).some(f => f.severity === 'high') && metadata.trusted !== true) throw new Error('Skill contains a high-risk instruction pattern and is not explicitly trusted');
    const root = this.roots[1];
    const dir = assertSafeRelativePath(root, safe);
    await fs.mkdir(dir, { recursive: true });
    const file = assertSafeRelativePath(dir, 'SKILL.md');
    const header = [`---`, `name: ${safe}`, `description: ${String(metadata.description || 'Reusable workflow learned by Layra').replace(/\n/g, ' ')}`, metadata.version ? `version: ${metadata.version}` : '', Array.isArray(metadata.tools) && metadata.tools.length ? `tools: ${metadata.tools.join(', ')}` : '', `trusted: ${metadata.trusted === true}`, `---`, ``].filter(Boolean).join('\n');
    const body = content.trimStart().startsWith('---') ? content : `${header}${content.trimStart()}`;
    const temp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temp, body.trimEnd() + '\n', 'utf8');
    await fs.rename(temp, file);
    return file;
  }

  private parseMetadata(content: string, fallbackName: string): SkillMetadata {
    const block = content.match(/^---\n([\s\S]*?)\n---/);
    const lines = block ? block[1].split('\n') : [];
    const get = (key: string) => lines.find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
    const tools = get('tools')?.split(',').map(item => item.trim()).filter(Boolean);
    return { name: get('name') || fallbackName, description: get('description') || 'Reusable Layra procedure', version: get('version'), tools, trusted: get('trusted') === 'true' };
  }

  private async directories(root: string): Promise<string[]> {
    try { const entries = await fs.readdir(root, { withFileTypes: true }); return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).filter(name => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)); }
    catch (error: any) { if (error?.code === 'ENOENT') return []; throw error; }
  }
}
