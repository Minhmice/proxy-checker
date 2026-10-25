---
name: crucible
description: "Use when code changes settle after an edit turn, or when asked to run an autonomous end-to-end stress test, reproduction, patch, and review."
---

# Crucible Master Router

## Core Mission
Orchestrate an end-to-end stress audit for a recently modified function or workflow. Never guess missing targets or fix speculative bugs.

## Execution Context & Checkpoints
When triggered by the OMP extension, consume incoming context:
- `auditRunId`: unique identifier for the current run.
- `changedFiles`: list of modified code files to seed `SCOPE`.
- `auditContinuation`: resume from last settled state; do not repeat already verified waves.
- Never touch live systems (`~/.omp`), credentials, or unrelated user files.

## State Machine

```text
CODE_CHANGE_DETECTED
  → SCOPE
  → COMPLEXITY_CLASSIFIED
  → AUDIT_WAVE
  → FINDINGS_MERGED
  → WEB_EVIDENCE_CHECK
  → REPRO_WAVE
  → VERDICT_GATE
      ├─ no confirmed issue → FINAL_REVIEW
      ├─ confirmed issue → ROOT_CAUSE
      └─ ambiguous contract/target/permission → ASK_USER
  → FIX_WAVE
  → REGRESSION_VERIFY
  → FINAL_REVIEW
  → DONE | BLOCKED
```

## Orchestration Rules

1. **SCOPE**: Follow `scope.md`. Inspect git diff and modified files to locate target function/workflow. If target identity or contract is ambiguous, STOP and ask user.
2. **COMPLEXITY_CLASSIFIED**: Classify complexity per `scope.md`:
   - Small pure logic: 1-2 workers or inline.
   - Async function / external dependency: 3-5 workers.
   - Stateful / concurrent workflow: 5-8 workers plus falsification.
   - Distributed / security-sensitive: 8-10 workers plus falsification and evidence review.
3. **AUDIT_WAVE**: Follow `stress.md`. Dispatch parallel subagents (`agent: "scout"`) across independent failure slices, with at least one dedicated falsification worker to disprove hypotheses.
4. **FINDINGS_MERGED**: Merge duplicate causes, group by root invariant, and identify external assumptions.
5. **WEB_EVIDENCE_CHECK**: Follow `evidence.md` (`agent: "scout"`) for findings relying on external library, runtime, or protocol claims.
6. **REPRO_WAVE**: Follow `repro.md` (`agent: "task"`). Exercise real target symbols with deterministic isolated test fixtures.
7. **VERDICT_GATE**:
   - If no issue is confirmed: advance directly to `FINAL_REVIEW`.
   - If a failure is reproduced with clear cause: advance to `ROOT_CAUSE` and `FIX_WAVE`.
   - If contract, permission, or scope is ambiguous: ask user.
8. **FIX_WAVE & REGRESSION_VERIFY**: Follow `patch.md`. Implement minimal surgical fix, convert probe to regression test, and verify full affected test module.
9. **FINAL_REVIEW**: Follow `review.md`. Inspect diff, verify consistency, scope, and remaining risks.
10. **DONE / BLOCKED**: Emit final summary. If blocked by missing permissions, live resource access, or destructive action, mark `BLOCKED` with specific details.

## Red Flags - STOP and Ask/Restart
- Attempting fixes before a deterministic probe yields `reproduced`.
- Testing synthetic mocks or stubs instead of invoking actual production symbols.
- Proceeding when target identity, contract, or permissions are ambiguous without asking user.
- Padded subagent counts for simple logic.
- Mutating live configurations, environment variables, or files outside diff scope.

## Common Rationalizations

| Temptation | Required Response |
|---|---|
| "The bug is obvious from inspection; skip reproduction." | Probes are mandatory. Unexecuted hypotheses are leads, not verified bugs. |
| "A synthetic mock hung, so production code is deadlocked." | Synthetic stalls prove harness behavior, not target runtime deadlocks. |
| "Fix is minimal, so skip the wider test suite." | Run full affected test files to prevent ripple regressions. |
| "Target behavior is slightly unclear; guess reasonable defaults." | Ambiguous contracts require user clarification. Stop and ask. |

## Coordinator Summary Schema
Emit final audit report covering:
- `auditRunId`: active run identifier.
- `targetSymbols`: functions/workflows evaluated.
- `complexity`: classification level.
- `findings`: table of ID, category, confidence, and verdict.
- `reproduction`: probe command, execution result, and watchdog timeout.
- `fixVerification`: regression test and full module test output.
- `status`: `DONE` | `BLOCKED` (with blocker reason).
