# Layra Reasoning Architecture

Layra is one unified agent with fused capabilities:

- Hermes: planning, decomposition, and reasoning capability.
- NVIDIA: primary inference/reasoning model.
- OpenClaw: governed action and execution capability.
- DHS: direct DeepSeek analysis, verification, and learning capability.

These capabilities are coordinated by `HybridAgent`; they are not independent agents exchanging tasks.

## Decision loop

Goal → context and memory → Hermes plan → validate → OpenClaw execution → observe evidence → NVIDIA reasoning → DHS learning/verification → replan or complete → persist and resume.

A goal is complete only when evidence supports the goal. Fixed task counts are never treated as proof of success.
