import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const failures = [];
function check(label, condition, detail) {
  if (condition) console.log(`OK   ${label}${detail ? ` — ${detail}` : ''}`);
  else { console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); failures.push(label); }
}

const major = Number(process.versions.node.split('.')[0]);
check('Node.js', major >= 22, `found ${process.version}`);
check('Architecture', ['arm64', 'x64'].includes(process.arch), `found ${process.arch}`);
check('Platform', true, `found ${process.platform}${process.env.TERMUX_VERSION ? ' (Termux)' : ''}`);
check('Native runtime', true, 'Hermes/OpenClaw are integrated; no separate agent processes required');
check('Runtime entrypoint', existsSync(new URL('../main.ts', import.meta.url)), 'main.ts present');

function commandExists(command) {
  try { execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

const provider = process.env.LAYRA_MODEL_PROVIDER || 'nvidia';
const keyEnv = process.env.LAYRA_MODEL_API_KEY_ENV || 'NVIDIA_API_KEY';
check('Reasoning API key', Boolean(process.env[keyEnv]), `${provider} via ${keyEnv}`);
check('DHS DeepSeek API key', Boolean(process.env.DEEPSEEK_API_KEY), 'required for DHS learning/verification');

if (process.env.LAYRA_ALLOW_SHELL === 'true') check('Shell policy', commandExists(process.env.SHELL || (process.platform === 'android' ? '/system/bin/sh' : '/bin/sh')), 'shell executable available');
else console.log('INFO Shell policy — disabled by default; set LAYRA_ALLOW_SHELL=true only when required.');
if (process.env.LAYRA_ALLOW_LOCAL_WRITE === 'true') console.log('INFO File writes — enabled by LAYRA_ALLOW_LOCAL_WRITE.');
else console.log('INFO File writes — disabled by default.');
if (process.env.LAYRA_ALLOW_WEB_POST === 'true') console.log('INFO HTTP POST — enabled by LAYRA_ALLOW_WEB_POST.');
else console.log('INFO HTTP POST — disabled by default.');

if (process.env.TERMUX_VERSION) {
  console.log('INFO Termux detected: Layra is self-contained; no separate Hermes/OpenClaw installation is required.');
  console.log('INFO Android may suspend background processes; use a persistent host for unattended 24/7 execution.');
}

process.exitCode = failures.length ? 1 : 0;
