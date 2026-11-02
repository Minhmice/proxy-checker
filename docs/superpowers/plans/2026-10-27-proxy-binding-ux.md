# Proxy Binding UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/ninerouter/proxies` safe and account-centric for binding Antigravity accounts to 9Router proxy pools, while preserving the existing Obsidian Flame/shadcn visual system.

**Architecture:** Keep page-level ownership of node, account, pool, loading, mutation, and error state. Correct the backend mutation contract so account activation and pool binding are independent. Replace the implicit cross-column selection dependency with a persistent binding context and a shadcn dialog picker scoped to the selected account/node. Preserve the existing pool table for diagnostics, but make pool ownership and action state explicit.

**Tech Stack:** Next.js 16, React 19, TypeScript, Hono, shadcn/Radix UI, Tailwind v4, Sonner, Node test runner.

**Spec:** UX research artifacts at `local://ux-bindings-20261027/review.md`, `local://ux-bindings-20261027/matrix.md`, and `local://ux-bindings-20261027/testgen.md`.

## Global Constraints

- No mutation may clear or overwrite a healthy proxy binding unless the operator explicitly confirms the replacement.
- Account active toggles MUST update account activity without changing `providerSpecificData.proxyPoolId`.
- Node changes MUST clear account/pool selection context and MUST discard stale responses.
- Empty, filtered-empty, loading, and node-error states MUST be visibly distinct.
- Destructive actions MUST use shadcn confirmation or an explicit undo affordance.
- All UI changes MUST use existing shadcn primitives and semantic project tokens where available; sidebar remains untouched.
- No new dependency, mock fallback, credential use, or verification-asset modification.
- Existing project decisions remain authoritative: dual-master, disjoint proxy allocation, backend audit ownership, conservative watchdog, and persistent healthy bindings.

---

### Task 1: Correct backend account and binding mutation contracts

**Files:**
- Modify: `src/server/api/routes/ninerouter.ts:274-300`
- Modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx:134-243`
- Test: `tests/ninerouter-binding-contract.test.ts`

**Interfaces:**
- `PUT /api/ninerouter/nodes/:nodeId/connections/:connectionId/bind-pool` accepts `{ poolId?: string | null }` and changes only `providerSpecificData.proxyPoolId`.
- The same route accepts `{ isActive?: boolean }` and changes only `isActive`; it MUST preserve the existing proxy pool ID.
- The page handler `handleToggleConnection(id, nextActive)` sends `{ isActive: nextActive }`, not an inverted value.

- [ ] **Step 1: Write failing contract tests**
  - Add an isolated Hono route test using injected `fetchFromNode`/legacy dependencies or the repository's existing route test pattern.
  - Assert a pool bind emits `providerSpecificData.proxyPoolId` and no `isActive` field.
  - Assert an active toggle emits `isActive` and no `providerSpecificData` field.
  - Assert `{ isActive: false }` preserves the upstream binding in the mocked request body contract.

- [ ] **Step 2: Run the focused test and confirm failure**
  - Run: `node --import tsx --test tests/ninerouter-binding-contract.test.ts`
  - Expected: FAIL because the current route drops `isActive` and writes `proxyPoolId: null`.

- [ ] **Step 3: Implement the minimal route patch**
  - Parse the JSON body once.
  - Build a patch with `providerSpecificData` only when `poolId` is an own property.
  - Add `isActive` only when it is a boolean.
  - Reject a body that contains neither recognized field with HTTP 400.
  - Preserve upstream response status/body behavior.

- [ ] **Step 4: Fix page toggle payload and response handling**
  - Rename the handler argument to `nextActive`.
  - Send `{ isActive: nextActive }`.
  - Update local state to `nextActive` only after `res.ok`; surface a status-specific error otherwise.

- [ ] **Step 5: Run focused tests**
  - Run: `node --import tsx --test tests/ninerouter-binding-contract.test.ts`
  - Expected: PASS with zero failures.

---

### Task 2: Add node-scoped loading/error/selection safety

**Files:**
- Modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx:23-132,327-453`
- Test: `tests/proxy-binding-state.test.ts`

**Interfaces:**
- Add `loadState: "loading" | "ready" | "error"` and `loadError: string | null`.
- `loadData()` uses an `AbortController`/request generation guard and ignores stale node responses.
- Changing `selectedNode` clears `selectedConnectionId`, `testResults`, `testingMap`, and visible data before the new request is committed.

- [ ] **Step 1: Write failing pure state tests**
  - Test that node generation N cannot commit after generation N+1.
  - Test that a failed response produces `loadState: "error"` instead of an empty-data state.
  - Test that filter/search cannot leave an invisible selected account as the only binding target.

