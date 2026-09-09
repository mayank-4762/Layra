import { HybridAgent } from './agent/agent';

async function main(): Promise<void> {
  const goal = process.env.LAYRA_GOAL || process.argv.slice(2).join(' ').trim();
  const agent = new HybridAgent();
  console.log(`Starting Layra${goal ? ` with goal: ${goal}` : ''}...`);

  const shutdown = () => {
    agent.stop();
    console.log('Layra stopped.');
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  try {
    await agent.start(goal || undefined);
  } catch (error) {
    console.error('Layra failed to start:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main();
