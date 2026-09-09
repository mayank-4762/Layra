import { createInterface } from 'readline';
import { HybridAgent } from './agent/agent';
import { getModelConfig, testModelConnection } from './config/model-provider';

function printHelp(): void {
  console.log(`Layra 3.0\n\nUsage:\n  npm start -- "<goal>"       Run an autonomous goal\n  npm start -- --once "<prompt>"  Run one interactive model/tool turn\n  npm start -- --chat          Start an interactive session\n  npm start -- --doctor        Check model connectivity\n  npm start -- --help          Show this help\n\nEnvironment:\n  NVIDIA_API_KEY / LAYRA_MODEL_API_KEY_ENV   Model credential\n  LAYRA_ALLOW_LOCAL_WRITE=true               Enable filesystem writes\n  LAYRA_ALLOW_SHELL=true                     Enable shell/process tools\n  LAYRA_ALLOW_WEB_POST=true                  Enable HTTP POST tools`);
}

async function runOnce(prompt: string): Promise<void> {
  const agent = new HybridAgent();
  const result = await agent.runInteractiveTurn(prompt);
  if (result.stoppedReason === 'no_model') {
    console.error('No model API key is configured.');
    process.exitCode = 2;
    return;
  }
  console.log(result.content || `[Layra stopped: ${result.stoppedReason}; rounds=${result.rounds}; toolCalls=${result.toolCalls}]`);
}

async function runChat(): Promise<void> {
  const agent = new HybridAgent();
  const readline = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: 'you> ' });
  const shutdown = () => { readline.close(); agent.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
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

  const goal = process.env.LAYRA_GOAL || args.join(' ').trim();
  const agent = new HybridAgent();
  console.log(`Starting Layra${goal ? ` with goal: ${goal}` : ''}...`);
  const shutdown = () => { agent.stop(); console.log('Layra stopped.'); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await agent.start(goal || undefined);
  } catch (error) {
    console.error('Layra failed to start:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main().catch(error => {
  console.error('Layra CLI error:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
