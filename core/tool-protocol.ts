import { Tool } from '../agent/state';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  success: boolean;
}

export interface ModelToolTurn {
  content: string;
  toolCalls: ToolCall[];
  raw: any;
}

/** Map Layra's dotted internal tool names to provider-safe function names. */
export function toProviderToolName(name: string): string {
  return String(name || '').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function toInternalToolName(name: string, tools: Tool[]): string {
  const candidate = String(name || '').trim();
  const exact = tools.find(tool => tool.name === candidate);
  if (exact) return exact.name;
  const matches = tools.filter(tool => toProviderToolName(tool.name) === candidate);
  if (matches.length === 1) return matches[0].name;
  return candidate;
}

export function normalizeToolCalls(raw: any, tools: Tool[] = []): ToolCall[] {
  const calls = raw?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call: any, index: number) => {
    const providerName = String(call?.function?.name || '').trim();
    if (!providerName) return [];
    const name = toInternalToolName(providerName, tools);
    let args: Record<string, any> = {};
    const source = call?.function?.arguments;
    if (typeof source === 'string') {
      try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch { args = {}; }
    } else if (source && typeof source === 'object' && !Array.isArray(source)) {
      args = source;
    }
    return [{ id: String(call?.id || `call_${Date.now()}_${index}`), name, arguments: args }];
  });
}

export function toOpenAICompatibleTools(tools: Tool[]): any[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: toProviderToolName(tool.name),
      description: tool.description,
      parameters: {
        type: 'object',
        properties: tool.parameters,
        additionalProperties: false
      }
    }
  }));
}

export function normalizeToolResult(value: any, maxChars = 12000): string {
  let text: string;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); }
  catch { text = String(value); }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[tool result truncated]` : text;
}

export function extractModelTurn(raw: any, tools: Tool[] = []): ModelToolTurn {
  const message = raw?.choices?.[0]?.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(raw, tools),
    raw
  };
}
