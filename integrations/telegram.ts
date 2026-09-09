import { HybridAgent } from '../agent/agent';

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat?: { id?: number };
    text?: string;
    from?: { id?: number };
  };
}

interface TelegramResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramGatewayOptions {
  botToken?: string;
  allowedUserIds?: Set<number>;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

export class TelegramGateway {
  private readonly token: string;
  private readonly allowedUserIds: Set<number> | null;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private offset = 0;
  private running = false;
  private controller: AbortController | null = null;

  constructor(private readonly agent: HybridAgent, options: TelegramGatewayOptions = {}) {
    this.token = options.botToken || process.env.LAYRA_TELEGRAM_BOT_TOKEN || '';
    const configured = options.allowedUserIds || parseAllowedUsers(process.env.LAYRA_TELEGRAM_ALLOWED_USER_IDS);
    this.allowedUserIds = configured.size > 0 ? configured : null;
    this.pollIntervalMs = positiveInt(options.pollIntervalMs ?? Number(process.env.LAYRA_TELEGRAM_POLL_INTERVAL_MS), 1000);
    this.requestTimeoutMs = positiveInt(options.requestTimeoutMs ?? Number(process.env.LAYRA_TELEGRAM_REQUEST_TIMEOUT_MS), 30000);
  }

  isConfigured(): boolean {
    return this.token.length > 0;
  }

  async start(): Promise<void> {
    if (this.running || !this.isConfigured()) return;
    this.running = true;
    this.controller = new AbortController();
    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.handleUpdate(update);
        }
      } catch (error) {
        if (!this.running) break;
        console.error('Telegram gateway error:', error instanceof Error ? error.message : String(error));
        await sleep(this.pollIntervalMs);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.controller?.abort();
    this.controller = null;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    const text = message?.text?.trim();
    if (!chatId || !userId || !text || !this.isAllowed(userId)) return;

    if (text === '/start') {
      await this.sendMessage(chatId, 'Layra is online. Send me a goal or command.');
      return;
    }
    if (text === '/help') {
      await this.sendMessage(chatId, '/help - commands\n/status - runtime status\n/stop - stop the current agent\nAny other message is treated as a Layra goal.');
      return;
    }
    if (text === '/status') {
      await this.sendMessage(chatId, JSON.stringify(this.agent.getStatistics(), null, 2));
      return;
    }
    if (text === '/stop') {
      this.agent.stop();
      await this.sendMessage(chatId, 'Layra stopped.');
      return;
    }

    await this.sendMessage(chatId, 'Working...');
    const result = await this.agent.runInteractiveTurn(text);
    if (result.stoppedReason === 'no_model') {
      await this.sendMessage(chatId, 'Layra has no model API key configured.');
      return;
    }
    await this.sendMessage(chatId, result.content || `[stopped: ${result.stoppedReason}; rounds=${result.rounds}; toolCalls=${result.toolCalls}]`);
  }

  private isAllowed(userId: number): boolean {
    return this.allowedUserIds === null || this.allowedUserIds.has(userId);
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const params = new URLSearchParams({ timeout: '25', offset: String(this.offset) });
    const response = await this.api<TelegramUpdate[]>(`getUpdates?${params.toString()}`);
    return response.result || [];
  }

  private async sendMessage(chatId: number, text: string): Promise<void> {
    const max = 4000;
    for (let i = 0; i < text.length; i += max) {
      await this.api('sendMessage', { chat_id: chatId, text: text.slice(i, i + max) });
    }
  }

  private async api<T>(method: string, params?: Record<string, unknown>): Promise<TelegramResponse<T>> {
    const controller = this.controller || new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: params ? 'POST' : 'GET',
        headers: params ? { 'content-type': 'application/json' } : undefined,
        body: params ? JSON.stringify(params) : undefined,
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
      const payload = await response.json() as TelegramResponse<T>;
      if (!payload.ok) throw new Error(payload.description || `Telegram API ${method} failed`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseAllowedUsers(value: string | undefined): Set<number> {
  const set = new Set<number>();
  for (const part of (value || '').split(',')) {
    const id = Number(part.trim());
    if (Number.isSafeInteger(id) && id > 0) set.add(id);
  }
  return set;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
