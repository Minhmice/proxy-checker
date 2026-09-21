# Proxy Testing and Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver real single/batch proxy testing, automatic confirmed-dead removal with local recovery, rename/restore lifecycle operations, and faster configurable Diagnostics UI.

**Architecture:** Extend `pool-state.json` into the durable registry with separate local and remote identity. Server owns all destructive/recovery state transitions and exposes polling-friendly APIs; client renders per-record lifecycle/test state and invokes typed API helpers. Diagnostics keeps file input but samples correctly and runs through the existing bounded concurrency setting.

**Tech Stack:** TypeScript 6, Node.js `node:test`, custom Node HTTP server, Next.js 16, React 19, Radix UI, lucide-react, CSS.

**Spec:** `docs/superpowers/specs/2026-09-22-proxy-testing-lifecycle-design.md`

## Global Constraints

- A linked proxy is deleted from 9Router only after two consecutive failures against the same `api.ipify.org` health check.
- Deleted pools stay in the local registry with name, endpoint, counters, timestamps, and errors.
- Removed proxies recheck only after primary sync/ranking/activation completes, or by manual action; recheck never delays the primary sync.
- Recovered proxies enter `revived`; restoration is manual and creates or reconciles an inactive 9Router pool.
- Diagnostics failures never mutate 9Router.
- Rename is remote-first for linked/delete-failed records and local-only for removed/revived records; names are trimmed, non-empty, and at most 100 Unicode code points.
- `checkConcurrency` bounds both proxy batches and Diagnostics workers.
- No new production dependency, database, WebSocket, or SSE.
- Remove misleading derived Mbps; latency is not throughput.
- All buttons, menu items, inputs, checkboxes, and dialog controls have a minimum 44 px hit area; state color always has icon or text; reduced motion remains supported.
- Follow TDD: each new behavior test must fail for the intended reason before production code is written.

---

### Task 1: Backend Proxy Lifecycle and Concurrent Diagnostics

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/server/nine-router-client.ts`
- Modify: `src/server/checker.ts`
- Modify: `src/server/pool-ranker.ts`
- Modify: `src/server/detailed-checker.ts`
- Modify: `src/server/server.ts`
- Create: `tests/pool-ranker.test.ts`
- Modify: `tests/detailed-checker.test.ts`

**Interfaces:**
- Produces types consumed by Task 2:
  - `RemoteState = "linked" | "removed" | "revived" | "delete_failed"`
  - `TestState = "idle" | "queued" | "checking" | "retrying"`
  - `PoolRecord.localId: string`
  - `PoolRecord.remoteId: string | null`
  - `PoolRecord.remoteState: RemoteState`
  - `PoolRecord.testState: TestState`
  - `PoolRecord.firstFailure?: string`
  - `DiagnosticJob.sampleCount: number | null`
- Produces lifecycle methods consumed by HTTP routing:
  - `testPools(ids: string[]): Promise<{ accepted: string[]; busy: string[] }>`
  - `renamePool(localId: string, name: string): Promise<PoolRecord>`
  - `removePool(localId: string): Promise<PoolRecord>`
  - `restorePool(localId: string): Promise<PoolRecord>`
- Produces HTTP contracts consumed by Task 2:
  - `POST /api/ninerouter/test` with `{ ids: string[] }`
  - `PATCH /api/ninerouter/pools/:localId` with `{ name: string }`
  - `DELETE /api/ninerouter/pools/:localId`
  - `POST /api/ninerouter/pools/:localId/restore`
  - `POST /api/diagnostics/run` with `{ file, samplePercent? }` or `{ file, sampleCount }`

- [ ] **Step 1: Write failing lifecycle tests**

Create `tests/pool-ranker.test.ts` with a temporary data directory and injected fakes for `listPools`, `setPoolActive`, `deletePool`, `createPool`, `updatePool`, and proxy checks. Cover observable contracts:

```ts
test("retry success keeps the remote pool and records a transient failure", async () => {
  const harness = createHarness({ checks: [dead("timeout"), usable("203.0.113.4")] });
  await harness.ranker.testPools([harness.localId]);
  const pool = harness.ranker.listByTier("all")[0];
  assert.equal(harness.deleted.length, 0);
  assert.equal(pool.remoteState, "linked");
  assert.equal(pool.status, "usable");
  assert.equal(pool.firstFailure, "timeout");
});

test("two failures remove remotely and retain the local record", async () => {
  const harness = createHarness({ checks: [dead("timeout"), dead("timeout")] });
  await harness.ranker.testPools([harness.localId]);
  const pool = harness.ranker.listByTier("removed")[0];
  assert.deepEqual(harness.deleted, ["remote-1"]);
  assert.equal(pool.remoteId, null);
  assert.equal(pool.remoteState, "removed");
  assert.equal(pool.proxyUrl, "http://127.0.0.1:8080");
});