- [ ] **Step 2: Run focused tests and confirm failure**
  - Run: `node --import tsx --test tests/proxy-binding-state.test.ts`
  - Expected: FAIL because no request generation/load error model exists.

- [ ] **Step 3: Implement request cancellation and explicit load states**
  - Keep one `AbortController` ref and abort it before each new node load/unmount.
  - Treat non-OK connections or pools responses as an error with node-specific message.
  - Clear stale arrays at the start of a node load; commit results only for the current request generation.
  - Keep the existing Antigravity refresh best-effort behavior, but do not let its failure hide node data.

- [ ] **Step 4: Implement selection boundary**
  - Clear selection on node change.
  - Derive `selectedConnection` from current `connections`.
  - If a filter hides the selected account, retain it only through the explicit context bar; never permit a hidden target without context.
  - Clear test result state on node change.

- [ ] **Step 5: Render distinct loading/error/filtered-empty states**
  - Pass `loadState`/`loadError` to both tables.
  - Add inline Retry action that calls `loadData`.
  - Keep configured-empty copy separate from filtered-empty copy.
  - Wire search clear button to `setSearchQuery("")` and add `aria-label="Clear search"`.

- [ ] **Step 6: Run focused tests**
  - Run: `node --import tsx --test tests/proxy-binding-state.test.ts`
  - Expected: PASS with zero failures.

---

### Task 3: Build account-centric binding picker and context bar

**Files:**
- Create: `src/components/ninerouter/binding-context-bar.tsx`
- Create: `src/components/ninerouter/binding-picker-dialog.tsx`
- Modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx:172-243,455-479`
- Modify: `src/components/ninerouter/account-bindings-table.tsx:106-195`
- Modify: `src/components/ninerouter/proxy-pools-table.tsx:18-304`
- Test: `tests/proxy-binding-ux.test.ts`

**Interfaces:**
- `BindingContextBarProps`: `account`, `nodeName`, `currentPool`, `onChangePool`, `onDeselect`.
- `BindingPickerDialogProps`: `open`, `onOpenChange`, `account`, `pools`, `currentPoolId`, `busyPoolId`, `onBind`.
- `ProxyPoolItem` gains optional `boundAccountLabel?: string` only if backend payload already supplies authoritative ownership; do not infer ownership from `boundCount`.

- [ ] **Step 1: Write failing interaction/state tests**
  - Assert selected account context remains visible when search/filter hides the account.
  - Assert selecting a pool already bound to the same account renders Current/Bound, not a duplicate bind action.
  - Assert inactive pool cannot be bound without explicit confirmation state.
  - Assert keyboard Enter/Space selects an account row and Escape closes the picker.

- [ ] **Step 2: Run focused tests and confirm failure**
  - Run: `node --import tsx --test tests/proxy-binding-ux.test.ts`
  - Expected: FAIL because context bar, dialog, and keyboard row selection do not exist.

- [ ] **Step 3: Implement the context bar**
  - Render selected account identity, current pool/direct state, node label, and Deselect.
  - Use shadcn Button/Badge/Card primitives and semantic tokens.
  - Make it the only source of truth for the current binding target visible above both panes.

- [ ] **Step 4: Implement the picker dialog**
  - Use existing shadcn Dialog primitives.
  - List pools with current, available, inactive, and test-failed states.
  - Bind action uses captured account ID and selected node, disables itself while pending, and reports success/failure.
  - Do not claim a pool is free unless authoritative `boundCount`/ownership data proves it; otherwise show `Assignment status unavailable` and require the existing backend contract to decide.

- [ ] **Step 5: Rewire account and pool tables**
  - Make account selection keyboard reachable with `tabIndex={0}`, `aria-selected`, and Enter/Space handling.
  - Add account-specific labels to switches and icon buttons.
  - Replace repeated implicit cross-column Bind dependency with a clear `Change proxy` action that opens the picker; retain diagnostic pool test controls.
  - Keep pool delete action separate from binding action.

- [ ] **Step 6: Run focused tests**
  - Run: `node --import tsx --test tests/proxy-binding-ux.test.ts`
  - Expected: PASS with zero failures.

---

### Task 4: Add mutation busy states and destructive guardrails

**Files:**
- Modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx:134-325`
- Modify: `src/components/ninerouter/account-bindings-table.tsx:163-193`
- Modify: `src/components/ninerouter/proxy-pools-table.tsx:243-295`
- Test: `tests/proxy-binding-actions.test.ts`

