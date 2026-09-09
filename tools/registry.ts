import { Tool, ToolPermission } from '../agent/state';
import { GoalTaskManager } from '../agent/goal-task-manager';

/** OpenClaw-derived capability registry with a single Layra execution boundary. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly permissions = new Map<string, ToolPermission>();
  private readonly goalTaskManager: GoalTaskManager;

  constructor(goalTaskManager: GoalTaskManager) {
    this.goalTaskManager = goalTaskManager;
    this.registerBasicTools();
  }

  registerTool(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.permissions.set(tool.name, { toolName: tool.name, granted: false, grantedAt: new Date(), grantedBy: 'system', reason: 'Explicit permission required' });
  }
  getTool(toolName: string): Tool | null { return this.tools.get(toolName) || null; }
  getAllTools(): Tool[] { return [...this.tools.values()]; }
  grantPermission(toolName: string, grantedBy: string, reason = 'Explicit permission granted'): boolean { const permission = this.permissions.get(toolName); if (!permission) return false; permission.granted = true; permission.grantedBy = grantedBy; permission.grantedAt = new Date(); permission.reason = reason; return true; }
  revokePermission(toolName: string): boolean { const permission = this.permissions.get(toolName); if (!permission) return false; permission.granted = false; permission.grantedBy = 'system'; permission.grantedAt = new Date(); permission.reason = 'Permission revoked'; return true; }
  isToolAvailable(toolName: string): boolean { const tool = this.tools.get(toolName); const permission = this.permissions.get(toolName); return Boolean(tool?.isAvailable !== false && permission?.granted); }
  getAvailableTools(): Tool[] { return this.getAllTools().filter(tool => this.isToolAvailable(tool.name)); }
  getUnavailableTools(): Tool[] { return this.getAllTools().filter(tool => !this.isToolAvailable(tool.name)); }
  getPermissionStatus(toolName: string): ToolPermission | null { return this.permissions.get(toolName) || null; }
  getToolsWithPermissions(): Array<{ tool: Tool; permission: ToolPermission }> { return this.getAllTools().map(tool => ({ tool, permission: this.permissions.get(tool.name)! })); }
  async executeTool(toolName: string, _parameters: Record<string, any>): Promise<{ success: boolean; result: any; error: string | null }> { return { success: false, result: null, error: `Direct registry execution disabled for '${toolName}'. Use ToolExecutor.` }; }

  private registerBasicTools(): void {
    const add = (tool: Tool) => this.registerTool(tool);
    add({ name: 'filesystem.read', description: 'Read UTF-8 or encoded file content inside Layra workspace', parameters: { path: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'string', permissions: ['filesystem.read'], isAvailable: true });
    add({ name: 'filesystem.list', description: 'List workspace files/directories with metadata', parameters: { path: { type: 'string', default: '.' }, recursive: { type: 'boolean', default: false }, maxEntries: { type: 'number', default: 1000 } }, returns: 'array', permissions: ['filesystem.list'], isAvailable: true });
    add({ name: 'filesystem.write', description: 'Atomically write a file inside Layra workspace', parameters: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'object', permissions: ['filesystem.write'], isAvailable: true });
    add({ name: 'shell.execute', description: 'Run a command using Layra shell safety policy', parameters: { command: { type: 'string' }, cwd: { type: 'string', default: '.' }, timeoutMs: { type: 'number', default: 30000 } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'web.get', description: 'Fetch HTTP(S) resource with timeout and response metadata', parameters: { url: { type: 'string' }, timeoutMs: { type: 'number', default: 20000 }, maxBytes: { type: 'number', default: 50000 } }, returns: 'object', permissions: ['web.get'], isAvailable: true });
    add({ name: 'web.post', description: 'POST JSON or text to HTTP(S) endpoint', parameters: { url: { type: 'string' }, data: { type: 'any' }, headers: { type: 'object' }, timeoutMs: { type: 'number', default: 20000 } }, returns: 'object', permissions: ['web.post'], isAvailable: true });
    add({ name: 'memory.get', description: 'Read a value from current long-term state memory', parameters: { key: { type: 'string' }, default: { type: 'any' } }, returns: 'any', permissions: ['memory.get'], isAvailable: true });
    add({ name: 'memory.set', description: 'Write a value into current long-term state memory', parameters: { key: { type: 'string' }, value: { type: 'any' } }, returns: 'boolean', permissions: ['memory.set'], isAvailable: true });
    add({ name: 'system.info', description: 'Inspect Layra runtime platform and workspace', parameters: {}, returns: 'object', permissions: ['system.info'], isAvailable: true });
    add({ name: 'system.time', description: 'Get current UTC timestamp', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true });
  }

  grantBasicPermissions(grantedBy = 'system'): void {
    const safe = ['filesystem.read', 'filesystem.list', 'web.get', 'memory.get', 'memory.set', 'system.info', 'system.time'];
    for (const name of safe) this.grantPermission(name, grantedBy, 'Safe default capability');
    if (process.env.LAYRA_ALLOW_LOCAL_WRITE === 'true') this.grantPermission('filesystem.write', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_LOCAL_WRITE');
    if (process.env.LAYRA_ALLOW_SHELL === 'true') this.grantPermission('shell.execute', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_SHELL');
    if (process.env.LAYRA_ALLOW_WEB_POST === 'true') this.grantPermission('web.post', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_WEB_POST');
  }
  reset(): void { this.tools.clear(); this.permissions.clear(); this.registerBasicTools(); }
}
