import { ChatMessage, createModelClient } from '../config/model-provider';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { extractModelTurn, normalizeToolResult } from '../core/tool-protocol';

export interface ToolLoopOptions {
  maxRounds?: number;
  maxToolCallsPerRound?: number;
  signal?: AbortSignal;
}

export interface ToolLoopResult {
  content: string;
  rounds: number;
  toolCalls: number;
  stoppedReason: 'completed' | 'no_model' | 'aborted' | 'round_limit' | 'tool_error';
  messages: ChatMessage[];
}

/**
 * Provider-neutral tool loop: model proposes calls, Layra validates/executes them, then
 * feeds canonical tool results back to the same model. This is the single-process equivalent
 * of Hermes' persisted tool-round lifecycle and OpenClaw's assembled execution surface.
 */
export async function runToolLoop(
  initialMessages: ChatMessage[],
  registry: ToolRegistry,
  executor: ToolExecutor,
  options: ToolLoopOptions = {}
): Promise<ToolLoopResult> {
  const client = createModelClient();
  if (!client) return { content: '', rounds: 0, toolCalls: 0, stoppedReason: 'no_model', messages: initialMessages };
  const maxRounds = Math.max(1, Math.min(32, options.maxRounds ?? 8));
  const maxCalls = Math.max(1, Math.min(32, options.maxToolCallsPerRound ?? 8));
  const messages = [...initialMessages];
  let totalCalls = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) return { content: '', rounds: round - 1, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
    const raw = (await client.chatWithTools(messages, { tools: registry.getAvailableTools(), toolChoice: 'auto', temperature: 0.2, maxTokens: 1600 })).raw;
    const turn = extractModelTurn(raw);
    messages.push({ role: 'assistant', content: turn.content, tool_calls: raw?.choices?.[0]?.message?.tool_calls || [] });
    if (!turn.toolCalls.length) return { content: turn.content, rounds: round, toolCalls: totalCalls, stoppedReason: 'completed', messages };

    const calls = turn.toolCalls.slice(0, maxCalls);
    for (const call of calls) {
      totalCalls += 1;
      if (options.signal?.aborted) return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      const result = await executor.execute(call.name, call.arguments, options.signal);
      messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: normalizeToolResult({ success: result.success, result: result.result, error: result.error }) });
      if (!result.success) messages.push({ role: 'user', content: `Tool ${call.name} failed. Treat this as execution evidence; do not claim success.` });
    }
  }
  return { content: '', rounds: maxRounds, toolCalls: totalCalls, stoppedReason: 'round_limit', messages };
}
