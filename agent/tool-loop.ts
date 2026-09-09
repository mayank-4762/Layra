import { ChatMessage, createModelClient, ModelClient } from '../config/model-provider';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { compressMessages } from '../core/context';
import { normalizeToolResult, extractModelTurn } from '../core/tool-protocol';

export interface ToolLoopOptions { maxRounds?: number; maxToolCallsPerRound?: number; signal?: AbortSignal; client?: ModelClient; }
export interface ToolLoopResult { content: string; rounds: number; toolCalls: number; stoppedReason: 'completed' | 'no_model' | 'aborted' | 'round_limit' | 'tool_error'; messages: ChatMessage[]; }

/** Provider-neutral model↔tool loop. The model client is injectable so the runtime can be tested without network access. */
export async function runToolLoop(initialMessages: ChatMessage[], registry: ToolRegistry, executor: ToolExecutor, options: ToolLoopOptions = {}): Promise<ToolLoopResult> {
  const client = options.client || createModelClient();
  if (!client) return { content: '', rounds: 0, toolCalls: 0, stoppedReason: 'no_model', messages: [...initialMessages] };
  const maxRounds = Math.max(1, Math.min(32, options.maxRounds ?? 8));
  const maxCalls = Math.max(1, Math.min(32, options.maxToolCallsPerRound ?? 8));
  let messages = [...initialMessages];
  let totalCalls = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) return { content: '', rounds: round - 1, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
    messages = compressMessages(messages, {
      maxMessages: Math.max(8, Number(process.env.LAYRA_MAX_CONTEXT_MESSAGES || 40)),
      maxChars: Math.max(8000, Number(process.env.LAYRA_MAX_CONTEXT_CHARS || 60000))
    });

    let turn;
    try {
      turn = await client.chatWithTools(messages, {
        tools: registry.getAvailableTools(),
        toolChoice: 'auto',
        temperature: 0.2,
        maxTokens: 1600,
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      return { content: `Model error: ${error instanceof Error ? error.message : String(error)}`, rounds: round, toolCalls: totalCalls, stoppedReason: 'tool_error', messages };
    }

    const normalized = extractModelTurn(turn.raw);
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
        name: call.name,
        content: normalizeToolResult({ success: result.success, result: result.result, error: result.error })
      });
    }

    // Every assistant tool_call must receive a tool result before the next model request.
    // Calls beyond the per-round budget are represented as explicit failures instead of
    // being silently dropped, which keeps OpenAI-compatible transcripts valid.
    for (const call of uniqueCalls.slice(maxCalls)) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.name,
        content: normalizeToolResult({ success: false, result: null, error: `Tool-call budget exceeded (${maxCalls} calls per round)` })
      });
    }
  }

  return { content: '', rounds: maxRounds, toolCalls: totalCalls, stoppedReason: 'round_limit', messages };
}
