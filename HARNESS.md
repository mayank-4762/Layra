# Layra Runtime

Layra is one unified agent. Hermes-inspired reasoning/planning, governed execution, durable state, and DHS/DeepSeek analysis are implemented as capabilities inside the same runtime. Hermes Agent and OpenClaw are source references for selected mechanisms, not separately required runtime processes.

## Runtime loop

1. Restore persistent Layra state.
2. Select or accept a goal.
3. Generate a bounded plan using currently available tools.
4. Validate dependencies, permissions, risk and tool availability.
5. Execute through the single ToolExecutor policy boundary.
6. Observe tool results and ask the model for continuation/replanning.
7. Use DHS for evidence analysis, reusable lessons and independent goal verification when DeepSeek is configured.
8. Verify the actual goal from evidence; completed task count is never sufficient by itself.
9. Persist state, events, status and report.
10. Resume from persisted state on the next run.

## Capability model

Safe read-only capabilities are enabled by default. Side-effecting capabilities require explicit environment flags:

- `LAYRA_ALLOW_LOCAL_WRITE=true`
- `LAYRA_ALLOW_SHELL=true`
- `LAYRA_ALLOW_WEB_POST=true`
- `LAYRA_ALLOW_BROWSER=true` plus `LAYRA_CDP_WS_URL`
- `LAYRA_ALLOW_MCP=true` plus `LAYRA_MCP_SERVER_COMMAND`
- `LAYRA_ALLOW_SCHEDULER=true`
- `LAYRA_ALLOW_DELEGATION=true`
- `LAYRA_ALLOW_ANDROID=true`

MCP discovery can refresh the live Layra tool catalog so discovered remote tools become first-class model-visible tools while still executing through the same ToolExecutor.

## Models

The primary model uses an OpenAI-compatible HTTP endpoint configured through `LAYRA_MODEL_*` variables. The default is NVIDIA. DHS uses the direct DeepSeek API configured through `DEEPSEEK_*` variables.

## Android / Termux

Layra can run as a Node runtime under Termux. The optional Android bridge can use installed Termux:API commands for toast, notification, URL opening and clipboard operations. This is an Android/Termux integration layer, not a native APK or AccessibilityService; those require a separate Android application layer in a future phase.

## Verification policy

CI must pass `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`. External browser, MCP and provider integrations should be verified with local deterministic harnesses before any production claim is made.

Start with `npm run build && npm start`, optionally passing a goal as CLI text or `LAYRA_GOAL`.
