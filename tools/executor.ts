import { ToolRegistry } from '../tools/registry';
import { AgentState } from '../agent/state';
import { NativeRuntime } from './native-runtime';
import { ProcessRegistry } from './process-registry';
import { MemoryStore } from '../core/memory';
import { searchSessionEvents } from '../core/session-search';
import { normalizeToolResult } from '../core/tool-protocol';
import { assertSafeShellCommand } from '../core/security';
import { BrowserCdp } from './browser-cdp';
import { LayraMcpClient } from './mcp-client';
import { LayraScheduler } from '../agent/scheduler';
import { LayraDelegator } from '../agent/delegation';
import { AndroidTermuxBridge } from './android-termux';
import { AndroidControlBridge } from './android-control';
import { registerAndroidControlTools } from './phase4-tool-registration';
import path from 'path';

export interface ToolExecutionResult { success: boolean; result: any; error: string | null; executionTime: number; metadata?: Record<string, any>; }
/** Single execution boundary for Layra; all capabilities remain in one runtime. */
export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry; private readonly state: AgentState; private readonly runtime: NativeRuntime; private readonly processRegistry: ProcessRegistry; private readonly memoryStore: MemoryStore; private readonly browser: BrowserCdp; private readonly mcp: LayraMcpClient; private readonly scheduler: LayraScheduler; private readonly delegator: LayraDelegator; private readonly android: AndroidTermuxBridge; private readonly androidControl: AndroidControlBridge;
  constructor(toolRegistry: ToolRegistry, state: AgentState) { this.toolRegistry = toolRegistry; this.state = state; this.runtime = new NativeRuntime(); this.processRegistry = new ProcessRegistry(); this.memoryStore = new MemoryStore(); this.browser = new BrowserCdp(); this.mcp = new LayraMcpClient(); this.scheduler = new LayraScheduler(); this.delegator = new LayraDelegator(toolRegistry, this); this.android = new AndroidTermuxBridge(); this.androidControl = new AndroidControlBridge(); registerAndroidControlTools(this.toolRegistry, this.state); }
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
      case 'session.search': return this.ok(await searchSessionEvents(String(parameters.query || ''), Math.max(1, Number(parameters.limit || 20))), startTime, { executor: 'layra-session-search', persistent: true });
      case 'browser.navigate': return this.ok(await this.browser.navigate(String(parameters.url || ''), signal), startTime, { executor: 'chromium-cdp' });
      case 'browser.snapshot': return this.ok(await this.browser.snapshot(signal), startTime, { executor: 'chromium-cdp' });
      case 'browser.accessibility': return this.ok(await this.browser.accessibilitySnapshot(signal), startTime, { executor: 'chromium-cdp' });
      case 'browser.screenshot': return this.ok(await this.browser.screenshot(signal), startTime, { executor: 'chromium-cdp', binary: true });
      case 'browser.tabs': return this.ok(await this.browser.listTabs(), startTime, { executor: 'chromium-cdp' });
      case 'browser.click': return this.ok(await this.browser.click(String(parameters.selector || ''), signal), startTime, { executor: 'chromium-cdp' });
      case 'browser.type': return this.ok(await this.browser.type(String(parameters.selector || ''), String(parameters.text || ''), signal), startTime, { executor: 'chromium-cdp' });
      case 'browser.key': return this.ok(await this.browser.pressKey(String(parameters.key || ''), signal), startTime, { executor: 'chromium-cdp' });
      case 'mcp.list': return this.ok(await this.mcp.listTools(signal), startTime, { executor: 'layra-mcp' });
      case 'mcp.refresh': { const remote = await this.mcp.listTools(signal); const registered = this.toolRegistry.registerMcpTools(remote); return this.ok(registered, startTime, { executor: 'layra-mcp', registered: registered.length }); }
      case 'mcp.call': return this.ok(await this.mcp.callTool(String(parameters.name || ''), parameters.arguments && typeof parameters.arguments === 'object' ? parameters.arguments : {}, signal), startTime, { executor: 'layra-mcp' });
      case 'scheduler.add': return this.ok(await this.scheduler.add(String(parameters.prompt || ''), String(parameters.runAt || ''), parameters.intervalMs === undefined ? undefined : Number(parameters.intervalMs)), startTime, { executor: 'layra-scheduler', persistent: true });
      case 'scheduler.list': return this.ok(await this.scheduler.list(), startTime, { executor: 'layra-scheduler', persistent: true });
      case 'scheduler.remove': return this.ok(await this.scheduler.remove(String(parameters.id || '')), startTime, { executor: 'layra-scheduler', persistent: true });
      case 'delegate.run': return this.ok(await this.delegator.run(String(parameters.prompt || ''), { maxRounds: Math.max(1, Math.min(12, Number(parameters.maxRounds || 6))), signal, parentGoal: this.state.currentGoal }), startTime, { executor: 'layra-internal-delegation', unifiedRuntime: true });
      case 'delegate.run_many': { const prompts = Array.isArray(parameters.prompts) ? parameters.prompts.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4) : []; if (!prompts.length) return this.fail(toolName, 'prompts must contain 1-4 non-empty tasks', startTime); const results = await this.delegator.runMany(prompts, { maxRounds: Math.max(1, Math.min(12, Number(parameters.maxRounds || 6))), signal, parentGoal: this.state.currentGoal }); return this.ok(results, startTime, { executor: 'layra-internal-delegation', unifiedRuntime: true, parallel: true }); }
      case 'delegate.list': return this.ok(this.delegator.list(), startTime, { executor: 'layra-internal-delegation', unifiedRuntime: true });
      case 'delegate.cancel': return this.ok(this.delegator.cancel(String(parameters.id || '')), startTime, { executor: 'layra-internal-delegation', unifiedRuntime: true });
      case 'android.toast': return this.ok(await this.android.toast(String(parameters.text || '')), startTime, { executor: 'termux-android' });
      case 'android.notify': return this.ok(await this.android.notify(String(parameters.title || 'Layra'), String(parameters.content || '')), startTime, { executor: 'termux-android' });
      case 'android.open_url': return this.ok(await this.android.openUrl(String(parameters.url || '')), startTime, { executor: 'termux-android' });
      case 'android.clipboard_get': return this.ok(await this.android.clipboardGet(), startTime, { executor: 'termux-android' });
      case 'android.clipboard_set': return this.ok(await this.android.clipboardSet(String(parameters.text || '')), startTime, { executor: 'termux-android' });
      case 'android.control.health': return this.ok(await this.androidControl.health(signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.tree': return this.ok(await this.androidControl.tree(signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.tap': return this.ok(await this.androidControl.tap(parameters.selector && typeof parameters.selector === 'object' ? parameters.selector : {}, signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.type': return this.ok(await this.androidControl.type(parameters.selector && typeof parameters.selector === 'object' ? parameters.selector : {}, String(parameters.text || ''), signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.swipe': return this.ok(await this.androidControl.swipe(Number(parameters.startX), Number(parameters.startY), Number(parameters.endX), Number(parameters.endY), Number(parameters.durationMs || 400), signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.back': return this.ok(await this.androidControl.back(signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.home': return this.ok(await this.androidControl.home(signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.launch': return this.ok(await this.androidControl.launch(String(parameters.packageName || ''), parameters.activity ? String(parameters.activity) : undefined, signal), startTime, { executor: 'android-accessibility' });
      case 'android.control.screenshot': return this.ok(await this.androidControl.screenshot(signal), startTime, { executor: 'android-accessibility', binary: true });
      default: { const remote = this.toolRegistry.resolveMcpTool(toolName); if (remote) return this.ok(await this.mcp.callTool(remote, parameters, signal), startTime, { executor: 'layra-mcp', dynamic: true, remoteTool: remote }); return this.fail(toolName, `Unsupported tool: ${toolName}`, startTime); }
    }
  }
  private safeChildEnv(): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; const allow = new Set(['PATH','HOME','PWD','OLDPWD','TERM','LANG','LC_ALL','TMPDIR','PREFIX','ANDROID_ROOT','ANDROID_DATA','SHELL','USER','USERNAME','LOGNAME','NODE_PATH']); for (const [key,value] of Object.entries(process.env)) if (allow.has(key) || key.startsWith('LAYRA_')) env[key] = value; for (const key of ['NVIDIA_API_KEY','DEEPSEEK_API_KEY','OPENROUTER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY']) delete env[key]; return env; }
  private wrap(output: { value: any; metadata: Record<string, any> }, startTime: number): ToolExecutionResult { return this.ok(output.value, startTime, output.metadata); }
  private ok(value: any, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: true, result: value, error: null, executionTime: Date.now() - startTime, metadata }; }
  private fail(toolName: string, error: string, startTime: number, metadata: Record<string, any> = {}): ToolExecutionResult { return { success: false, result: null, error: `[${toolName}] ${error}`, executionTime: Date.now() - startTime, metadata }; }
  async executeWithTimeout(toolName: string, parameters: Record<string, any>, timeoutMs = 30000): Promise<ToolExecutionResult> { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs)); try { return await this.execute(toolName, parameters, controller.signal); } finally { clearTimeout(timer); } }
  formatForModel(result: ToolExecutionResult, maxChars = 12000): string { return normalizeToolResult({ success: result.success, result: result.result, error: result.error }, maxChars); }
}
