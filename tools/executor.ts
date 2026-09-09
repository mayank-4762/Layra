import { ToolRegistry } from '../tools/registry';
import { AgentState } from '../agent/state';
import { NativeRuntime } from './native-runtime';

export interface ToolExecutionResult {
  success: boolean;
  result: any;
  error: string | null;
  executionTime: number;
  metadata?: Record<string, any>;
}

/** Single execution boundary for Layra. No external agent/gateway is involved. */
export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly state: AgentState;
  private readonly runtime: NativeRuntime;

  constructor(toolRegistry: ToolRegistry, state: AgentState) {
    this.toolRegistry = toolRegistry;
    this.state = state;
    this.runtime = new NativeRuntime();
  }

  async execute(toolName: string, parameters: Record<string, any>, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let result: ToolExecutionResult;
    try {
      if (!this.toolRegistry.isToolAvailable(toolName)) {
        result = this.fail(toolName, 'Tool is not available or permission is not granted', startTime);
      } else if (signal?.aborted) {
        result = this.fail(toolName, 'Execution aborted', startTime);
      } else {
        result = await this.dispatch(toolName, parameters, startTime, signal);
      }
    } catch (error) {
      result = this.fail(toolName, error instanceof Error ? error.message : String(error), startTime);
    }

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
    const successes = this.state.executionHistory.filter(item => item.success).length;
    this.state.successRate = successes / this.state.executionHistory.length;
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
        const key = String(parameters.key || '');
        return this.ok((this.state.longTermMemory || {})[key] ?? parameters.default ?? null, startTime, { executor: 'layra-memory' });
      }
      case 'memory.set': {
        const key = String(parameters.key || '');
        if (!key) return this.fail(toolName, 'Memory key is required', startTime);
        this.state.longTermMemory = { ...(this.state.longTermMemory || {}), [key]: parameters.value };
        return this.ok(true, startTime, { executor: 'layra-memory' });
      }
      default: return this.fail(toolName, `Unsupported tool: ${toolName}`, startTime);
    }
  }

  private wrap(output: { value: any; metadata: Record<string, any> }, startTime: number): ToolExecutionResult {
    return this.ok(output.value, startTime, output.metadata);
  }
  private ok(value: any, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: true, result: value, error: null, executionTime: Date.now() - startTime, metadata }; }
  private fail(toolName: string, error: string, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: false, result: null, error: `[${toolName}] ${error}`, executionTime: Date.now() - startTime, metadata }; }

  async executeWithTimeout(toolName: string, parameters: Record<string, any>, timeoutMs = 30000): Promise<ToolExecutionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      return await this.execute(toolName, parameters, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}
