import { ChatMessage, createModelClient, ModelClient } from '../config/model-provider';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { compressMessages } from '../core/context';
import { normalizeToolResult, toProviderToolName } from '../core/tool-protocol';

export interface ToolLoopOptions { maxRounds?: number; maxToolCallsPerRound?: number; signal?: AbortSignal; client?: ModelClient; }
export interface ToolLoopResult { content: string; rounds: number; toolCalls: number; stoppedReason: 'completed' | 'no_model' | 'aborted' | 'round_limit' | 'tool_error'; messages: ChatMessage[]; }

/**
 * Provider-neutral model↔tool loop.
 *
 * The loop deliberately supports longer goals without making the budget unbounded:
 * a normal turn gets up to 16 model/tool rounds by default, with an absolute cap of 64.
 */
export async function runToolLoop(initialMessages: ChatMessage[], registry: ToolRegistry, executor: ToolExecutor, options: ToolLoopOptions = {}): Promise<ToolLoopResult> {
  const client = options.client || createModelClient();
  if (!client) return { content: '', rounds: 0, toolCalls: 0, stoppedReason: 'no_model', messages: [...initialMessages] };
  const configuredRounds = Number.isFinite(options.maxRounds) ? Number(options.maxRounds) : Number(process.env.LAYRA_DEFAULT_MAX_TOOL_ROUNDS || 16);
  const configuredCalls = Number.isFinite(options.maxToolCallsPerRound) ? Number(options.maxToolCallsPerRound) : Number(process.env.LAYRA_DEFAULT_MAX_TOOL_CALLS_PER_ROUND || 8);
  const maxRounds = Math.max(1, Math.min(64, configuredRounds));
  const maxCalls = Math.max(1, Math.min(32, configuredCalls));
  let messages = [...initialMessages];
  let totalCalls = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) return { content: '', rounds: round - 1, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
    messages = compressMessages(messages, {
      maxMessages: Math.max(8, Number(process.env.LAYRA_MAX_CONTEXT_MESSAGES || 40)),
      maxChars: Math.max(8000, Number(process.env.LAYRA_MAX_CONTEXT_CHARS || 60000))
    });

    const availableTools = registry.getAvailableTools();
    let turn;
    try {
      turn = await client.chatWithTools(messages, {
        tools: availableTools,
        toolChoice: 'auto',
        temperature: 0.2,
        maxTokens: 1600,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      return { content: `Model error: ${error instanceof Error ? error.message : String(error)}`, rounds: round, toolCalls: totalCalls, stoppedReason: 'tool_error', messages };
    }

    const normalized = turn;
    const rawToolCalls = turn.raw?.choices?.[0]?.message?.tool_calls;
    messages.push({ role: 'assistant', content: normalized.content, ...(Array.isArray(rawToolCalls) && rawToolCalls.length ? { tool_calls: rawToolCalls } : {}) });
    if (!normalized.toolCalls.length) return { content: normalized.content, rounds: round, toolCalls: totalCalls, stoppedReason: 'completed', messages };

    const seenIds = new Set<string>();
    const uniqueCalls = normalized.toolCalls.filter(call => {
      if (seenIds.has(call.id)) return false;
      seenIds.add(call.id);
      return true;
    });
    const executableCalls = uniqueCalls.slice(0, maxCalls);

    for (const call of executableCalls) {
      totalCalls += 1;
      if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      const result = await executor.execute(call.name, call.arguments, options.signal);
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: toProviderToolName(call.name),
        content: normalizeToolResult({ success: result.success, result: result.result, error: result.error })
      });
    }

    for (const call of uniqueCalls.slice(maxCalls)) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: toProviderToolName(call.name),
        content: normalizeToolResult({ success: false, result: null, error: `Tool-call budget exceeded (${maxCalls} calls per round)` })
      });
    }
  }

  return {
    content: `The tool-loop reached its execution budget after ${maxRounds} rounds. Continue from the existing evidence/state rather than restarting the task.`,
    rounds: maxRounds,
    toolCalls: totalCalls,
    stoppedReason: 'round_limit',
    messages
  };
}
