# Antigravity Rotation Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic Antigravity rotation follow Gemini session quota and earliest reset-time policy while keeping proxy snapshots consistent with confirmed 9Router state.

**Architecture:** Keep the existing pure `computeRotationPlan()` decision function and `createAntigravityRotator()` orchestration boundary. Change only the planner predicates/order and the orchestration bookkeeping needed to represent failed proxy reassignment and concurrent callers correctly; do not add a global mutex or couple router sync and rotation.

**Tech Stack:** TypeScript, Node.js `node:test`, SQLite-backed rotation history, 9Router client adapters.

**Spec:** Approved in chat on 2026-10-11: session-only quota policy, reset-time priority, confirmed proxy state, and fresh settings after an in-flight rotation.

## Global Constraints

- Evaluate only Gemini session quota for automatic activation/deactivation; ignore Gemini weekly quota for rotation decisions.
- Deactivate accounts at or below the configured session threshold; promote backups strictly above it.
- Rank backup accounts by earliest valid `resetAt`; missing/invalid reset times sort last, with stable ID tie-break.
- Preserve a healthy existing proxy assignment during routine rotation.
- Never publish a new proxy assignment in the snapshot unless the 9Router update succeeds.
- Do not serialize router sync and Antigravity rotation with a shared mutex.
- Do not change production account state as part of verification; use isolated dependency fixtures.

---

### Task 1: Replace policy-regression tests

**Files:**
- Modify: `tests/antigravity-rotation-history.test.ts:18-38`
- Modify: `tests/antigravity-rotator.test.ts:29-93`

**Interfaces:**
- Consumes: `computeRotationPlan(accounts, usableProxies, options)` and `extractAntigravityUsage(rawUsage)`.
- Produces: executable regression expectations for session-only policy and reset ordering.

- [ ] **Step 1: Replace the weekly-floor test with a session-only test**

Use accounts where an active account has `sessionPercentage: 80, weeklyPercentage: 1` and a reserve has `sessionPercentage: 50, weeklyPercentage: 1`; assert the active account survives and the reserve is eligible when a slot exists. Keep a separate account at `sessionPercentage: 20` and assert it is deactivated. Update the test name to state that weekly quota is ignored.

- [ ] **Step 2: Replace the LRU/turn-order integration assertions**

In the fixture, give candidates different `lastActivatedAt` and `turnCount` values but reset times where the earlier reset candidate is not the LRU candidate. Assert the earlier valid `resetAt` is activated first. Keep the existing failed OFF/failed ON tests, changing only expectations that depended on weekly quota.

- [ ] **Step 3: Add missing-weekly parsing coverage**

For `extractAntigravityUsage({ quotas: { gemini_session: { remainingPercentage: 80 } } })`, assert `sessionPercentage === 80` and that the parsed account is eligible for planning; do not require `gemini_weekly` for session-based eligibility. Preserve the existing invalid-input assertions for malformed session data.

- [ ] **Step 4: Run only the focused tests and confirm they fail**

Run:

```bash
node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts
```

Expected: FAIL because current planning checks `weeklyPercentage` and sorts candidates by unused/LRU/turn count.

---

### Task 2: Implement session-only planning and reset ordering

**Files:**
- Modify: `src/server/antigravity-rotator.ts:59-104,166-235`

**Interfaces:**
- Consumes: existing `AntigravityUsage`, `AntigravityAccountInput`, `RotationPlan` types.
- Produces: unchanged public `computeRotationPlan` and `extractAntigravityUsage` signatures with corrected semantics.

- [ ] **Step 1: Make session quota sufficient for parsed usage**

Change `extractAntigravityUsage()` so `quotaAvailable` reflects a valid Gemini session quota rather than requiring `gemini_weekly`. Keep `weeklyPercentage` populated for display when present, but do not use it to determine rotation eligibility.

- [ ] **Step 2: Remove weekly quota from active-account exhaustion**

In `computeRotationPlan()`, make the exhaustion condition depend on `quotaAvailable`, `sessionPercentage <= sessionThreshold`, and `lastError`. Remove `weeklyPercentage <= 10` from this decision.

- [ ] **Step 3: Remove weekly quota from reserve eligibility**

