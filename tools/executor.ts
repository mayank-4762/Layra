import { ToolRegistry } from '../tools/registry';
import { AgentState } from '../agent/state';
import { NativeRuntime } from './native-runtime';
import { MemoryStore } from '../core/memory';
import { normalizeToolResult } from '../core/tool-protocol';

export interface ToolExecutionResult {
  success: boolean;
  result: any;
  error: string | null;
  executionTime: number;
  metadata?: Record<string, any>;
}

/** Single execution boundary for Layra; no Hermes/OpenClaw process or gateway is required. */
export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly state: AgentState;
  private readonly runtime: NativeRuntime;
  private readonly memoryStore: MemoryStore;

  constructor(toolRegistry: ToolRegistry, state: AgentState) {
    this.toolRegistry = toolRegistry;
    this.state = state;
    this.runtime = new NativeRuntime();
    this.memoryStore = new MemoryStore();
  }

  async execute(toolName: string, parameters: Record<string, any>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let result: ToolExecutionResult;
    try {
      if (!this.toolRegistry.isToolAvailable(toolName)) result = this.fail(toolName, 'Tool is not available or permission is not granted', startTime);
      else if (signal?.aborted) result = this.fail(toolName, 'Execution aborted', startTime);
      else {
        await this.toolRegistry.runBeforeHooks(toolName, parameters, { signal, goal: this.state.currentGoal, sessionId: this.state.id });
        result = await this.dispatch(toolName, parameters, startTime, signal);
      }
    } catch (error) {
      result = this.fail(toolName, error instanceof Error ? error.message : String(error), startTime);
    }

    await this.toolRegistry.runAfterHooks(toolName, parameters, result, { signal, goal: this.state.currentGoal, sessionId: this.state.id });
    const action = {
      actionId: `action_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      stepId: null,
      tool: toolName,
      success: result.success,
      result: result.result,
      error: result.error,
      executionTime: result.executionTime,
      timestamp: new Date(),
      metadata: result.metadata || {}
    };
    this.state.lastActionResult = action;
    this.state.executionHistory.push(action);
    this.state.totalActions += 1;
    this.state.successRate = this.state.executionHistory.filter(item => item.success).length / this.state.executionHistory.length;
    this.state.averageResponseTime = this.state.executionHistory.reduce((sum, item) => sum + item.executionTime, 0) / this.state.executionHistory.length;
    this.state.lastUpdated = new Date();
    return result;
  }

  private async dispatch(toolName: string, parameters: Record<string, any>, startTime: number, signal?: AbortSignal): Promise<ToolExecutionResult> {
    switch (toolName) {
      case 'filesystem.read': return this.wrap(await this.runtime.filesystemRead(parameters), startTime);
      case 'filesystem.list': return this.wrap(await this.runtime.filesystemList(parameters), startTime);
      case 'filesystem.write': {
        if (process.env.LAYRA_ALLOW_LOCAL_WRITE !== 'true') return this.fail(toolName, 'File writes disabled; set LAYRA_ALLOW_LOCAL_WRITE=true to enable them', startTime);
        return this.wrap(await this.runtime.filesystemWrite(parameters), startTime);
      }
      case 'shell.execute': return this.wrap(await this.runtime.shellExecute(parameters, signal), startTime);
      case 'web.get': return this.wrap(await this.runtime.webGet(parameters, signal), startTime);
      case 'web.post': return this.wrap(await this.runtime.webPost(parameters, signal), startTime);
      case 'system.time': return this.ok(new Date().toISOString(), startTime, { executor: 'native-system' });
      case 'system.info': return this.wrap(this.runtime.systemInfo(), startTime);
      case 'memory.get': {
        const query = String(parameters.query || '');
        const records = query ? await this.memoryStore.search(query, Math.max(1, Number(parameters.limit || 8))) : await this.memoryStore.recent(Math.max(1, Number(parameters.limit || 8)));
        return this.ok(records, startTime, { executor: 'layra-memory', persistent: true });
      }
      case 'memory.set': {
        const content = String(parameters.content || '').trim();
        if (!content) return this.fail(toolName, 'Memory content is required', startTime);
        const kind = ['fact', 'lesson', 'preference', 'procedure', 'event'].includes(String(parameters.kind)) ? String(parameters.kind) as any : 'fact';
        const record = await this.memoryStore.remember({ kind, content, tags: Array.isArray(parameters.tags) ? parameters.tags.map(String).slice(0, 20) : [], importance: Math.max(0, Math.min(10, Number(parameters.importance ?? 5))), source: parameters.source ? String(parameters.source) : 'Layra' });
        this.state.longTermMemory.lastRecord = record;
        return this.ok(record, startTime, { executor: 'layra-memory', persistent: true });
      }
      default: return this.fail(toolName, `Unsupported tool: ${toolName}`, startTime);
    }
  }

  private wrap(output: { value: any; metadata: Record<string, any> }, startTime: number): ToolExecutionResult { return this.ok(output.value, startTime, output.metadata); }
  private ok(value: any, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: true, result: value, error: null, executionTime: Date.now() - startTime, metadata }; }
  private fail(toolName: string, error: string, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: false, result: null, error: `[${toolName}] ${error}`, executionTime: Date.now() - startTime, metadata }; }

  /** Abort is propagated to native runtime calls, not just raced at the Promise layer. */
  async executeWithTimeout(toolName: string, parameters: Record<string, any>, timeoutMs = 30000): Promise<ToolExecutionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try { return await this.execute(toolName, parameters, controller.signal); }
    finally { clearTimeout(timer); }
  }

  formatForModel(result: ToolExecutionResult, maxChars = 12000): string { return normalizeToolResult({ success: result.success, result: result.result, error: result.error }, maxChars); }
}
