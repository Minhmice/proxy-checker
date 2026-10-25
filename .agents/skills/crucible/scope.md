# Scope Extraction Reference

## Objective
Establish the exact technical boundary of the modified code before dispatching scenario workers.

## Scope Extraction Workflow
1. Read the git diff and modified files to isolate changed functions, methods, or workflows.
2. Trace upstream callers and downstream consumers using symbol search or code intelligence.
3. Identify core invariants (safety, liveness, consistency, data integrity).
4. Determine risk dimensions: transport, concurrency, auth, state drift, validation, resource collision, configuration.
5. Classify complexity: `small` (pure logic), `medium` (async/network), `high` (stateful/concurrency), or `distributed` (multi-node/multi-router).

## Required Scope Output Schema
The output artifact MUST contain the following fields:
- `targetSymbols`: string[] of modified functions/methods.
- `callers`: string[] of direct callers.
- `boundaries`: string[] of module/network/storage boundaries.
- `invariants`: string[] of system guarantees that must never be violated.
- `riskDimensions`: string[] of applicable failure modes.
- `changedFiles`: string[] of paths modified.
- `excludedScope`: string[] of untouched features explicitly out of scope.
- `complexity`: "small" | "medium" | "high" | "distributed".
- `openQuestions`: string[] of unresolved contract questions.

## Stopping Gates
- If `targetSymbols` cannot be identified unambiguously, STOP and ask the user.
- If `invariants` conflict with product documentation or user intent, STOP and ask for clarification.