test("delete failure keeps remote identity and exposes delete_failed", async () => {
  const harness = createHarness({ checks: [dead("timeout"), dead("timeout")], deleteError: new Error("upstream unavailable") });
  await harness.ranker.testPools([harness.localId]);
  const pool = harness.ranker.listByTier("removed")[0];
  assert.equal(pool.remoteId, "remote-1");
  assert.equal(pool.remoteState, "delete_failed");
  assert.match(pool.last_error ?? "", /upstream unavailable/);
});

test("a removed proxy becomes revived without remote creation", async () => {
  const harness = createHarness({ remoteState: "removed", remoteId: null, checks: [usable("203.0.113.4")] });
  await harness.ranker.testPools([harness.localId]);
  assert.equal(harness.created.length, 0);
  assert.equal(harness.ranker.listByTier("removed")[0].remoteState, "revived");
});

test("restore creates an inactive remote pool and stores its new id", async () => {
  const harness = createHarness({ remoteState: "revived", remoteId: null });
  const pool = await harness.ranker.restorePool(harness.localId);
  assert.equal(harness.created[0].isActive, false);
  assert.equal(pool.remoteId, "remote-restored");
  assert.equal(pool.remoteState, "linked");
  assert.equal(pool.tier, "reserve");
});

test("linked rename updates 9Router before local state", async () => {
  const harness = createHarness({ updateError: new Error("rename refused") });
  await assert.rejects(() => harness.ranker.renamePool(harness.localId, "New name"), /rename refused/);
  assert.equal(harness.ranker.listByTier("all")[0].name, "Original name");
});
```

Also cover DELETE 404 as success, restore endpoint reconciliation, local-only rename, unknown IDs, duplicate/busy tests, name trim/empty/101-code-point rejection, and backward normalization from old `id` records.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `npm test -- tests/pool-ranker.test.ts`

Expected: FAIL because lifecycle types, dependency injection, and methods do not exist.

- [ ] **Step 3: Add lifecycle types and 9Router CRUD**

Update `src/lib/types.ts` with the produced types above. Replace `PoolRecord.id` with `localId`; migrate every server caller in this task. Add minimal 9Router operations using the existing authenticated `request`:

```ts
export function updatePool(id: string, patch: { name?: string; isActive?: boolean })
export function deletePool(id: string)
export function createPool(input: { name: string; proxyUrl: string; type: string; isActive: false })
```

Use `PUT /api/proxy-pools/:id`, `DELETE /api/proxy-pools/:id`, and `POST /api/proxy-pools`. Preserve upstream status on thrown errors so remote DELETE 404 can be treated as idempotent success.

- [ ] **Step 4: Implement registry normalization and lifecycle transitions**

Add an optional dependency parameter to `createPoolRanker` with production defaults; this keeps tests deterministic without adding a generic service layer:

```ts
interface PoolRankerDeps {
  listPools: typeof listPools;
  setPoolActive: typeof setPoolActive;
  bulkSetActive: typeof bulkSetActive;
  deletePool: typeof deletePool;
  createPool: typeof createPool;
  updatePool: typeof updatePool;
  checkProxy: typeof checkProxy;
}
```

Normalize legacy records on read, reconcile remote pools by remote ID then normalized endpoint, preserve absent removed records, and implement:

- one check, exactly one retry on failure;
- attempt counters and `firstFailure` semantics from the spec;
- remote-first confirmed-dead deletion;
- `delete_failed` on non-404 remote errors;
- manual test dedupe with an in-memory `Set<string>`;
- removed success to `revived` without creating remotely;
- restore reconciliation or inactive creation;
- remote-first and local-only rename rules;
- manual remote removal;
- background removed-proxy recheck started only after primary sync finishes, without awaiting it.

Each state write remains temp-file plus rename. Batch items update state independently.

- [ ] **Step 5: Wire lifecycle HTTP routes**

In `src/server/server.ts`, parse dynamic pool paths with one regex and add the four lifecycle endpoints. Validate non-empty unique IDs and names at the HTTP boundary. Status mapping:

- 400 invalid request;
- 404 unknown local record;
- 409 invalid lifecycle/busy conflict;
- 502 9Router transport/server error;
- DELETE upstream 404 remains success.

Keep existing `/activate`, `/sync`, and polling endpoints compatible with `localId`.

- [ ] **Step 6: Run lifecycle tests and verify GREEN**

Run: `npm test -- tests/pool-ranker.test.ts`

Expected: all lifecycle tests PASS.

- [ ] **Step 7: Replace obsolete Diagnostics test with failing scope/concurrency tests**

Delete the existing test that pins the obsolete 30% cap. Add behavior tests using an injected `testProxy` function:

```ts
test("diagnostics honors percent and custom count scopes", async () => {
  const percent = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await percent.runner.run({ file: "sample.txt", samplePercent: 50 });
  assert.equal(percent.runner.getJob().total, 5);

  const count = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await count.runner.run({ file: "sample.txt", samplePercent: 10, sampleCount: 7 });
  assert.equal(count.runner.getJob().total, 7);
});

