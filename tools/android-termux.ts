import { spawn } from 'child_process';

export interface AndroidCommandResult { command: string; success: boolean; stdout: string; stderr: string; code: number | null; }

/** Optional Android/Termux bridge. It is a capability inside Layra, not a second agent. */
export class AndroidTermuxBridge {
  private readonly enabled = process.env.LAYRA_ALLOW_ANDROID === 'true';

  isConfigured(): boolean {
    return this.enabled && Boolean(process.env.PREFIX || process.platform === 'android');
  }

  async run(command: string, args: string[] = [], timeoutMs = 15000): Promise<AndroidCommandResult> {
    if (!this.enabled) throw new Error('Android/Termux tools disabled; set LAYRA_ALLOW_ANDROID=true');
    const safeCommand = String(command || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(safeCommand)) throw new Error('Invalid Android/Termux command');
    if (args.some(arg => typeof arg !== 'string' || arg.length > 5000)) throw new Error('Invalid Android/Termux arguments');
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, PREFIX: process.env.PREFIX, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG };
    return new Promise((resolve, reject) => {
      const child = spawn(safeCommand, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(1000, Math.min(60000, timeoutMs)));
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 100000) stdout = stdout.slice(-100000); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 100000) stderr = stderr.slice(-100000); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ command: safeCommand, success: code === 0, stdout, stderr, code }); });
    });
  }

  toast(text: string): Promise<AndroidCommandResult> { return this.run('termux-toast', [String(text).slice(0, 1000)]); }
  notify(title: string, content: string): Promise<AndroidCommandResult> { return this.run('termux-notification', ['--title', String(title).slice(0, 200), '--content', String(content).slice(0, 2000)]); }
  openUrl(url: string): Promise<AndroidCommandResult> { if (!/^https?:\/\//i.test(url)) throw new Error('Only HTTP(S) URLs may be opened'); return this.run('termux-open-url', [url]); }
  clipboardGet(): Promise<AndroidCommandResult> { return this.run('termux-clipboard-get'); }
  clipboardSet(text: string): Promise<AndroidCommandResult> { return this.run('termux-clipboard-set', [String(text).slice(0, 10000)]); }
}
