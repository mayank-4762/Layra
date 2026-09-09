# Layra on Android / Termux

Layra is one self-contained Node.js agent runtime. Hermes-derived reasoning/planning, governed execution/control, and DHS/DeepSeek analysis are fused into Layra; Android does not need a separate Hermes or OpenClaw agent installation.

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

## 4. Run Layra interactively or autonomously

```sh
npm start -- --once "Inspect the workspace and tell me what needs fixing."
npm start -- --chat
LAYRA_GOAL='Inspect this workspace, identify the highest-priority runtime problem, fix it, verify the fix, and record the lesson.' npm start
```

The interactive path uses the same model→tool→result loop as autonomous execution. Tool calls are bounded, cancellable, permission-checked, and returned to the model as structured evidence.

## 5. Enable capabilities deliberately

Safe read-only tools are enabled by default. Consequential capabilities require explicit environment flags:

```sh
export LAYRA_ALLOW_LOCAL_WRITE=true
export LAYRA_ALLOW_SHELL=true
export LAYRA_ALLOW_WEB_POST=true
export LAYRA_ALLOW_SCHEDULER=true
export LAYRA_ALLOW_DELEGATION=true
export LAYRA_ALLOW_ANDROID=true
```

For browser automation, connect an existing Chromium instance through Chrome DevTools Protocol:

```sh
export LAYRA_ALLOW_BROWSER=true
export LAYRA_CDP_WS_URL='ws://127.0.0.1:9222/devtools/page/<target-id>'
```

Browser capabilities include navigation, visible-text snapshots, accessibility-tree snapshots, screenshots, tab discovery, CSS click/type, key dispatch, bounded timeouts, and abort handling. Full Android accessibility control is not provided by this Node runtime.

For MCP, configure one trusted stdio server explicitly:

```sh
export LAYRA_ALLOW_MCP=true
export LAYRA_MCP_SERVER_COMMAND='your-mcp-server'
export LAYRA_MCP_SERVER_ARGS='["arg1","arg2"]'
```

Use `mcp.refresh` to register discovered MCP tools into Layra's live model tool catalog. Those tools still execute through the same ToolExecutor.

Shell commands remain subject to Layra's execution safety policy and filesystem access is constrained to `LAYRA_WORKSPACE_ROOT` (the current directory by default).

## 6. Android / Termux helpers

With `LAYRA_ALLOW_ANDROID=true` and the Termux:API package installed, Layra can use in-process Android helpers for toast messages, notifications, opening HTTP(S) URLs, and clipboard get/set. These are capability tools inside Layra; they are not a separate agent.

## 7. Scheduling and internal delegation

Scheduled prompts are persisted in `.state/scheduler.json` and are only armed by the CLI when `LAYRA_ALLOW_SCHEDULER=true`. Due jobs execute through the same Layra runtime. Internal delegation creates bounded child tasks that reuse the existing model provider, tool registry, permissions, workspace, and executor.

## 8. Persistence and learning

Runtime state is stored under `.state/` by default. Layra keeps session snapshots, a durable event journal, structured memory, human-readable `memory/MEMORY.md` and `memory/USER.md`, schedules, and learned procedural skills. `session.search` provides bounded retrieval over the event journal.

## Android notes

Android/Termux is a supported runtime target, but Android may suspend long-running processes. A native APK, AccessibilityService, foreground service, or deeper system-control layer still requires a dedicated Android application component; those are not falsely presented as complete in this runtime.
