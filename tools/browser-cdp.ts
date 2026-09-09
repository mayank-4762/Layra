import { createHash } from 'crypto';
import { validateHttpUrl } from '../core/security';

interface CdpResponse { id: number; result?: any; error?: { message?: string }; }

/** Dependency-free Chromium CDP adapter. It talks to an already-running browser; it never starts OpenClaw/Hermes. */
export class BrowserCdp {
  private readonly wsUrl = process.env.LAYRA_CDP_WS_URL || '';
  private nextId = 1;

  isConfigured(): boolean { return Boolean(this.wsUrl); }

  async listTabs(): Promise<any[]> {
    if (!this.wsUrl) throw new Error('Browser CDP is not configured; set LAYRA_CDP_WS_URL');
    const parsed = new URL(this.wsUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'));
    const endpoint = new URL('/json/list', parsed.origin);
    const response = await fetch(endpoint, { headers: { 'User-Agent': 'Layra/3.0' } });
    if (!response.ok) throw new Error(`CDP tab discovery HTTP ${response.status}`);
    const tabs = await response.json();
    if (!Array.isArray(tabs)) throw new Error('CDP tab discovery returned an invalid payload');
    return tabs.slice(0, Math.max(1, Math.min(100, Number(process.env.LAYRA_BROWSER_MAX_TABS || 25)))).map(tab => ({ id: tab.id, type: tab.type, title: tab.title, url: tab.url, webSocketDebuggerUrl: tab.webSocketDebuggerUrl }));
  }

  async navigate(url: string, signal?: AbortSignal): Promise<any> {
    validateHttpUrl(url);
    return this.command('Page.navigate', { url }, signal);
  }

  async snapshot(signal?: AbortSignal): Promise<string> {
    const result = await this.command('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true }, signal);
    return String(result?.result?.value || '').slice(0, Math.max(1000, Math.min(200000, Number(process.env.LAYRA_BROWSER_MAX_TEXT || 50000))));
  }

  async accessibilitySnapshot(signal?: AbortSignal): Promise<any> {
    const result = await this.command('Accessibility.getFullAXTree', {}, signal);
    const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
    return { nodes: nodes.slice(0, 5000) };
  }

  async screenshot(signal?: AbortSignal): Promise<{ format: string; dataBase64: string; bytes: number }> {
    const result = await this.command('Page.captureScreenshot', { format: 'png', fromSurface: true }, signal);
    const data = String(result?.data || '');
    const maxBytes = Math.max(10000, Math.min(5_000_000, Number(process.env.LAYRA_BROWSER_MAX_SCREENSHOT_BYTES || 1_500_000)));
    if (Buffer.byteLength(data, 'base64') > maxBytes) throw new Error(`Browser screenshot exceeds ${maxBytes} bytes`);
    return { format: 'png', dataBase64: data, bytes: Buffer.byteLength(data, 'base64') };
  }

  async click(selector: string, signal?: AbortSignal): Promise<any> {
    const safe = this.requireSelector(selector);
    return this.command('Runtime.evaluate', { expression: `(() => { const el=document.querySelector(${JSON.stringify(safe)}); if(!el) throw new Error('Element not found'); el.scrollIntoView({block:'center'}); el.click(); return {clicked:true, tag:el.tagName}; })()`, returnByValue: true }, signal);
  }

  async type(selector: string, text: string, signal?: AbortSignal): Promise<any> {
    const safe = this.requireSelector(selector);
    const result = await this.command('Runtime.evaluate', { expression: `(() => { const el=document.querySelector(${JSON.stringify(safe)}); if(!el) throw new Error('Element not found'); el.focus(); return {focused:true, tag:el.tagName}; })()`, returnByValue: true }, signal);
    if (!result) return result;
    await this.command('Input.insertText', { text: String(text).slice(0, 10000) }, signal);
    return { ...result, typed: true };
  }

  async pressKey(key: string, signal?: AbortSignal): Promise<any> {
    const value = String(key || '').trim();
    if (!/^[A-Za-z0-9 _.,:;!?@#%&*()_+\-=\[\]{}'"/\\]{1,40}$/.test(value)) throw new Error('Invalid browser key');
    await this.command('Input.dispatchKeyEvent', { type: 'keyDown', key: value }, signal);
    return this.command('Input.dispatchKeyEvent', { type: 'keyUp', key: value }, signal);
  }

  private requireSelector(selector: string): string {
    const value = String(selector || '').trim();
    if (!value || value.length > 500) throw new Error('A CSS selector between 1 and 500 characters is required');
    return value;
  }

  private async command(method: string, params: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (!this.wsUrl) throw new Error('Browser CDP is not configured; set LAYRA_CDP_WS_URL');
    const socket = new WebSocket(this.wsUrl);
    const id = this.nextId++;
    const timeoutMs = Math.max(1000, Math.min(120000, Number(process.env.LAYRA_BROWSER_TIMEOUT_MS || 30000)));
    return await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Browser CDP timeout after ${timeoutMs}ms`)), timeoutMs);
      const abort = () => finish(new Error('Browser operation aborted'));
      const finish = (error?: Error, value?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        try { socket.close(); } catch { /* best effort */ }
        if (error) reject(error); else resolve(value);
      };
      if (signal?.aborted) return finish(new Error('Browser operation aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      socket.addEventListener('open', () => socket.send(JSON.stringify({ id, method, params })));
      socket.addEventListener('message', event => {
        try {
          const response = JSON.parse(String(event.data)) as CdpResponse;
          if (response.id !== id) return;
          if (response.error) finish(new Error(`CDP ${method}: ${response.error.message || 'command failed'}`));
          else finish(undefined, response.result);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.addEventListener('error', () => finish(new Error(`Unable to connect to browser CDP at ${this.wsUrl}`)));
    });
  }

  static stableTabKey(url: string): string { return createHash('sha256').update(url).digest('hex').slice(0, 16); }
}
