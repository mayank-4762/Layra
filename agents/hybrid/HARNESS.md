# Hybrid Agent Harness — OpenClaw + Hermes + DeepSeek

## Architecture

```
User Input → OpenClaw (Hand/Executor)
                  ↓
           Hermes (Brain/Reasoner) — plans, breaks goals into steps
                  ↓
           DeepSeek (Nervous System) — heavy analysis, pattern detection
                  ↓
           OpenClaw executes tools, writes memory
                  ↓
           State flows back to Hermes for next iteration
```

## Dispatch Protocol

### Tier 1 — Fast exec (OpenClaw handles alone)
- File reads, writes, simple commands
- Short factual lookups
- Telegram replies

### Tier 2 — Planning needed (OpenClaw + Hermes reasoning)
- Multi-step goals
- Complex decisions
- Unknown scope

### Tier 3 — Heavy analysis (DeepSeek harness invoked)
- Pattern detection across memory/history
- Strategic planning
- Complex comparisons
- Self-improvement suggestions

## Harness State (memory/harness-state.json)

```json
{
  "current_goal": "...",
  "steps": [],
  "completed": [],
  "blocked": [],
  "insights": [],
  "deepseek_calls": 0
}
```

## How it works

1. **User input** arrives via OpenClaw (Telegram/CLI)
2. **Hermes** (this agent) plans the approach, breaks into steps
3. **OpenClaw** executes steps using tools
4. **DeepSeek** called for Tier-3 heavy analysis (via session_send to DeepSeek subagent)
5. Results flow back, Hermes updates plan, repeat until done
6. Final output stored in memory/ for next session

## DeepSeek Subagent Config

- Session label: `deepseek-harness`
- Runtime: isolated
- System prompt: `agents/hybrid/DEEPSEEK_PROMPT.md`
- Output: writes to `memory/deepseek-output.json`

## Rules

1. Never block the user — use fast paths when possible
2. DeepSeek calls = max 3 per session (cost control)
3. Store every significant decision in memory/
4. Improve plan based on what worked last time
5. Fail fast, recover faster
