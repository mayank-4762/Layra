import { ToolRegistry } from '../tools/registry';
import { AgentState } from '../agent/state';
import { NativeRuntime } from './native-runtime';
import { ProcessRegistry } from './process-registry';
import { MemoryStore } from '../core/memory';
import { normalizeToolResult } from '../core/tool-protocol';
import { assertSafeShellCommand } from '../core/security';
import path from 'path';

export interface ToolExecutionResult { success: boolean; result: any; error: string | null; executionTime: number; metadata?: Record<string, any>; }
/** Single execution boundary for Layra; no Hermes/OpenClaw process or gateway is required. */
export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry; private readonly state: AgentState; private readonly runtime: NativeRuntime; private readonly processRegistry: ProcessRegistry; private readonly memoryStore: MemoryStore;
  constructor(toolRegistry: ToolRegistry, state: AgentState) { this.toolRegistry = toolRegistry; this.state = state; this.runtime = new NativeRuntime(); this.processRegistry = new ProcessRegistry(); this.memoryStore = new MemoryStore(); }
  async execute(toolName: string, parameters: Record<string, any>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const startTime = Date.now(); let result: ToolExecutionResult;
    try { if (!this.toolRegistry.isToolAvailable(toolName)) result = this.fail(toolName, 'Tool is not available or permission is not granted', startTime); else if (signal?.aborted) result = this.fail(toolName, 'Execution aborted', startTime); else { await this.toolRegistry.runBeforeHooks(toolName, parameters, { signal, goal: this.state.currentGoal, sessionId: this.state.id }); result = await this.dispatch(toolName, parameters, startTime, signal); } }
    catch (error) { result = this.fail(toolName, error instanceof Error ? error.message : String(error), startTime); }
    try { await this.toolRegistry.runAfterHooks(toolName, parameters, result, { signal, goal: this.state.currentGoal, sessionId: this.state.id }); } catch (error) { result = { ...result, success: false, error: `${result.error ? `${result.error}; ` : ''}after-hook failed: ${error instanceof Error ? error.message : String(error)}` }; }
    const action = { actionId: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, stepId: null, tool: toolName, success: result.success, result: result.result, error: result.error, executionTime: result.executionTime, timestamp: new Date(), metadata: result.metadata || {} };
    this.state.lastActionResult = action; this.state.executionHistory.push(action); this.state.totalActions += 1; this.state.successRate = this.state.executionHistory.filter(item => item.success).length / this.state.executionHistory.length; this.state.averageResponseTime = this.state.executionHistory.reduce((sum, item) => sum + item.executionTime, 0) / this.state.executionHistory.length; this.state.lastUpdated = new Date(); return result;
  }
  private async dispatch(toolName: string, parameters: Record<string, any>, startTime: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    switch (toolName) {
      case 'filesystem.read': return this.wrap(await this.runtime.filesystemRead(parameters), startTime);
      case 'filesystem.list': return this.wrap(await this.runtime.filesystemList(parameters), startTime);
      case 'filesystem.write': return this.wrap(await this.runtime.filesystemWrite(parameters), startTime);
      case 'shell.execute': return this.wrap(await this.runtime.shellExecute(parameters, signal), startTime);
      case 'process.start': { if (process.env.LAYRA_ALLOW_SHELL !== 'true') return this.fail(toolName, 'Shell execution disabled; set LAYRA_ALLOW_SHELL=true to enable it', startTime); const command = String(parameters.command || '').trim(); assertSafeShellCommand(command); const cwd = path.resolve(this.runtime.workspaceRoot, String(parameters.cwd || '.')); const rel = path.relative(this.runtime.workspaceRoot, cwd); if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return this.fail(toolName, 'Working directory escapes Layra workspace', startTime); return this.ok(this.processRegistry.start(command, cwd, this.safeChildEnv()), startTime, { executor: 'native-process', background: true }); }
      case 'process.poll': return this.ok(this.processRegistry.poll(String(parameters.id || '')), startTime, { executor: 'native-process' });
      case 'process.list': return this.ok(this.processRegistry.list(), startTime, { executor: 'native-process' });
      case 'process.kill': return this.ok(this.processRegistry.kill(String(parameters.id || '')), startTime, { executor: 'native-process' });
      case 'process.wait': return this.ok(await this.processRegistry.wait(String(parameters.id || ''), Math.max(1, Math.min(120000, Number(parameters.timeoutMs || 30000)))), startTime, { executor: 'native-process' });
      case 'web.get': return this.wrap(await this.runtime.webGet(parameters, signal), startTime);
      case 'web.post': return this.wrap(await this.runtime.webPost(parameters, signal), startTime);
      case 'system.time': return this.ok(new Date().toISOString(), startTime, { executor: 'native-system' });
      case 'system.info': return this.wrap(this.runtime.systemInfo(), startTime);
      case 'memory.get': { const query = String(parameters.query || ''); const records = query ? await this.memoryStore.search(query, Math.max(1, Number(parameters.limit || 8))) : await this.memoryStore.recent(Math.max(1, Number(parameters.limit || 8))); return this.ok(records, startTime, { executor: 'layra-memory', persistent: true }); }
      case 'memory.set': { const content = String(parameters.content || '').trim(); if (!content) return this.fail(toolName, 'Memory content is required', startTime); const kind = ['fact','lesson','preference','procedure','event'].includes(String(parameters.kind)) ? String(parameters.kind) as any : 'fact'; const record = await this.memoryStore.remember({ kind, content, tags: Array.isArray(parameters.tags) ? parameters.tags.map(String).slice(0, 20) : [], importance: Math.max(0, Math.min(10, Number(parameters.importance ?? 5))), source: parameters.source ? String(parameters.source) : 'Layra' }); this.state.longTermMemory.lastRecord = record; return this.ok(record, startTime, { executor: 'layra-memory', persistent: true }); }
      default: return this.fail(toolName, `Unsupported tool: ${toolName}`, startTime);
    }
  }
  private safeChildEnv(): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; const allow = new Set(['PATH','HOME','PWD','OLDPWD','TERM','LANG','LC_ALL','TMPDIR','PREFIX','ANDROID_ROOT','ANDROID_DATA','SHELL','USER','USERNAME','LOGNAME','NODE_PATH']); for (const [key,value] of Object.entries(process.env)) if (allow.has(key) || key.startsWith('LAYRA_')) env[key] = value; for (const key of ['NVIDIA_API_KEY','DEEPSEEK_API_KEY','OPENROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY']) delete env[key]; return env; }
  private wrap(output: { value: any; metadata: Record<string, any> }, startTime: number): ToolExecutionResult { return this.ok(output.value, startTime, output.metadata); }
  private ok(value: any, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: true, result: value, error: null, executionTime: Date.now() - startTime, metadata }; }
  private fail(toolName: string, error: string, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: false, result: null, error: `[${toolName}] ${error}`, executionTime: Date.now() - startTime, metadata }; }
  async executeWithTimeout(toolName: string, parameters: Record<string, any>, timeoutMs = 30000): Promise<ToolExecutionResult> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs)); try { return await this.execute(toolName, parameters, controller.signal); } finally { clearTimeout(timer); } }
  formatForModel(result: ToolExecutionResult, maxChars = 12000): string { return normalizeToolResult({ success: result.success, result: result.result, error: result.error }, maxChars); }
}
