---
name: ux-crucible
description: "Use when evaluating or creating UI/UX flows against user behaviors, running autonomous multi-agent simulation, debate, and runtime test verification."
---

# UX Crucible Master Router

## Core Mission
Orchestrate an end-to-end autonomous UX workflow for frontend flows across two distinct operational modes:
1. **`CREATE`**: Start from a feature or flow brief, simulate complete user sequences, conduct multi-agent debate to forge an internally approved UX contract and acceptance criteria, implement the feature, and run the full review/fix verification loop on the resulting UI.
2. **`REVIEW_FIX`**: Inspect an existing UI flow or reported defect, deploy 6–15 subagents to predict failure points, simulate adversarial user behaviors, execute deterministic reproduction probes, and apply minimal root-cause fixes with regression verification.

Never rely on routine human prompts for design choices or test approvals. Maintain rigorous evidence-based gates, falsification, and zero silent fallbacks.

## Execution Context & Intake Checkpoints
When triggered, consume incoming context:
- `uxRunId`: unique identifier for the run.
- `jobType`: `"CREATE"` | `"REVIEW_FIX"` | inferred.
- `targetFlow`: string naming component, route, or target feature (null if new feature).
- `changedFiles`: list of modified frontend files.
- `brief`: description of new feature or flow requirements (for `CREATE`).
- `constraints`: explicit product, platform, or accessibility requirements.
- `testCommand`: repository test command if known.

### Mode Inference Rule
- If `jobType` is omitted:
  - If a target flow, changed files, or reported defect already exists in the repository → infer **`REVIEW_FIX`**.
  - If the brief describes a feature, page, or flow not present in the repository → infer **`CREATE`**.
  - If neither classification can be established from available context, halt with a routing blocker (`BLOCKED`).

Never touch live environments, user credentials, or files outside the agreed scope.

## State Machine

