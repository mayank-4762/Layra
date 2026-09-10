import { ChatMessage, createModelClient } from '../config/model-provider';
import { runToolLoop, ToolLoopResult } from './tool-loop';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';

export interface ChildTask { id: string; prompt: string; parentGoal?: string | null; status: 'running' | 'completed' | 'failed' | 'cancelled'; result?: ToolLoopResult; }

/** Internal delegation: child tasks reuse the same Layra runtime surface, permissions and model provider. */
export class LayraDelegator {
  private readonly tasks = new Map<string, ChildTask>();
  private readonly controllers = new Map<string, AbortController>();
  constructor(private readonly registry: ToolRegistry, private readonly executor: ToolExecutor) {}

  async run(prompt: string, options: { maxRounds?: number; signal?: AbortSignal; parentGoal?: string | null } = {}): Promise<ChildTask> {
    const value = prompt.trim();
    if (!value) throw new Error('Child task prompt cannot be empty');
    const task: ChildTask = { id: `child_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, prompt: value, parentGoal: options.parentGoal, status: 'running' };
    this.tasks.set(task.id, task);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.controllers.set(task.id, controller);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an internal Layra child task. You are not a separate agent. Work only on the assigned subtask, use available tools when necessary, and return evidence rather than unsupported claims.' },
      { role: 'user', content: value }
    ];
    try {
      const result = await runToolLoop(messages, this.registry, this.executor, { maxRounds: options.maxRounds ?? 6, signal: controller.signal, client: createModelClient() || undefined });
      task.result = result;
      task.status = result.stoppedReason === 'completed' ? 'completed' : result.stoppedReason === 'aborted' ? 'cancelled' : 'failed';
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'failed';
      task.result = { content: error instanceof Error ? error.message : String(error), rounds: 0, toolCalls: 0, stoppedReason: task.status === 'cancelled' ? 'aborted' : 'tool_error', messages };
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      this.controllers.delete(task.id);
    }
    return { ...task };
  }

  async runMany(prompts: string[], options: { maxRounds?: number; signal?: AbortSignal; parentGoal?: string | null } = {}): Promise<ChildTask[]> {
    const bounded = prompts.map(prompt => prompt.trim()).filter(Boolean).slice(0, 4);
    return Promise.all(bounded.map(prompt => this.run(prompt, options)));
  }

  list(): ChildTask[] { return [...this.tasks.values()].map(task => ({ ...task })); }

  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return false;
    const controller = this.controllers.get(id);
    if (!controller) return false;
    controller.abort();
    task.status = 'cancelled';
    return true;
  }
}
