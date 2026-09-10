export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface DeepSeekOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
}

export interface DeepSeekResult {
  content: string;
  raw: any;
}

/** Direct DeepSeek API client. No OpenRouter/OmniRoute dependency. */
export class DeepSeekClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(options: { apiKey?: string; baseUrl?: string; model?: string } = {}) {
    const key = options.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error('DEEPSEEK_API_KEY environment variable is not set');
    this.apiKey = key;
    this.baseUrl = (options.baseUrl || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
    this.defaultModel = options.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
  }

  async chat(messages: DeepSeekMessage[], options: DeepSeekOptions = {}): Promise<DeepSeekResult> {
    const body: Record<string, any> = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2000,
      thinking: { type: 'enabled' }
    };
    if (options.json) body.response_format = { type: 'json_object' };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let raw: any;
    try { raw = text ? JSON.parse(text) : null; } catch { raw = { rawText: text }; }
    if (!response.ok) {
      throw new Error(`DeepSeek API HTTP ${response.status}: ${raw?.error?.message || text.slice(0, 300)}`);
    }

    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('DeepSeek API returned no assistant content');
    return { content, raw };
  }

  async analyze(prompt: string, options: DeepSeekOptions = {}): Promise<any> {
    const result = await this.chat([
      { role: 'system', content: 'You are Layra DHS: an analytical and learning subsystem. Be evidence-driven, concise, and return valid JSON when requested.' },
      { role: 'user', content: prompt }
    ], options);
    if (!options.json) return result.content;
    try { return JSON.parse(result.content); } catch {
      throw new Error('DeepSeek returned non-JSON content when JSON output was required');
    }
  }
}

export default DeepSeekClient;