**Interfaces:**
- Maintain per-resource pending maps for account, pool, delete, bind, test, and reset operations.
- Delete confirmation receives the exact pool object and bound impact count.
- Auto Bind becomes preview-only until a safe backend planner/batch contract exists; it MUST NOT silently mass-rebind healthy accounts.

- [ ] **Step 1: Write failing action tests**
  - Assert duplicate clicks produce one request per target.
  - Assert Delete does not call DELETE before confirmation.
  - Assert Auto Bind does not overwrite healthy bindings or use modulo capacity.
  - Assert partial failure returns success/failed/skipped counts.

- [ ] **Step 2: Run focused tests and confirm failure**
  - Run: `node --import tsx --test tests/proxy-binding-actions.test.ts`
  - Expected: FAIL against current unguarded handlers.

- [ ] **Step 3: Add row-level busy states**
  - Disable target control while its request is active.
  - Show spinner or `Updating…` inline without changing confirmed data until response succeeds.
  - Capture target account ID before awaiting any request.

- [ ] **Step 4: Add confirmation and undo**
  - Add shadcn AlertDialog for pool deletion with name and impact.
  - Add a short Undo action for unbind that restores the exact prior pool ID if still valid; otherwise show recovery failure and require picker selection.
  - Make Reset Proxies label explicitly global and require confirmation.

- [ ] **Step 5: Make Auto Bind safe**
  - Replace the current modulo loop with a preview/error state and explicit capacity result.
  - Until a backend planner/batch route exists, do not send mass binding writes from the page.
  - Preserve manual binding through the picker.

- [ ] **Step 6: Run focused tests**
  - Run: `node --import tsx --test tests/proxy-binding-actions.test.ts`
  - Expected: PASS with zero failures.

---

### Task 5: Separate audited lifecycle from ephemeral pool test status

**Files:**
- Modify: `src/components/ninerouter/proxy-pools-table.tsx:66-107,203-226`
- Modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx:245-264`
- Test: `tests/proxy-binding-status.test.ts`

**Interfaces:**
- `testResults[poolId]` represents latest manual test only.
- Lifecycle badge remains sourced from `pool.isActive`/backend audit fields.
- Latency cell states: `Never tested`, `Testing…`, `<n>ms`, `Failed: <reason>`.

- [ ] **Step 1: Write failing status tests**
  - Assert one failed manual test does not render lifecycle `Dead`.
  - Assert testing renders `Testing…`.
  - Assert refresh clears or revalidates test result state for the active node.

- [ ] **Step 2: Run focused tests and confirm failure**
  - Run: `node --import tsx --test tests/proxy-binding-status.test.ts`
  - Expected: FAIL because test failure currently changes the lifecycle badge.

- [ ] **Step 3: Implement separated status rendering**
  - Keep `renderStatusBadge` independent from `testResult`.
  - Render manual test state in the latency column with a timestamp/freshness label when available.
  - Clear test results on node refresh or namespace them by node.

- [ ] **Step 4: Run focused tests**
  - Run: `node --import tsx --test tests/proxy-binding-status.test.ts`
  - Expected: PASS with zero failures.

---

### Task 6: Verify full behavior and visual surface

**Files:**
- Modify only files from Tasks 1–5 if verification reveals an actual defect.
- Do not modify tests or verification assets to make checks pass.

- [ ] **Step 1: Run typecheck**
  - Run: `npm run typecheck`
  - Expected: exit 0.

- [ ] **Step 2: Run focused binding tests**
  - Run: `node --import tsx --test tests/ninerouter-binding-contract.test.ts tests/proxy-binding-state.test.ts tests/proxy-binding-ux.test.ts tests/proxy-binding-actions.test.ts tests/proxy-binding-status.test.ts`
  - Expected: all tests pass, zero failures.

- [ ] **Step 3: Run lint and formatting checks**
  - Run: `npm run lint && npm run format:check`
  - Expected: exit 0 with no diagnostics.

- [ ] **Step 4: Run the app and exercise the real route**
  - Run: `npm run dev`.
  - Open `/ninerouter/proxies` using an authorized non-production session only.
  - Verify account toggle preservation, picker bind, node switch race, error/retry, delete confirmation, keyboard selection, reduced motion, and viewports 390/768/1440.
  - Expected: no stale cross-node data, no hidden bind target, distinct error/empty states, no mutation before confirmation.

- [ ] **Step 5: Run full repository test suite**
  - Run: `npm test`
  - Expected: exit 0 with zero failures.

- [ ] **Step 6: Run the existing UI detector**
  - Run: `C:/Users/minhmice/.agents/skills/impeccable/scripts/impeccable.cmd detect --json src/components/ninerouter`
  - Expected: exit 0 or only findings directly attributable to the changed binding surface; investigate each finding.
