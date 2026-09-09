import { execFileSync } from 'node:child_process';
import { request } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const failures = [];

function check(label, condition, detail) {
  if (condition) console.log(`OK   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures.push(label);
  }
}

const major = Number(process.versions.node.split('.')[0]);
check('Node.js', major >= 22, `found ${process.version}`);
check('Architecture', ['arm64', 'x64'].includes(process.arch), `found ${process.arch}`);
check('Platform', true, `found ${process.platform}${process.env.TERMUX_VERSION ? ' (Termux)' : ''}`);

function commandExists(command) {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

check('Hermes CLI', commandExists('hermes'), 'required for Layra planning');

const provider = process.env.LAYRA_MODEL_PROVIDER || 'nvidia';
const keyEnv = process.env.LAYRA_MODEL_API_KEY_ENV || 'NVIDIA_API_KEY';
check('Reasoning API key', Boolean(process.env[keyEnv]), `${provider} via ${keyEnv}`);
check('DHS DeepSeek API key', Boolean(process.env.DEEPSEEK_API_KEY), 'required for DHS learning/verification');

const gateway = (process.env.OPENCLAW_GATEWAY_URL || 'http://127.0.0.1:18789').replace(/\/$/, '');
const gatewayUrl = new URL(gateway);

await new Promise((resolve) => {
  const transport = gatewayUrl.protocol === 'https:' ? httpsRequest : request;
  const req = transport({
    hostname: gatewayUrl.hostname,
    port: gatewayUrl.port || (gatewayUrl.protocol === 'https:' ? 443 : 80),
    path: '/',
    method: 'GET',
    timeout: 3000
  }, (res) => {
    res.resume();
    res.on('end', () => {
      check('OpenClaw Gateway', true, `${gateway}`);
      resolve();
    });
  });
  req.on('error', () => {
    check('OpenClaw Gateway', false, `${gateway} is unreachable`);
    resolve();
  });
  req.on('timeout', () => {
    req.destroy();
    check('OpenClaw Gateway', false, `${gateway} timed out`);
    resolve();
  });
  req.end();
});

if (process.env.TERMUX_VERSION) {
  console.log('INFO Termux detected: keep Layra source and state inside Termux-accessible storage.');
  console.log('INFO For remote OpenClaw, prefer an SSH/Tailscale tunnel and keep the Gateway off the public Internet.');
}

process.exitCode = failures.length ? 1 : 0;
