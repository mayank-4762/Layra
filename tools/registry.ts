import { Tool, ToolPermission } from '../agent/state';
import { GoalTaskManager } from '../agent/goal-task-manager';
import { inspectUntrustedText } from '../core/security';

export interface ToolContext { signal?: AbortSignal; goal?: string | null; stepId?: string; sessionId?: string | null; }
export interface ToolHook { before?: (tool: Tool, parameters: Record<string, any>, context: ToolContext) => void | Promise<void>; after?: (tool: Tool, parameters: Record<string, any>, result: { success: boolean; result: any; error: string | null }, context: ToolContext) => void | Promise<void>; }

/** Single capability/policy boundary for every native Layra capability. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>(); private readonly permissions = new Map<string, ToolPermission>(); private readonly hooks = new Set<ToolHook>(); private readonly goalTaskManager: GoalTaskManager;
  constructor(goalTaskManager: GoalTaskManager) { this.goalTaskManager = goalTaskManager; this.registerBasicTools(); }
  registerTool(tool: Tool): void { this.validateTool(tool); this.tools.set(tool.name, tool); this.permissions.set(tool.name, { toolName: tool.name, granted: false, grantedAt: new Date(), grantedBy: 'system', reason: 'Explicit permission required' }); }
  registerHook(hook: ToolHook): () => void { this.hooks.add(hook); return () => this.hooks.delete(hook); }
  getTool(toolName: string): Tool | null { return this.tools.get(toolName) || null; }
  getAllTools(): Tool[] { return [...this.tools.values()]; }
  grantPermission(toolName: string, grantedBy: string, reason = 'Explicit permission granted'): boolean { const permission = this.permissions.get(toolName); if (!permission) return false; permission.granted = true; permission.grantedBy = grantedBy; permission.grantedAt = new Date(); permission.reason = reason; return true; }
  revokePermission(toolName: string): boolean { const permission = this.permissions.get(toolName); if (!permission) return false; permission.granted = false; permission.grantedBy = 'system'; permission.grantedAt = new Date(); permission.reason = 'Permission revoked'; return true; }
  isToolAvailable(toolName: string): boolean { const tool = this.tools.get(toolName); const permission = this.permissions.get(toolName); return Boolean(tool?.isAvailable !== false && permission?.granted); }
  getAvailableTools(): Tool[] { return this.getAllTools().filter(tool => this.isToolAvailable(tool.name)); }
  getUnavailableTools(): Tool[] { return this.getAllTools().filter(tool => !this.isToolAvailable(tool.name)); }
  getPermissionStatus(toolName: string): ToolPermission | null { return this.permissions.get(toolName) || null; }
  getToolsWithPermissions(): Array<{ tool: Tool; permission: ToolPermission }> { return this.getAllTools().map(tool => ({ tool, permission: this.permissions.get(tool.name)! })); }
  async runBeforeHooks(toolName: string, parameters: Record<string, any>, context: ToolContext): Promise<void> {
    const tool = this.requireAllowed(toolName);
    const serialized = JSON.stringify(parameters);
    const findings = inspectUntrustedText(serialized);
    if (findings.some(f => f.severity === 'high') && tool.permissions.some(p => ['filesystem.write', 'shell.execute', 'web.post', 'browser.control', 'mcp'].includes(p))) throw new Error(`High-risk input blocked for ${toolName}: ${findings[0].code}`);
    for (const hook of this.hooks) await hook.before?.(tool, parameters, context);
  }
  async runAfterHooks(toolName: string, parameters: Record<string, any>, result: { success: boolean; result: any; error: string | null }, context: ToolContext): Promise<void> { const tool = this.tools.get(toolName); if (!tool) return; for (const hook of this.hooks) await hook.after?.(tool, parameters, result, context); }
  requireAllowed(toolName: string): Tool { const tool = this.tools.get(toolName); if (!tool) throw new Error(`Unknown tool: ${toolName}`); if (!this.isToolAvailable(toolName)) throw new Error(`Tool is not available or permission is not granted: ${toolName}`); return tool; }
  async executeTool(toolName: string, _parameters: Record<string, any>): Promise<{ success: boolean; result: any; error: string | null }> { return { success: false, result: null, error: `Direct registry execution disabled for '${toolName}'. Use ToolExecutor.` }; }
  private validateTool(tool: Tool): void { if (!/^[a-z][a-z0-9._-]{1,63}$/i.test(tool.name)) throw new Error(`Invalid tool name: ${tool.name}`); if (!tool.description.trim()) throw new Error(`Tool description is required: ${tool.name}`); if (!tool.permissions.length) throw new Error(`Tool permissions are required: ${tool.name}`); }
  private registerBasicTools(): void {
    const add = (tool: Tool) => this.registerTool(tool);
    add({ name: 'filesystem.read', description: 'Read UTF-8 file content inside Layra workspace', parameters: { path: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'string', permissions: ['filesystem.read'], isAvailable: true });
    add({ name: 'filesystem.list', description: 'List workspace files/directories with metadata', parameters: { path: { type: 'string', default: '.' }, recursive: { type: 'boolean', default: false }, maxEntries: { type: 'number', default: 1000 } }, returns: 'array', permissions: ['filesystem.list'], isAvailable: true });
    add({ name: 'filesystem.write', description: 'Atomically write a file inside Layra workspace', parameters: { path: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', default: 'utf8' } }, returns: 'object', permissions: ['filesystem.write'], isAvailable: true });
    add({ name: 'shell.execute', description: 'Run a command using Layra shell safety policy', parameters: { command: { type: 'string' }, cwd: { type: 'string', default: '.' }, timeoutMs: { type: 'number', default: 30000 } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'process.start', description: 'Start a bounded background shell process and return its session id', parameters: { command: { type: 'string' }, cwd: { type: 'string', default: '.' } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'process.poll', description: 'Poll a background process session and retrieve bounded output', parameters: { id: { type: 'string' } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'process.list', description: 'List current background process sessions', parameters: {}, returns: 'array', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'process.kill', description: 'Terminate a background process session', parameters: { id: { type: 'string' } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'process.wait', description: 'Wait for a background process session to finish', parameters: { id: { type: 'string' }, timeoutMs: { type: 'number', default: 30000 } }, returns: 'object', permissions: ['shell.execute'], isAvailable: true });
    add({ name: 'web.get', description: 'Fetch HTTP(S) resource with timeout and response metadata', parameters: { url: { type: 'string' }, timeoutMs: { type: 'number', default: 20000 }, maxBytes: { type: 'number', default: 50000 } }, returns: 'object', permissions: ['web.get'], isAvailable: true });
    add({ name: 'web.post', description: 'POST JSON or text to HTTP(S) endpoint', parameters: { url: { type: 'string' }, data: { type: 'any' }, headers: { type: 'object' }, timeoutMs: { type: 'number', default: 20000 } }, returns: 'object', permissions: ['web.post'], isAvailable: true });
    add({ name: 'memory.get', description: 'Read structured durable memory', parameters: { query: { type: 'string', default: '' }, limit: { type: 'number', default: 8 } }, returns: 'array', permissions: ['memory.get'], isAvailable: true });
    add({ name: 'memory.set', description: 'Append a structured durable memory record', parameters: { kind: { type: 'string' }, content: { type: 'string' }, tags: { type: 'array' }, importance: { type: 'number', default: 5 }, source: { type: 'string' } }, returns: 'object', permissions: ['memory.set'], isAvailable: true });
    add({ name: 'system.info', description: 'Inspect Layra runtime platform and workspace', parameters: {}, returns: 'object', permissions: ['system.info'], isAvailable: true });
    add({ name: 'system.time', description: 'Get current UTC timestamp', parameters: {}, returns: 'string', permissions: ['system.time'], isAvailable: true });
    add({ name: 'browser.navigate', description: 'Navigate a configured Chromium browser to an HTTP(S) URL', parameters: { url: { type: 'string' } }, returns: 'object', permissions: ['browser.control'], isAvailable: true });
    add({ name: 'browser.snapshot', description: 'Read bounded visible text from the configured Chromium page', parameters: {}, returns: 'string', permissions: ['browser.control'], isAvailable: true });
    add({ name: 'browser.click', description: 'Click a CSS-selected element in the configured Chromium page', parameters: { selector: { type: 'string' } }, returns: 'object', permissions: ['browser.control'], isAvailable: true });
    add({ name: 'browser.type', description: 'Focus a CSS-selected element and type text in the configured Chromium page', parameters: { selector: { type: 'string' }, text: { type: 'string' } }, returns: 'object', permissions: ['browser.control'], isAvailable: true });
    add({ name: 'mcp.list', description: 'Discover tools from the configured MCP server', parameters: {}, returns: 'array', permissions: ['mcp'], isAvailable: true });
    add({ name: 'mcp.call', description: 'Call a tool exposed by the configured MCP server', parameters: { name: { type: 'string' }, arguments: { type: 'object' } }, returns: 'object', permissions: ['mcp'], isAvailable: true });
    add({ name: 'scheduler.add', description: 'Persist a future or recurring Layra prompt', parameters: { prompt: { type: 'string' }, runAt: { type: 'string' }, intervalMs: { type: 'number' } }, returns: 'object', permissions: ['scheduler'], isAvailable: true });
    add({ name: 'scheduler.list', description: 'List durable Layra scheduled jobs', parameters: {}, returns: 'array', permissions: ['scheduler'], isAvailable: true });
    add({ name: 'scheduler.remove', description: 'Remove a durable Layra scheduled job', parameters: { id: { type: 'string' } }, returns: 'boolean', permissions: ['scheduler'], isAvailable: true });
  }
  grantBasicPermissions(grantedBy = 'system'): void {
    const safe = ['filesystem.read', 'filesystem.list', 'web.get', 'memory.get', 'memory.set', 'system.info', 'system.time'];
    for (const name of safe) this.grantPermission(name, grantedBy, 'Safe default capability');
    if (process.env.LAYRA_ALLOW_LOCAL_WRITE === 'true') this.grantPermission('filesystem.write', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_LOCAL_WRITE');
    if (process.env.LAYRA_ALLOW_SHELL === 'true') { this.grantPermission('shell.execute', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_SHELL'); for (const name of ['process.start','process.poll','process.list','process.kill','process.wait']) this.grantPermission(name, grantedBy, 'Explicitly enabled by LAYRA_ALLOW_SHELL'); }
    if (process.env.LAYRA_ALLOW_WEB_POST === 'true') this.grantPermission('web.post', grantedBy, 'Explicitly enabled by LAYRA_ALLOW_WEB_POST');
    if (process.env.LAYRA_ALLOW_BROWSER === 'true' && process.env.LAYRA_CDP_WS_URL) for (const name of ['browser.navigate','browser.snapshot','browser.click','browser.type']) this.grantPermission(name, grantedBy, 'Explicitly enabled by LAYRA_ALLOW_BROWSER');
    if (process.env.LAYRA_ALLOW_MCP === 'true' && process.env.LAYRA_MCP_SERVER_COMMAND) for (const name of ['mcp.list','mcp.call']) this.grantPermission(name, grantedBy, 'Explicitly enabled by LAYRA_ALLOW_MCP');
    if (process.env.LAYRA_ALLOW_SCHEDULER === 'true') for (const name of ['scheduler.add','scheduler.list','scheduler.remove']) this.grantPermission(name, grantedBy, 'Explicitly enabled by LAYRA_ALLOW_SCHEDULER');
  }
  reset(): void { this.tools.clear(); this.permissions.clear(); this.registerBasicTools(); }
}
