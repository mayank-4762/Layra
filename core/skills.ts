import { promises as fs } from 'fs';
import path from 'path';

export interface Skill { name: string; description: string; content: string; path: string; }

/** Procedural memory: reusable skills learned from successful or corrected work. */
export class SkillStore {
  private readonly roots: string[];
  constructor(workspaceRoot = process.env.LAYRA_WORKSPACE_ROOT || process.cwd()) {
    this.roots = [
      path.join(path.resolve(workspaceRoot), 'skills'),
      path.join(path.resolve(process.env.LAYRA_STATE_DIR || path.join(workspaceRoot, '.state')), 'skills')
    ];
  }

  async list(): Promise<Array<Pick<Skill, 'name' | 'description' | 'path'>> {
    const skills: Array<Pick<Skill, 'name' | 'description' | 'path'>> = [];
    for (const root of this.roots) {
      for (const name of await this.directories(root)) {
        const file = path.join(root, name, 'SKILL.md');
        try {
          const content = await fs.readFile(file, 'utf8');
          const description = content.match(/^description:\s*(.+)$/im)?.[1]?.trim() || content.split('\n').find(line => line.trim() && !line.startsWith('#'))?.trim() || 'Reusable Layra procedure';
          if (!skills.some(item => item.name === name)) skills.push({ name, description, path: file });
        } catch { /* malformed skill is ignored */ }
      }
    }
    return skills;
  }

  async findRelevant(query: string, limit = 6): Promise<Skill[]> {
    const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    const all = await this.list();
    const ranked = all.map(item => {
      const hay = `${item.name} ${item.description}`.toLowerCase();
      return { item, score: terms.reduce((n, term) => n + (hay.includes(term) ? 1 : 0), 0) };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    const selected: Skill[] = [];
    for (const entry of ranked.slice(0, limit)) {
      const content = await fs.readFile(entry.item.path, 'utf8');
      selected.push({ ...entry.item, content });
    }
    return selected;
  }

  async upsert(name: string, content: string): Promise<string> {
    this.validateName(name);
    const root = this.roots[1];
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, content.trimEnd() + '\n', 'utf8');
    await fs.rename(temp, file);
    return file;
  }

  private validateName(name: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) || name === '.' || name === '..') throw new Error(`Invalid skill name: ${name}`);
  }

  private async directories(root: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name);
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }
}
