import { ChatMessage, createModelClient } from '../config/model-provider';
import { runToolLoop, ToolLoopResult } from './tool-loop';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';

export interface ChildTask { id: string; prompt: string; parentGoal?: string | null; status: 'running' | 'completed' | 'failed'; result?: ToolLoopResult; }

/** Internal delegation: child tasks reuse the same Layra runtime surface, permissions and model provider. */
export class LayraDelegator {
  private readonly tasks = new Map<string, ChildTask>();
  constructor(private readonly registry: ToolRegistry, private readonly executor: ToolExecutor) {}

  async run(prompt: string, options: { maxRounds?: number; signal?: AbortSignal; parentGoal?: string | null } = {}): Promise<ChildTask> {
    const value = prompt.trim();
    if (!value) throw new Error('Child task prompt cannot be empty');
    const task: ChildTask = { id: `child_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, prompt: value, parentGoal: options.parentGoal, status: 'running' };
    this.tasks.set(task.id, task);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are an internal Layra child task. You are not a separate agent. Work only on the assigned subtask, use available tools when necessary, and return evidence rather than unsupported claims.' },
      { role: 'user', content: value }
    ];
    try {
      const result = await runToolLoop(messages, this.registry, this.executor, { maxRounds: options.maxRounds ?? 6, signal: options.signal, client: createModelClient() || undefined });
      task.result = result;
      task.status = result.stoppedReason === 'completed' ? 'completed' : 'failed';
    } catch (error) {
      task.status = 'failed';
      task.result = { content: error instanceof Error ? error.message : String(error), rounds: 0, toolCalls: 0, stoppedReason: 'tool_error', messages };
    }
    return { ...task };
  }

  list(): ChildTask[] { return [...this.tasks.values()].map(task => ({ ...task })); }
}
