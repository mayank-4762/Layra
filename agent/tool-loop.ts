import { ChatMessage, createModelClient, ModelClient } from '../config/model-provider';
import { ToolExecutor } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import { compressMessages } from '../core/context';
import { normalizeToolResult, toProviderToolName } from '../core/tool-protocol';
import { enforceVerificationContract } from './task-contract';

export interface ToolLoopProgress {
  type: 'round_start' | 'model_complete' | 'tool_start' | 'tool_complete' | 'completed' | 'stopped';
  round: number;
  totalToolCalls: number;
  toolName?: string;
  success?: boolean;
  message?: string;
  elapsedMs: number;
}

export interface ToolLoopOptions {
  maxRounds?: number;
  maxToolCallsPerRound?: number;
  signal?: AbortSignal;
  client?: ModelClient;
  onProgress?: (progress: ToolLoopProgress) => void;
}
export interface ToolLoopResult { content: string; rounds: number; toolCalls: number; stoppedReason: 'completed' | 'no_model' | 'aborted' | 'round_limit' | 'tool_error'; messages: ChatMessage[]; }

/**
 * Provider-neutral model↔tool loop.
 *
 * Deterministic verification contracts are preflighted before the model is called.
 * This prevents a model from incorrectly treating an explicitly specified verification
 * procedure as missing input. Ordinary tasks continue through the normal model/tool loop.
 */
export async function runToolLoop(initialMessages: ChatMessage[], registry: ToolRegistry, executor: ToolExecutor, options: ToolLoopOptions = {}): Promise<ToolLoopResult> {
  const startedAt = Date.now();
  const emit = (progress: Omit<ToolLoopProgress, 'elapsedMs'>) => options.onProgress?.({ ...progress, elapsedMs: Date.now() - startedAt });
  const promptText = initialMessages.filter(message => message.role === 'user').map(message => message.content).join('\n');
  const preflight = await enforceVerificationContract(promptText, executor, null, { rounds: 0, toolCalls: 0 });
  if (preflight) {
    emit({ type: 'completed', round: preflight.result.rounds, totalToolCalls: preflight.result.toolCalls, message: preflight.content });
    return {
      content: preflight.content,
      rounds: preflight.result.rounds,
      toolCalls: preflight.result.toolCalls,
      stoppedReason: preflight.result.passed ? 'completed' : 'tool_error',
      messages: [...initialMessages, { role: 'assistant', content: preflight.content }]
    };
  }

  const client = options.client || createModelClient();
  if (!client) {
    emit({ type: 'stopped', round: 0, totalToolCalls: 0, message: 'No model client is configured.' });
    return { content: '', rounds: 0, toolCalls: 0, stoppedReason: 'no_model', messages: [...initialMessages] };
  }
  const configuredRounds = Number.isFinite(options.maxRounds) ? Number(options.maxRounds) : Number(process.env.LAYRA_DEFAULT_MAX_TOOL_ROUNDS || 16);
  const configuredCalls = Number.isFinite(options.maxToolCallsPerRound) ? Number(options.maxToolCallsPerRound) : Number(process.env.LAYRA_DEFAULT_MAX_TOOL_CALLS_PER_ROUND || 8);
  const maxRounds = Math.max(1, Math.min(64, configuredRounds));
  const maxCalls = Math.max(1, Math.min(32, configuredCalls));
  let messages = [...initialMessages];
  let totalCalls = 0;

  for (let round = 1; round <= maxRounds; round++) {
    if (options.signal?.aborted) {
      emit({ type: 'stopped', round: round - 1, totalToolCalls: totalCalls, message: 'Execution aborted.' });
      return { content: '', rounds: round - 1, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
    }
    emit({ type: 'round_start', round, totalToolCalls: totalCalls, message: `Starting model/tool round ${round} of ${maxRounds}.` });
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
      emit({ type: 'model_complete', round, totalToolCalls: totalCalls, message: turn.toolCalls.length ? `Model requested ${turn.toolCalls.length} tool call${turn.toolCalls.length === 1 ? '' : 's'}.` : 'Model returned a final response.' });
    } catch (error) {
      if (options.signal?.aborted) {
        emit({ type: 'stopped', round, totalToolCalls: totalCalls, message: 'Execution aborted while waiting for the model.' });
        return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      }
      const message = `Model error: ${error instanceof Error ? error.message : String(error)}`;
      emit({ type: 'stopped', round, totalToolCalls: totalCalls, message });
      return { content: message, rounds: round, toolCalls: totalCalls, stoppedReason: 'tool_error', messages };
    }

    const normalized = turn;
    const rawToolCalls = turn.raw?.choices?.[0]?.message?.tool_calls;
    messages.push({ role: 'assistant', content: normalized.content, ...(Array.isArray(rawToolCalls) && rawToolCalls.length ? { tool_calls: rawToolCalls } : {}) });
    if (!normalized.toolCalls.length) {
      emit({ type: 'completed', round, totalToolCalls: totalCalls, message: 'Model completed the turn without further tool calls.' });
      return { content: normalized.content, rounds: round, toolCalls: totalCalls, stoppedReason: 'completed', messages };
    }

    const seenIds = new Set<string>();
    const uniqueCalls = normalized.toolCalls.filter(call => {
      if (seenIds.has(call.id)) return false;
      seenIds.add(call.id);
      return true;
    });
    const executableCalls = uniqueCalls.slice(0, maxCalls);

    for (const call of executableCalls) {
      totalCalls += 1;
      if (options.signal?.aborted) {
        emit({ type: 'stopped', round, totalToolCalls: totalCalls, message: 'Execution aborted before the next tool call.' });
        return { content: '', rounds: round, toolCalls: totalCalls, stoppedReason: 'aborted', messages };
      }
      emit({ type: 'tool_start', round, totalToolCalls: totalCalls, toolName: call.name, message: `Running ${call.name}...` });
      const result = await executor.execute(call.name, call.arguments, options.signal);
      emit({ type: 'tool_complete', round, totalToolCalls: totalCalls, toolName: call.name, success: result.success, message: result.success ? `${call.name} completed.` : `${call.name} failed: ${result.error || 'unknown error'}` });
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

  const message = `The tool-loop reached its execution budget after ${maxRounds} rounds. Continue from the existing evidence/state rather than restarting the task.`;
  emit({ type: 'stopped', round: maxRounds, totalToolCalls: totalCalls, message });
  return {
    content: message,
    rounds: maxRounds,
    toolCalls: totalCalls,
    stoppedReason: 'round_limit',
    messages
  };
}