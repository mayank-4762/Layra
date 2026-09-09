import { Tool } from '../agent/state';
import { extractModelTurn, ModelToolTurn, toOpenAICompatibleTools } from '../core/tool-protocol';

export interface ModelConfig {
  name: string;
  provider: string;
  apiKeyEnv: string;
  apiEndpoint: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: any[];
}

export interface ChatResult { content: string; raw: any; }
export interface ModelToolOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | 'required';
  signal?: AbortSignal;
}

export interface ModelClient {
  provider: string;
  apiKeyConfigured: boolean;
  baseUrl: string;
  defaultModel: string;
  temperature: number;
  maxTokens: number;
  chat(messages: ChatMessage[], options?: ModelToolOptions): Promise<ChatResult>;
  chatWithTools(messages: ChatMessage[], options: ModelToolOptions & { tools: Tool[] }): Promise<ModelToolTurn>;
}

export function getModelConfig(): ModelConfig {
  return {
    name: process.env.LAYRA_MODEL_NAME || process.env.LAYRA_MODEL || 'nemotron-3.5-lightning-30b-a3b',
    provider: process.env.LAYRA_MODEL_PROVIDER || 'nvidia',
    apiKeyEnv: process.env.LAYRA_MODEL_API_KEY_ENV || 'NVIDIA_API_KEY',
    apiEndpoint: process.env.LAYRA_MODEL_API_ENDPOINT || 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: process.env.LAYRA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
    temperature: Number(process.env.LAYRA_MODEL_TEMPERATURE || 0.7),
    maxTokens: Number(process.env.LAYRA_MODEL_MAX_TOKENS || 4000)
  };
}

export const DEFAULT_MODEL = getModelConfig();

export function createModelClient(apiKey?: string): ModelClient | null {
  const config = getModelConfig();
  const key = apiKey || process.env[config.apiKeyEnv];
  if (!key) return null;

  const request = async (messages: ChatMessage[], options: ModelToolOptions = {}): Promise<any> => {
    const body: any = {
      model: options.model || config.model,
      messages,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxTokens
    };
    if (options.tools?.length) {
      body.tools = toOpenAICompatibleTools(options.tools);
      body.tool_choice = options.toolChoice || 'auto';
    }
    const response = await fetch(config.apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: options.signal
    });
    const text = await response.text();
    let raw: any;
    try { raw = text ? JSON.parse(text) : null; } catch { raw = { rawText: text }; }
    if (!response.ok) throw new Error(`${config.provider} API HTTP ${response.status}: ${raw?.error?.message || text.slice(0, 300)}`);
    return raw;
  };

  return {
    provider: config.provider,
    apiKeyConfigured: true,
    baseUrl: config.apiEndpoint,
    defaultModel: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    async chat(messages, options = {}) {
      const raw = await request(messages, options);
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`${config.provider} API returned no assistant content`);
      return { content, raw };
    },
    async chatWithTools(messages, options) {
      const raw = await request(messages, options);
      return extractModelTurn(raw, options.tools);
    }
  };
}

export async function testModelConnection(): Promise<{ success: boolean; message: string }> {
  const config = getModelConfig();
  const client = createModelClient();
  if (!client) return { success: false, message: `No API key configured for ${config.provider} (${config.apiKeyEnv})` };
  try {
    const result = await client.chat([{ role: 'user', content: 'Respond with only OK.' }], { temperature: 0, maxTokens: 10 });
    return { success: Boolean(result.content.trim()), message: `${config.provider} model responded: ${result.content.trim().slice(0, 40)}` };
  } catch (error) {
    return { success: false, message: `${config.provider} connection error: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export default { getModelConfig, DEFAULT_MODEL, createModelClient, testModelConnection };
