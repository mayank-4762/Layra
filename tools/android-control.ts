import { validateHttpUrl } from '../core/security';

export interface AndroidUiNode {
  id?: string;
  className?: string;
  text?: string;
  contentDescription?: string;
  clickable?: boolean;
  editable?: boolean;
  enabled?: boolean;
  bounds?: { left: number; top: number; right: number; bottom: number };
  children?: AndroidUiNode[];
}

export interface AndroidBridgeResponse<T = any> {
  success: boolean;
  result?: T;
  error?: string;
}

/** Native Android control bridge. The Android companion owns the AccessibilityService; Layra remains the single agent. */
export class AndroidControlBridge {
  private readonly baseUrl: string;
  private readonly enabled: boolean;

  constructor() {
    this.baseUrl = String(process.env.LAYRA_ANDROID_BRIDGE_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
    this.enabled = process.env.LAYRA_ALLOW_ANDROID_CONTROL === 'true';
  }

  isConfigured(): boolean {
    if (!this.enabled) return false;
    const url = new URL(this.baseUrl);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  }

  async health(signal?: AbortSignal): Promise<any> { return this.request('GET', '/health', undefined, signal); }

  async tree(signal?: AbortSignal): Promise<AndroidUiNode[]> {
    const result = await this.request<{ nodes?: AndroidUiNode[] }>('GET', '/tree', undefined, signal);
    return Array.isArray(result?.nodes) ? result.nodes : [];
  }

  async tap(selector: Record<string, any>, signal?: AbortSignal): Promise<any> {
    return this.request('POST', '/tap', { selector }, signal);
  }

  async type(selector: Record<string, any>, text: string, signal?: AbortSignal): Promise<any> {
    return this.request('POST', '/type', { selector, text: String(text).slice(0, 10000) }, signal);
  }

  async swipe(startX: number, startY: number, endX: number, endY: number, durationMs = 400, signal?: AbortSignal): Promise<any> {
    return this.request('POST', '/swipe', {
      startX: Number(startX), startY: Number(startY), endX: Number(endX), endY: Number(endY), durationMs: Math.max(50, Math.min(10000, Number(durationMs)))
    }, signal);
  }

  async back(signal?: AbortSignal): Promise<any> { return this.request('POST', '/back', {}, signal); }
  async home(signal?: AbortSignal): Promise<any> { return this.request('POST', '/home', {}, signal); }
  async launch(packageName: string, activity?: string, signal?: AbortSignal): Promise<any> {
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(packageName)) throw new Error('Invalid Android package name');
    if (activity && !/^[a-zA-Z0-9._$-]{1,250}$/.test(activity)) throw new Error('Invalid Android activity name');
    return this.request('POST', '/launch', { packageName, ...(activity ? { activity } : {}) }, signal);
  }

  async screenshot(signal?: AbortSignal): Promise<{ format: string; dataBase64: string; bytes: number }> {
    const result = await this.request<{ format: string; dataBase64: string; bytes: number }>('GET', '/screenshot', undefined, signal);
    return result;
  }

  private async request<T = any>(method: 'GET' | 'POST', pathname: string, body?: any, signal?: AbortSignal): Promise<T> {
    if (!this.isConfigured()) throw new Error('Native Android control is disabled or not configured; set LAYRA_ALLOW_ANDROID_CONTROL=true and LAYRA_ANDROID_BRIDGE_URL');
    const base = new URL(this.baseUrl);
    if (base.hostname !== '127.0.0.1' && base.hostname !== 'localhost' && base.hostname !== '::1') throw new Error('Android bridge must be loopback-only');
    const url = new URL(pathname, `${base.origin}/`);
    validateHttpUrl(url.toString(), true);
    const timeoutMs = Math.max(1000, Math.min(30000, Number(process.env.LAYRA_ANDROID_CONTROL_TIMEOUT_MS || 10000)));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Layra/4.0' },
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal
      });
      const text = await response.text();
      let parsed: AndroidBridgeResponse<T>;
      try { parsed = JSON.parse(text) as AndroidBridgeResponse<T>; } catch { throw new Error(`Android bridge returned invalid JSON (HTTP ${response.status})`); }
      if (!response.ok || parsed.success === false) throw new Error(parsed.error || `Android bridge HTTP ${response.status}`);
      return parsed.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