```text
UX_JOB_INTAKE
  → MODE_CLASSIFIED (CREATE | REVIEW_FIX)
  → UX_SCOPE (scope.md)
  → UX_COMPLEXITY_CLASSIFIED
  → CHAOS_SCENARIO_WAVE (6–15 subagents, what-if.md)
  → DEBATE_AND_FALSIFICATION (max 2 rounds, what-if.md)
  → STATE_MATRIX_MAPPING (matrix.md)
  → INTERNAL_APPROVAL
      ├─ CREATE       → UX_CONTRACT → IMPLEMENTATION → REVIEW_FIX_LOOP
      └─ REVIEW_FIX  → TEST_GENERATION_WAVE (testgen.md)
            ├─ VERDICT_GATE
            │     ├─ reproduced → ROOT_CAUSE → PATCH_WAVE → REGRESSION_VERIFY
            │     ├─ not-reproduced → EVIDENCE_VERIFY → FINAL_REVIEW (no patch)
            │     └─ ambiguous contract or user choice → ASK_USER
            └─ inconclusive / harness-error → corrected probe or BLOCKED
  → EVIDENCE_VERIFY (evidence.md)
  → FINAL_REVIEW (review.md)
  → DONE | BLOCKED

## Subagent Budget & Allocation Rules

Every scenario analysis wave MUST dispatch between **6 and 15 subagents** (never inline-only, never fewer than 6):

| Complexity Tier | Active Subagents | Partition Strategy |
|---|---:|---|
| **Simple component or interaction** | 6 | Six mandatory baseline risk slices |
| **Form, async action, or several states** | 8–10 | Six baseline slices + flow-specific state/action workers |
| **Multi-step flow or several screens** | 11–13 | Baseline slices + journey/screen/boundary partitions |
| **Realtime, multi-tab, or cross-boundary** | 14–15 | Baseline slices + concurrency, sync, and network recovery |

### Budget Boundaries
- **Global Active Cap**: At most 15 active subagents across the entire job at any moment, including all nested workers. Top-level coordinator is excluded.
- **Sole Allocation Owner**: Only the coordinator owns spawn allocation. Subagents must never spawn independent child workers that breach the global cap.
- **Specialist Phasing**: Reproduction, patch, and review stages reuse the team or dispatch only needed specialists (e.g. 1–3 workers); they do not pad idle workers to keep 6 active.

### Six Mandatory Baseline Slices
1. **User Goal & Discoverability**: Intent clarity, discoverability of actions, next-step cues.
2. **Journey & Interruption**: Ordering errors, abandonment, back/forward, cancellation, repeated actions.
3. **Feedback & Recovery**: Pending indicators, error states, empty views, degraded modes, inline recovery.
4. **Data Integrity & Races**: Duplicate submits, out-of-order responses, stale state, draft preservation.
5. **Accessibility & Modality**: Keyboard navigation, focus traps/restoration, ARIA announcements, responsive boundaries.
6. **Falsification & Existing Mitigations**: Actively searching for existing guards, debounces, or valid alternate interpretations to disprove defect hypotheses.

## Simulation & Debate Protocol

### Complete Interaction Traces
Each scenario must document a full sequence:
```text
precondition → user action → observed UI state → user next action → next state → expected outcome
```
States must describe observable DOM/UI outputs. Do not invent unobservable internal intent. Mark pre-implementation findings as design risks, never confirmed defects.

### Bounded Debate Protocol
1. Workers analyze their slices independently before sharing hypotheses.
2. Coordinator aggregates findings, deduplicates, and identifies conflicting claims.
3. Coordinator dispatches targeted peer counterclaims to relevant workers.
4. At most **two debate rounds** per issue group.
5. Coordinator records accepted decision, supporting evidence, rejected alternatives, and remaining dissent.
6. Consensus is required for the `CREATE` contract; runtime evidence is required for `REVIEW_FIX` defect confirmation. Majority voting never replaces evidence.

## Internal Approval Gates

### 1. `CREATE` Approval Gate
Advance to implementation only when:
- Every critical scenario has an observable, testable expected outcome.
- Acceptance criteria are defined in testable format.
- No evidence-backed critical contradiction remains unresolved after two debate rounds.
- Scope and repository conventions are verified.

### 2. `REVIEW_FIX` Approval Gate
Advance to patching only when:
- Target symbol or flow is identified unambiguously.
- Failure has verdict `reproduced` against the real target (not a mock harness error).
- Violated invariant and causal trace are documented.
- A deterministic regression test or verification procedure is prepared.

### 3. Operator Blocker Gate
Stop and ask the human operator ONLY when missing information cannot be derived from repository context, design docs, or runtime checks, and directly impacts:
- Unresolvable product contract ambiguity.
- Unclear target identity.
- Permission or security boundaries.
- Irreversible destructive actions.

## Error Handling & Verdict Rules
- `reproduced`: Defect verified against target code; proceed to root cause and minimal patch.
- `not-reproduced`: Invariant held under test; do not alter production code. Proceed to review.
- `inconclusive`: Watchdog expired without observation; retry with calibrated timeout or report gap.
- `harness-error`: Test fixture crashed or failed setup; fix the harness, not production code.
- `BLOCKED`: Document missing prerequisite, environment barrier, or contract contradiction. Never deploy a fake fallback.

## Coordinator Summary Schema
Emit a structured final report containing:
- `uxRunId`: unique run identifier.
- `actionMode`: `"CREATE"` | `"REVIEW_FIX"`.
- `targetFlow`: component, page, or feature name.
- `complexity`: classification level.
- `activeSubagentCount`: peak active subagents during scenario wave.
- `scenarioFindings`: table of scenario ID, category, user trigger, severity, confidence.
- `debateDecisions`: summary of debated issues, resolution, and dissent.
- `confirmedFailures`: list of reproduced defects (if `REVIEW_FIX`).
- `patches`: summary of minimal fixes applied.
- `verification`: test execution results, regression assertions, and browser smoke proofs.
- `remainingRisks`: documented edge cases or platform boundaries.
- `status`: `"DONE"` | `"BLOCKED"`.
