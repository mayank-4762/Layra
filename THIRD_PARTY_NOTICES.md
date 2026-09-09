# Third-party source acknowledgements

Layra is a separate TypeScript runtime. Selected architectural ideas and implementation patterns have been adapted from the following MIT-licensed open-source projects rather than running those projects as separate agent processes.

## Hermes Agent
Source: https://github.com/NousResearch/hermes-agent
Copyright (c) 2025 Nous Research
License: MIT

Adapted areas in Layra: persistent learning loop, procedural skills, session-oriented memory, bounded tool orchestration, structured reflection, and reusable workflow design.

## OpenClaw
Source: https://github.com/openclaw/openclaw
Copyright (c) 2026 OpenClaw Foundation
License: MIT

Adapted areas in Layra: capability registry, execution-policy boundary, process execution semantics, abort-aware execution, workspace/file safety, and tool lifecycle concepts.

## Important

Layra does not install or launch Hermes Agent or OpenClaw at runtime. These capabilities are implemented natively inside the Layra process. This notice should be updated whenever additional upstream code is directly incorporated. Any directly copied third-party code must retain its applicable copyright and license notice.
