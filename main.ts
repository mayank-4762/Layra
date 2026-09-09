import { createInterface } from 'readline';
import { HybridAgent } from './agent/agent';
import { Phase6ReliabilitySupervisor } from './agent/reliability';
import { LayraScheduler } from './agent/scheduler';
import { getModelConfig, testModelConnection } from './config/model-provider';
import { TelegramGateway } from './integrations/telegram';

function printHelp(): void {
  console.log(`Layra 3.0\n\nUsage:\n  npm start -- "<goal>"          Run an autonomous goal\n  npm start -- --once "<prompt>" Run one interactive model/tool turn\n  npm start -- --chat             Start an interactive session\n  npm start -- --telegram         Start Telegram remote control\n  npm start -- --doctor           Check model connectivity\n  npm start -- --help             Show this help\n\nEnvironment:\n  NVIDIA_API_KEY / LAYRA_MODEL_API_KEY_ENV   Model credential\n  LAYRA_TELEGRAM_BOT_TOKEN=<token>          Telegram bot token\n  LAYRA_TELEGRAM_ALLOWED_USER_IDS=<ids>      Comma-separated Telegram user IDs allowed to control Layra\n  LAYRA_ALLOW_LOCAL_WRITE=true               Enable filesystem writes\n  LAYRA_ALLOW_SHELL=true                     Enable shell/process tools\n  LAYRA_ALLOW_WEB_POST=true                  Enable HTTP POST tools\n  LAYRA_ALLOW_BROWSER=true                   Enable configured Chromium CDP tools\n  LAYRA_ALLOW_MCP=true                       Enable configured MCP stdio server\n  LAYRA_ALLOW_SCHEDULER=true                Enable durable scheduled jobs\n  LAYRA_ALLOW_DELEGATION=true               Enable internal delegated tasks\n  LAYRA_ALLOW_ANDROID=true                  Enable optional Termux/Android helpers\n  LAYRA_MAX_RUNTIME_MS=<ms>                 Stop autonomous execution after a wall-clock budget\n  LAYRA_MAX_TOTAL_ACTIONS=<n>               Stop autonomous execution after an action budget\n  LAYRA_MAX_CONSECUTIVE_FAILURES=<n>        Stop runaway failure loops\n  LAYRA_MAX_TASK_AGE_MS=<ms>                Stop if an active task becomes stuck`);
}

function startScheduler(agent: HybridAgent): LayraScheduler | null {
  if (process.env.LAYRA_ALLOW_SCHEDULER !== 'true') return null;
  const scheduler = new LayraScheduler();
  scheduler.start(async job => {
    console.log(`Layra scheduler: running ${job.id}`);
    const result = await agent.runInteractiveTurn(job.prompt);
    if (result.content) console.log(`layra[scheduler]> ${result.content}`);
  });
  return scheduler;
}

function startReliability(agent: HybridAgent): Phase6ReliabilitySupervisor {
  const supervisor = new Phase6ReliabilitySupervisor(agent);
  supervisor.start();
  return supervisor;
}

function startTelegram(agent: HybridAgent): TelegramGateway {
  const gateway = new TelegramGateway(agent);
  if (!process.env.LAYRA_TELEGRAM_BOT_TOKEN) {
    throw new Error('Telegram mode requires LAYRA_TELEGRAM_BOT_TOKEN');
  }
  if (!process.env.LAYRA_TELEGRAM_ALLOWED_USER_IDS) {
    throw new Error('Telegram mode requires LAYRA_TELEGRAM_ALLOWED_USER_IDS');
  }
  if (!gateway.isConfigured()) {
    throw new Error('Telegram mode requires a valid Telegram bot token and allowed user ID');
  }
  void gateway.start();
  return gateway;
}

async function runOnce(prompt: string): Promise<void> {
  const agent = new HybridAgent();
  const supervisor = startReliability(agent);
  const scheduler = startScheduler(agent);
  try {
    const result = await agent.runInteractiveTurn(prompt);
    if (result.stoppedReason === 'no_model') { console.error('No model API key is configured.'); process.exitCode = 2; return; }
    console.log(result.content || `[Layra stopped: ${result.stoppedReason}; rounds=${result.rounds}; toolCalls=${result.toolCalls}]`);
  } finally { await supervisor.stop('run_once_complete'); scheduler?.stop(); }
}

async function runChat(): Promise<void> {
  const agent = new HybridAgent();
  const supervisor = startReliability(agent);
  const scheduler = startScheduler(agent);
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: 'you> ' });
  const shutdown = () => { scheduler?.stop(); void supervisor.stop('signal'); readline.close(); agent.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  console.log('Layra interactive session. Type /help or /exit.');
  readline.prompt();
  for await (const line of readline) {
    const prompt = line.trim();
    if (!prompt) { readline.prompt(); continue; }
    if (prompt === '/exit' || prompt === '/quit') break;
    if (prompt === '/help') { console.log('/help, /exit, /status'); readline.prompt(); continue; }
    if (prompt === '/status') { console.log(JSON.stringify(agent.getStatistics(), null, 2)); readline.prompt(); continue; }
    const result = await agent.runInteractiveTurn(prompt);
    if (result.stoppedReason === 'no_model') console.error('No model API key is configured.');
    else console.log(`layra> ${result.content || `[stopped: ${result.stoppedReason}]`}`);
    readline.prompt();
  }
  shutdown();
}

async function runTelegram(): Promise<void> {
  const agent = new HybridAgent();
  const supervisor = startReliability(agent);
  const scheduler = startScheduler(agent);
  const gateway = startTelegram(agent);
  const shutdown = () => { gateway.stop(); scheduler?.stop(); void supervisor.stop('signal'); agent.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  console.log('Layra Telegram remote control is running.');
  await new Promise<void>(resolve => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  shutdown();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return; }
  if (args[0] === '--doctor') {
    const config = getModelConfig();
    console.log(`Model: ${config.provider}/${config.model}`);
    const result = await testModelConnection();
    console.log(result.message);
    if (!result.success) process.exitCode = 1;
    return;
  }
  if (args[0] === '--once') {
    const prompt = args.slice(1).join(' ').trim();
    if (!prompt) throw new Error('--once requires a prompt');
    await runOnce(prompt);
    return;
  }
  if (args[0] === '--chat') { await runChat(); return; }
  if (args[0] === '--telegram') { await runTelegram(); return; }

  const goal = process.env.LAYRA_GOAL || args.join(' ').trim();
  const agent = new HybridAgent();
  const supervisor = startReliability(agent);
  const scheduler = startScheduler(agent);
  console.log(`Starting Layra${goal ? ` with goal: ${goal}` : ''}...`);
  const shutdown = () => { scheduler?.stop(); void supervisor.stop('signal'); agent.stop(); console.log('Layra stopped.'); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try { await agent.start(goal || undefined); }
  catch (error) { console.error('Layra failed to start:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
  finally { await supervisor.stop('agent_stopped'); scheduler?.stop(); }
}

void main().catch(error => { console.error('Layra CLI error:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
