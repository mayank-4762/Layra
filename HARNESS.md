# Layra Runtime

Layra is one unified agent. Hermes is its reasoning/planning capability, NVIDIA provides the primary inference/reasoning model, OpenClaw is the action/execution capability, and DHS is the DeepSeek-powered analysis/learning capability.

The production runtime is `main.ts` → `HybridAgent`.

## Runtime loop

1. Restore persistent state.
2. Select or accept a goal.
3. Ask Hermes for a bounded executable plan using only registered capabilities.
4. Validate dependencies, permissions and tool availability.
5. Execute the next action through the ToolExecutor/OpenClaw policy boundary.
6. Feed the observed result to NVIDIA for reasoning about continuation/replanning.
7. Use DHS periodically for pattern analysis and reusable lessons.
8. Verify the actual goal using evidence rather than task-count heuristics.
9. Persist state, events, status and report.
10. Resume from that state on the next process/session.

## Safety

Shell execution, file writes and web POST operations are opt-in through environment variables. File reads/lists are restricted to `LAYRA_WORKSPACE_ROOT`. Secrets are never stored in the repository.

## Environment

Required for full capability operation:

- `NVIDIA_API_KEY`
- `DEEPSEEK_API_KEY`
- An installed `hermes` CLI
- A reachable OpenClaw Gateway (`OPENCLAW_GATEWAY_URL`, plus token/password when configured)

Optional controls:

- `LAYRA_WORKSPACE_ROOT`
- `LAYRA_ALLOW_SHELL=true`
- `LAYRA_ALLOW_WRITE=true`
- `LAYRA_ALLOW_WEB_POST=true`
- `LAYRA_DHS_MAX_CALLS`
- `LAYRA_DHS_MIN_INTERVAL_MS`

Start with `npm run build && npm start`, optionally passing a goal as CLI text or `LAYRA_GOAL`.