Require reserve candidates to have a valid session quota, `sessionPercentage > sessionThreshold`, and no `lastError`. Do not inspect `weeklyPercentage`.

- [ ] **Step 4: Sort candidates by remaining reset time**

Replace unused/LRU/turn-count ordering with a comparator that parses `resetAt` timestamps, puts valid timestamps before missing/invalid timestamps, sorts ascending by timestamp, then uses `id.localeCompare()` as a stable tie-break. Do not mutate the account history fields.

- [ ] **Step 5: Run the focused tests and confirm they pass**

Run:

```bash
node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts
```

Expected: PASS for session-only eligibility, reset-time priority, proxy collision, dead-proxy replacement, and existing activation failure behavior.

---

### Task 3: Make proxy reassignment and in-flight callers truthful

**Files:**
- Modify: `src/server/antigravity-rotator.ts:308-511`
- Modify: `tests/antigravity-rotation-history.test.ts:40-128`

**Interfaces:**
- Consumes: `createAntigravityRotator(deps)` and existing `AntigravityRotator.runRotation()` interface.
- Produces: `runRotation()` that returns a snapshot reflecting confirmed upstream changes; overlapping callers await the active cycle result rather than receiving a stale snapshot.

- [ ] **Step 1: Add a failing proxy-reassignment consistency test**

Create an isolated fixture with one active account on a dead proxy and one usable replacement. Make `updateConnection()` throw only for the proxy reassignment patch. Run rotation and assert the returned account keeps its original `proxyPoolId`, does not claim the replacement as healthy, and that the failed update is represented by `lastError` or equivalent observable account state.

- [ ] **Step 2: Add a failing overlapping-call result test**

Use a deferred `listConnections()` or `getUsage()` in the existing fixture. Start two `runRotation({ force: true })` calls before releasing the deferred dependency. Assert both promises resolve to the same completed cycle snapshot, and neither resolves early with the previous cached snapshot.

- [ ] **Step 3: Implement an in-flight promise boundary**

Add a private `runningCycle: Promise<AntigravityRotatorSnapshot> | null` in `createAntigravityRotator()`. The first caller owns the actual cycle; overlapping callers return the same promise. Clear the field in a `finally` attached to the owner promise. Preserve `isRunning` and the existing `running` boolean for status reporting.

- [ ] **Step 4: Track successful proxy updates only**

When applying `plan.proxyReassignments`, collect successful assignments in a map. On failure, leave the account’s prior `proxyPoolId` and mark the account state with the upstream error. When building the snapshot, apply only successful reassignment entries; never use the planned target as evidence of success.

- [ ] **Step 5: Run focused integration tests**

Run:

```bash
node --import tsx --test tests/antigravity-rotation-history.test.ts
```

Expected: PASS, including reassignment failure truthfulness and overlapping caller behavior.

---

### Task 4: Update policy documentation and run verification

**Files:**
- Modify: `docs/operations.md` or the existing Antigravity operations documentation section identified during implementation.
- Test: `tests/antigravity-rotator.test.ts`, `tests/antigravity-rotation-history.test.ts`, full repository test suite.

**Interfaces:**
- Consumes: corrected planner/orchestrator behavior from Tasks 2–3.
- Produces: operator-facing documentation matching runtime behavior and verified regression suite.

- [ ] **Step 1: Document the exact rotation policy**

State that automatic rotation uses Gemini session quota only, ignores weekly quota, deactivates at or below the configured threshold, promotes accounts above it, prioritizes earliest valid reset time, preserves healthy proxy assignments, and reports failed upstream proxy changes as failures.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Run the focused tests again**

Run:

```bash
node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts
```

Expected: all focused Antigravity tests pass.

- [ ] **Step 4: Run the full regression suite**

Run:

```bash
npm test
```

Expected: all repository tests pass with no new failures.

- [ ] **Step 5: Exercise the non-production API path**

Use the existing isolated test fixture or a throwaway local server request to invoke the Antigravity refresh route with mocked dependencies. Confirm the returned `activeCount`, account assignments, and errors match the planner result. Do not call the production 9Router account mutation path for verification.

- [ ] **Step 6: Re-read changed files and report evidence**

Confirm all changed callsites and tests are covered. Report only observed command output and explicitly note any runtime path not exercised.