test("diagnostics never exceeds configured concurrency and continues after failure", async () => {
  const harness = createRunnerHarness({ endpoints: 8, concurrency: 3, failIndex: 2 });
  await harness.runner.run({ file: "sample.txt", sampleCount: 8 });
  assert.ok(harness.maxActive <= 3);
  assert.equal(harness.runner.getJob().checked, 8);
  assert.equal(harness.runner.getJob().status, "done");
});
```

- [ ] **Step 8: Run Diagnostics tests and verify RED**

Run: `npm test -- tests/detailed-checker.test.ts`

Expected: FAIL because custom count, injected tester/concurrency, and worker pool do not exist.

- [ ] **Step 9: Implement bounded Diagnostics runner**

Update `createDiagnosticRunner` to accept optional dependencies:

```ts
{
  testProxy?: typeof testProxyDetailed;
  getConcurrency?: () => number;
  persistIntervalMs?: number;
}
```

Use Fisher–Yates sampling, `sampleCount` precedence, 1–100 percent clamp, custom count clamp, and a worker loop bounded by `getConcurrency()`. Continue after individual failures. Publish each result in memory; persist no more often than the configured throttle and always at start/completion. Add `sampleCount` to job state, including backward state normalization. Wire `/api/diagnostics/run` to accept both scope forms.

- [ ] **Step 10: Run focused and full backend verification**

Run:

```bash
npm test -- tests/pool-ranker.test.ts tests/detailed-checker.test.ts
npm test
npx tsc -p tsconfig.server.json --noEmit
```

Expected: all tests PASS and TypeScript exits 0.

- [ ] **Step 11: Commit backend task**

```bash
git add src/lib/types.ts src/server/nine-router-client.ts src/server/checker.ts src/server/pool-ranker.ts src/server/detailed-checker.ts src/server/server.ts tests/pool-ranker.test.ts tests/detailed-checker.test.ts
git commit -m "feat: add proxy lifecycle operations"
```

---

### Task 2: Proxies and Diagnostics Operator UI

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src/app/(dashboard)/proxies/page.tsx`
- Modify: `src/app/(dashboard)/diagnostics/page.tsx`
- Modify: `src/components/proxy-health-badge.tsx`
- Modify: `src/components/dashboard-shell.css`
- Modify: `src/components/diagnostics.css`
- Create: `tests/api-contract.test.ts`

**Interfaces:**
- Consumes Task 1 `PoolRecord`, `RemoteState`, `TestState`, `DiagnosticJob`, and HTTP contracts verbatim.
- Produces typed client helpers:
  - `testPools(password, ids)`
  - `renamePool(password, localId, name)`
  - `removePool(password, localId)`
  - `restorePool(password, localId)`
  - `runDiagnostics(password, { file, samplePercent?, sampleCount? })`

- [ ] **Step 1: Write failing API helper contract tests**

Create `tests/api-contract.test.ts`. Replace `globalThis.fetch` with a tiny recording fake and assert user-observable request contracts:

```ts
test("testPools sends local ids to the lifecycle endpoint", async () => {
  const request = recordFetch({ accepted: ["local-1"], busy: [] });
  await testPools("secret", ["local-1"]);
  assert.equal(request.url, "/api/ninerouter/test");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request.init.body)), { ids: ["local-1"] });
});

test("rename and restore target the encoded local identity", async () => {
  const rename = recordFetch(poolResponse);
  await renamePool("secret", "local/a", "  Edge Paris  ");
  assert.equal(rename.url, "/api/ninerouter/pools/local%2Fa");
  assert.deepEqual(JSON.parse(String(rename.init.body)), { name: "Edge Paris" });

  const restore = recordFetch(poolResponse);
  await restorePool("secret", "local/a");
  assert.equal(restore.url, "/api/ninerouter/pools/local%2Fa/restore");
});

test("diagnostics sends exactly the selected scope", async () => {
  const request = recordFetch({ started: true });
  await runDiagnostics("secret", { file: "sample.txt", sampleCount: 25 });
  assert.deepEqual(JSON.parse(String(request.init.body)), { file: "sample.txt", sampleCount: 25 });
});
```

