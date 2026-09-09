# Layra Self-Improvement Engine

Status: design locked on `layra-source-review` after source audit; implementation must remain inside the single Layra runtime.

## Source-derived mechanisms to adapt

Hermes currently exposes a closed learning loop around persistent memory, reusable agent-managed skills, skill authoring, and background skill curation. The upstream project describes skills as procedural memory, supports `/learn` to turn workflows or source material into reusable skills, and has a curator that maintains agent-created skills over time. Hermes also stores conversation sessions in SQLite with FTS5 full-text search. Layra should adapt the behavior, not embed or spawn Hermes.

Key mechanisms identified from the upstream source:

1. **Learning from experience** — turn a completed workflow into durable knowledge instead of leaving the lesson only in the current context.
2. **Reusable procedural skills** — capture a repeatable workflow as a structured skill with concise metadata and a verification section.
3. **Skill authoring from arbitrary sources** — learn from a workflow, files, URLs, or notes, while treating source text as data rather than instructions.
4. **Skill improvement** — compare an existing learned skill against newer evidence and patch only when the new version is demonstrably better.
5. **Skill curation** — periodically identify stale/duplicated/fragmented learned skills; consolidate rather than endlessly accumulate one-off skills; archive instead of destructive deletion.
6. **Cross-session recall** — search prior events/conversations when new work needs historical context.
7. **Evidence-first verification** — do not infer success merely because actions ran; evaluate the actual requested outcome.
8. **Safe mutation** — self-improvement must be bounded, auditable, reversible, and unable to silently broaden privileged capabilities.

## Layra mapping

| Hermes mechanism | Layra implementation target |
|---|---|
| Agent-managed skills | `core/skills.ts` + Self-Improvement Engine |
| `/learn` authoring loop | Self-Improvement Engine's experience-to-skill pipeline |
| Skill self-improvement | Versioned skill proposals + validation + promotion |
| Curator | Durable Layra improvement scheduler/maintenance pass |
| Session search | `core/session-search.ts` plus durable event history |
| Durable memory | `core/memory.ts` + knowledge vault |
| Independent verification | DHS verifier + deterministic evidence checks |
| Safe mutation | proposal → evaluate → promote/rollback state machine |

## Required closed loop

`experience → evidence → diagnosis → candidate improvement → validation → promotion → future use → measurement`

Every cycle must persist enough evidence to answer:

- What happened?
- What did Layra learn?
- Why is the proposed change useful?
- What evidence supports it?
- What safety checks passed?
- Was it promoted automatically or held for review?
- Did future execution improve?
- Can the previous version be restored?

## Improvement classes

### 1. Knowledge improvements
Safe by default. Promote durable facts, lessons, preferences, and procedures when evidence is sufficient and duplicates are merged.

### 2. Skill improvements
Require a candidate skill version, security scan, structural validation, and a measurable reason to replace the previous version. Keep the previous version for rollback.

### 3. Strategy improvements
Store execution policies such as preferred tool order, retry behavior, or verification patterns as data. Apply only inside existing permissions and hard limits.

### 4. Code improvements
Never mutate executable source merely because a model proposed it. A code change must first become a persisted proposal, be safety-checked, pass the project's typecheck/build/test suite, and be isolated so a bad candidate can be reverted. Production/main remains outside the autonomous mutation surface.

## Automatic versus guarded behavior

The engine should always be able to **observe, diagnose, learn, and propose**.

Automatic promotion is allowed only for low-risk knowledge/skill/strategy changes that satisfy configured confidence and evidence thresholds. Executable code changes remain proposal-only until the validation pipeline proves them safe.

Suggested environment gates:

- `LAYRA_SELF_IMPROVEMENT_ENABLED=true|false`
- `LAYRA_SELF_IMPROVEMENT_APPLY=true|false`
- `LAYRA_SELF_IMPROVEMENT_MIN_CONFIDENCE=0.80`
- `LAYRA_SELF_IMPROVEMENT_MIN_EVIDENCE=2`
- `LAYRA_SELF_IMPROVEMENT_MAX_CANDIDATES=3`

Defaults should favor proposal/validation over mutation.

## Skill quality rules

Learned skills should remain class-level and reusable rather than becoming one-session incident dumps. Generated metadata must have bounded names/descriptions, explicit provenance, and a verification section. High-risk instructions or prompt-injection patterns must block promotion unless a trusted explicit path is used.

## Rollback

For every promoted skill/strategy mutation, persist the prior content/version and an improvement record. If post-promotion evaluation shows regression, restore the previous version and record the rollback reason. No autonomous improvement should be irreversible.

## Metrics

Track at minimum:

- candidate improvements proposed
- candidates validated
- candidates promoted
- candidates rolled back
- successful reuse count
- regression count
- improvement confidence
- evidence count
- last curator run
- current learned-skill count

## Integration constraint

Layra remains **one runtime**. Hermes-inspired mechanisms become native Layra components. There must be no runtime requirement to install, launch, or communicate with a separate Hermes agent process.
