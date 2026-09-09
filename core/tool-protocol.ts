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

export function normalizeToolCalls(raw: any): ToolCall[] {
  const calls = raw?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call: any, index: number) => {
    const name = String(call?.function?.name || '').trim();
    if (!name) return [];
    let args: Record<string, any> = {};
    const source = call?.function?.arguments;
    if (typeof source === 'string') {
      try {
        const parsed = JSON.parse(source);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed;
      } catch {
        args = {};
      }
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
      name: tool.name,
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
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[tool result truncated]` : text;
}

export function extractModelTurn(raw: any): ModelToolTurn {
  const message = raw?.choices?.[0]?.message || {};
  return {
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: normalizeToolCalls(raw),
    raw
  };
}
