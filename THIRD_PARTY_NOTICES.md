# Third-party source acknowledgements

Layra is a separate TypeScript runtime. It does not install or launch Hermes Agent or OpenClaw as runtime dependencies. Phase 2 ports/adapts selected implementation mechanisms into Layra's own modules; source-specific notices are retained here.

## Hermes Agent
Source: https://github.com/NousResearch/hermes-agent
Reference commit: `4b6c5bee4c5ad49c9e79c0834f4fea2c2ceb0952`
Copyright (c) 2025 Nous Research
License: MIT

Implementation areas studied/adapted:
- `run_agent.py` and `agent/turn_tool_round.py`: interruptible, ordered tool-turn lifecycle; tool results are returned to the model as first-class conversation messages.
- `hermes_state.py`: durable session/state emphasis.
- Hermes memory/skill modules: persistent memory, procedural skill discovery, curation and reuse.

Layra's TypeScript implementations are independent translations rather than Python source-file copies.

## OpenClaw
Source: https://github.com/openclaw/openclaw
Reference branch: `main`
Copyright (c) 2026 OpenClaw Foundation
License: MIT

Implementation areas studied/adapted:
- `src/agents/agent-tools.ts`: effective capability/tool-surface construction and policy layering.
- `src/agents/bash-process-registry.ts`: bounded process-session lifecycle, output retention and cancellation-oriented execution state.
- OpenClaw tool-policy and filesystem safety modules: explicit capability checks and containment before side effects.

Layra's TypeScript implementation is independently written and does not require OpenClaw at runtime.

## Direct-copy rule
Where future work incorporates a verbatim upstream code block, its original copyright/license header must remain attached to that block and the exact upstream path/commit must be recorded here. This notice is not a substitute for the MIT license text where a repository's distribution requirements call for the full text.
