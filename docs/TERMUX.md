# Layra on Android / Termux

Layra is designed to run as one self-contained Node.js agent runtime. Hermes-derived reasoning/planning, OpenClaw-derived execution/control, and DHS/DeepSeek evaluation are compiled into Layra; Android does **not** need a separate Hermes or OpenClaw agent installation.

## 1. Install the Android runtime

```sh
pkg update
pkg upgrade
pkg install -y git nodejs openssh curl
```

Layra requires Node.js 22 or newer.

## 2. Get Layra

```sh
git clone -b layra-source-review https://github.com/mayank-4762/Layra.git
cd Layra
npm ci
npm run build
npm run doctor
```

## 3. Configure model providers

Keep credentials outside the repository:

```sh
export NVIDIA_API_KEY='your-key'
export DEEPSEEK_API_KEY='your-key'
```

NVIDIA is the current default reasoning model provider. The provider layer is runtime-configurable. DHS uses the direct DeepSeek API.

## 4. Enable capabilities deliberately

Safe read-only tools are enabled by default. Consequential capabilities require explicit environment flags:

```sh
export LAYRA_ALLOW_LOCAL_WRITE=true
export LAYRA_ALLOW_SHELL=true
export LAYRA_ALLOW_WEB_POST=true
```

Use the minimum set required for the task. Shell commands remain subject to Layra's execution safety policy and filesystem access is constrained to `LAYRA_WORKSPACE_ROOT` (the current directory by default).

## 5. Run an autonomous goal

```sh
LAYRA_GOAL='Inspect this workspace, identify the highest-priority runtime problem, fix it, verify the fix, and record the lesson.' npm start
```

Layra will keep one state machine around the entire task:

`UNDERSTAND → RECALL → DECIDE/PLAN → ACT → OBSERVE → REASON → REFLECT → REPLAN → VERIFY → LEARN → COMPLETE`

The planner uses the integrated Hermes-derived reasoning layer. Tool execution is performed by Layra's native execution/control plane. DHS/DeepSeek evaluates evidence, rejects unsupported completion, stores lessons, and can create reusable procedural skills.

## 6. Persistence

Runtime state is stored under `.state/` by default. Layra keeps session state, events, structured memory, and learned skills there. The workspace `skills/` directory may also contain manually supplied skills.

## Android notes

Android may suspend long-running Termux processes. For unattended 24/7 work, keep the process on a persistent machine and use Android as a control surface. That is an infrastructure choice, not a requirement to install or run a second agent: Layra itself remains the single agent runtime.
