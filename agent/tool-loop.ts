import { ChatMessage, createModelClient } from '../config/model-provider';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { compressMessages } from '../core/context';
import { normalizeToolResult, extractModelTurn } from '../core/tool-protocol';

export interface ToolLoopOptions { maxRounds?: number; maxToolCallsPerRound?: number; signal?: AbortSignal; }
export interface ToolLoopResult { content: string; rounds: number; toolCalls: number; stoppedReason: 'completed' | 'no_model' | 'aborted' | 'round_limit' | 'tool_error'; messages: ChatMessage[]; }

/** Provider-neutral tool loop with bounded context, policy admission and native execution. */
export async function runToolLoop(initialMessages: ChatMessage[], registry: ToolRegistry, executor: ToolExecutor, options: ToolLoopOptions = {}): Promise<ToolLoopResult> {
  const client = createModelClient();
  if (!client) return { content: '', rounds: 0, toolCalls: 0, stoppedReason: 'no_model', messages: initialMessages };
  const maxRounds = Math.max(1, Math.min(32, options.maxRounds ?? 8)); const maxCalls = Math.max(1, Math.min(32, options.maxToolCallsPerRound ?? 8));
  let messages = [...initialMessages]; let totalCalls = 0;
  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) return { content: '', rounds: round - 1, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
    messages = compressMessages(messages, { maxMessages: Number(process.env.LAYRA_MAX_CONTEXT_MESSAGES || 40), maxChars: Number(process.env.LAYRA_MAX_CONTEXT_CHARS || 60000) });
    let turn;
    try { turn = await client.chatWithTools(messages, { tools: registry.getAvailableTools(), toolChoice: 'auto', temperature: 0.2, maxTokens: 1600, signal: options.signal }); }
    catch (error) { if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages }; return { content: `Model error: ${error instanceof Error ? error.message : String(error)}`, rounds: round, toolCalls: totalCalls, stoppedReason: 'tool_error', messages }; }
    const normalized = extractModelTurn(turn.raw);
    messages.push({ role: 'assistant', content: normalized.content, tool_calls: turn.raw?.choices?.[0]?.message?.tool_calls || [] });
    if (!normalized.toolCalls.length) return { content: normalized.content, rounds: round, toolCalls: totalCalls, stoppedReason: 'completed', messages };
    const seenIds = new Set<string>();
    for (const call of normalized.toolCalls.slice(0, maxCalls)) {
      if (seenIds.has(call.id)) continue;
      seenIds.add(call.id); totalCalls += 1;
      if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      const result = await executor.execute(call.name, call.arguments, options.signal);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: normalizeToolResult({ success: result.success, result: result.result, error: result.error }) });
      if (!result.success) messages.push({ role: 'user', content: `Tool ${call.name} failed. Treat the result as evidence and do not claim success.` });
    }
  }
  return { content: '', rounds: maxRounds, toolCalls: totalCalls, stoppedReason: 'round_limit', messages };
}