Also cover DELETE method and API error propagation from `{ error }`.

- [ ] **Step 2: Run API helper tests and verify RED**

Run: `npm test -- tests/api-contract.test.ts`

Expected: FAIL because helpers/signatures do not exist.

- [ ] **Step 3: Implement typed API helpers**

Add only the five helpers in the Interfaces block. Encode `localId`, trim rename input, parse JSON once, and throw the server error text on non-2xx responses. Update existing Diagnostics call sites to the options object.

- [ ] **Step 4: Run API helper tests and verify GREEN**

Run: `npm test -- tests/api-contract.test.ts`

Expected: all API contract tests PASS.

- [ ] **Step 5: Rebuild Proxies operator flow**

Update the page without adding a parallel design system:

- tabs are `Active`, `Reserve`, `Removed`;
- row key and selection use `localId`;
- proxy cell shows name then monospace endpoint;
- remove Speed column;
- add Last checked using existing `formatTime`;
- selection bar has `Test selected` and Clear;
- row action menu uses existing Radix dropdown and lucide icons;
- menu actions: Test now, Rename, Activate/Deactivate, Restore when revived, Retry removal when delete-failed, and destructive Remove when linked;
- render queued/checking/retrying states without disabling unrelated rows;
- poll at 1.2 seconds while sync or any item test is active;
- automatic removal toast copy is exactly `Removed from 9Router; kept locally for recovery`;
- status language matches the spec.

Use existing Radix Dialog for rename and restore. Rename validates trimmed non-empty input and at most 100 Unicode code points. Restore dialog shows name, endpoint, and that restoration starts inactive. Manual removal uses an explicit accessible dialog because it is destructive; no browser-native `confirm`.

- [ ] **Step 6: Rebuild Diagnostics setup and evidence flow**

Keep file upload. Add:

- one setup toolbar containing selected source, 10/30/50/100 percent controls, custom count, Run;
- summary values Scope, Completed, Passed, Failed, Elapsed;
- average rate during run and ETA only after five completed results;
- search across endpoint, exit IP, country, ISP;
- All/Passed/Failed filters;
- select-all successful rows currently visible;
- progressive results from existing polling;
- failed error summary plus native `<details>` disclosure for full error;
- Promote remains limited to selected successful results.

Do not add Diagnostics delete/rename/restore actions.

- [ ] **Step 7: Polish responsive and accessible states**

In existing CSS files:

- preserve dark control-room identity and data density;
- use established semantic tokens, 12 px cards, 8 px controls, 150–250 ms state motion;
- set 44 px minimum hit areas on new controls, menu items, checkboxes, and dialog buttons;
- ensure dropdown portals are not clipped;
- pair state color with icons/text;
- add focus-visible, disabled, loading, empty, error, selected, hover, and active states;
- preserve responsive table-to-card behavior;
- disable new transitions under `prefers-reduced-motion`.

No decorative gradients, nested cards, fake charts, or ornamental motion.

- [ ] **Step 8: Run frontend verification**

Run:

```bash
npm test -- tests/api-contract.test.ts
npm test
npx tsc --noEmit
npm run build
```

Expected: tests PASS, TypeScript exits 0, and Next build succeeds.

- [ ] **Step 9: Run browser smoke and visual inspection**

Start the real app with `npm run dev`. In a browser:

1. Open `/proxies` at desktop width; verify three tabs, name+endpoint rows, no Speed column, action menu, dialogs, and 44 px controls.
2. Trigger one Test now and a selected batch against configured data; observe per-row queued/checking/retrying/final states and unaffected rows remaining interactive.
3. Exercise rename validation and remote error display.
4. With test-double data, observe confirmed-dead removal, Removed tab retention, revived status, and inactive restore confirmation.
5. Open `/diagnostics`; run one percent scope and one custom-count scope; verify progressive counts, filter/search, failed disclosure, and passed-visible selection.
6. Repeat visual inspection at mobile width; verify table cards, toolbars, dialogs, and no horizontal clipping.
7. Verify keyboard focus order, Escape dialog close, Enter rename submit, and reduced-motion behavior.

Capture desktop and mobile screenshots for the reviewer report. Fix all defects found in one batch, then perform one confirmation pass only.

- [ ] **Step 10: Commit frontend task**

```bash
git add src/lib/api.ts src/app/'(dashboard)'/proxies/page.tsx src/app/'(dashboard)'/diagnostics/page.tsx src/components/proxy-health-badge.tsx src/components/dashboard-shell.css src/components/diagnostics.css tests/api-contract.test.ts
git commit -m "feat: improve proxy testing workflows"
```
