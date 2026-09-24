# 9Router Sync Now and Remote Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển full sync sang dùng health check của 9Router, enforce cooldown tự động 6 giờ, track trạng thái remote mỗi 60 giây, tự deactivate/delete proxy fail trước ranking/rename, và bỏ manual pool health-check.

**Architecture:** Giữ `pool-ranker.ts` làm state machine duy nhất cho full sync và remote tracking. `nine-router-client.ts` cung cấp remote pool metadata và test result; `server.ts` chỉ điều phối scheduler/polling và route; local `pool-state.json` giữ lịch sử Removed nhưng `isActiveOnRouter` luôn lấy từ remote truth gần nhất. Nút `Sync now` gọi force sync; startup/scheduled/login paths chỉ chạy full sync khi stale, còn lại track-only.

**Tech Stack:** Node.js >=22, TypeScript/tsx, Node `node:test`, Next 16 custom HTTP server, React 19, existing shadcn/Radix UI.

**Spec:** `docs/superpowers/specs/2026-09-24-ninerouter-sync-now-design.md`

## Global Constraints

- Full automatic sync MUST NOT run more than once per 6 hours; effective minimum `nineRouterSyncMinutes` MUST be `360`.
- Manual `POST /api/ninerouter/sync` MUST be force sync, but duplicate concurrent sync MUST still return `202 { started: false, running: true }`.
- Track-only refresh MUST run at most once per 60 seconds, MUST be deduped, and MUST NOT change `lastSyncAt`.
- 9Router `POST /api/proxy-pools/:id/test` MUST be the only health-check source for the sync path; local `checker.ts` MUST NOT be called by sync.
- Failed remote test MUST deactivate first, then delete; delete `404` is idempotent removal; other delete failures become `delete_failed` and MUST NOT abort other pools.
- Local Removed records MUST be retained; records MUST NOT be silently presented as active after remote deactivation/removal.
- Ranking and rename MUST happen only after failed-pool cleanup; rename order MUST be highest rank down to rank `1`.
- Activation result, not intended tier, controls `isActiveOnRouter` after sync.
- Manual pool health-check route, browser client, and UI actions MUST be removed.
- Backend safety auditor health probes remain independent and unchanged.
- No new dependency; use existing types, API patterns, atomic state writes, and `Promise.withResolvers()` for new event/timer promises.
- Every behavior change MUST get a focused `node:test` regression test before implementation and pass focused tests before commit.

---

## File Map

- Modify `src/lib/types.ts`: add remote test metadata fields.
- Modify `src/server/nine-router-client.ts`: expose typed remote pool metadata and 9Router test result.
- Modify `src/server/pool-ranker.ts`: add deduped `refreshRemoteTracking()` and `startSyncIfStale()`, replace local checker sync lifecycle with 9Router test/deactivate/delete lifecycle, and remove manual test/restore worker paths.
- Modify `src/server/app-config.ts`: default and clamp automatic sync interval to at least `360` minutes.
- Modify `data/settings.json`: persist `nineRouterSyncMinutes: 360`.
- Modify `src/server/server.ts`: force/manual route, stale scheduler, 60-second tracking timer, GET pools stale admission, and removal of manual test/restore routes.
- Modify `src/lib/api.ts`: remove browser `testPools` and `restorePool` clients; preserve force `syncPools` client.
- Modify `src/app/(dashboard)/proxies/page.tsx`: remove manual Test and Restore actions and change sync progress copy to 9Router health check.
- Modify `src/components/right-panel.tsx`: show effective six-hour interval and current remote tracking/sync wording.
- Modify `src/components/sync-progress-strip.tsx`: label check phase `9Router health check`.
- Create `tests/ninerouter-client.test.ts`: verify remote metadata is preserved by `listPools()`.
- Create `tests/app-config.test.ts`: verify the six-hour minimum and larger configured interval.
- Modify `tests/pool-ranker.test.ts`: add tracking and 9Router lifecycle tests; delete obsolete local-check/restore assumptions.
- Modify `tests/sync-lifecycle.test.ts`: replace `checkProxy` fixtures with `testPool`, assert cleanup before ranking/rename.
- Modify `tests/pool-ranker-lifecycle.test.ts`: remove manual local checker/restore tests; keep rename/remove/activation/conflict coverage.
- Modify `tests/api-contract.test.ts`: remove `/api/ninerouter/test` and restore client contracts; add force sync client contract.
- Modify `README.md`: replace native pool checker, top-50, manual test/recheck/restore, and one-hour sync documentation with approved 9Router flow.

---

### Task 1: Add remote metadata contracts and enforce six-hour automatic minimum

**Files:**
- Modify: `src/lib/types.ts:35-54`
- Modify: `src/server/nine-router-client.ts:125-145`
- Modify: `src/server/app-config.ts:65-103`
- Modify: `data/settings.json:7`
- Create: `tests/ninerouter-client.test.ts`
- Create: `tests/app-config.test.ts`

**Interfaces:**
- Produce `NineRouterPool` with `id`, `name`, `proxyUrl`, optional `type`, `isActive`, `testStatus`, `lastError`, and `lastTestedAt`.
- Preserve `NineRouterTestResult` and change `testPool(id): Promise<NineRouterTestResult>` so a non-2xx response with boolean `ok` returns the structured body instead of throwing.
- Add optional `PoolRecord.remoteTestStatus`, `remoteLastError`, and `remoteLastTestedAt`.

- [ ] **Step 1: Write failing metadata and config tests**
Add `tests/ninerouter-client.test.ts` with a fetch stub covering both list metadata and test failure semantics:

```ts
const remote = {
  id: "remote-1",
  name: "1",
  proxyUrl: "http://127.0.0.1:8080",
  type: "http",
  isActive: false,
  testStatus: "failed",
  lastError: "timeout",
  lastTestedAt: "2026-09-24T09:00:00.000Z",
};
assert.equal((await listPools())[0].isActive, false);

const failed = await testPool("remote-1"); // stub returns HTTP 500 + { ok: false, error: "timeout" }
assert.deepEqual(failed, { ok: false, error: "timeout" });
```

Add `tests/app-config.test.ts` assertions through the existing public API. Use `updateSettings({ nineRouterSyncMinutes: 60 })` after `initAppConfig()`, then assert:

```ts
assert.equal(getSettingsSecrets().nineRouterSyncMinutes, 360);
```

Also assert `updateSettings({ nineRouterSyncMinutes: 720 })` keeps `720`, and restore the original setting in a `try/finally` block so the repository settings file is unchanged after the test.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test tests/ninerouter-client.test.ts tests/app-config.test.ts
```

Expected: FAIL because remote metadata is not represented by `listPools` and values below 360 are currently accepted.

- [ ] **Step 3: Implement the smallest contract/config change**

Change the client response type to:

```ts
export interface NineRouterPool {
  id: string;
  name: string;
  proxyUrl: string;
  type?: string;
  isActive?: boolean;
  testStatus?: string | null;
  lastError?: string | null;
  lastTestedAt?: string | null;
}
```

Return all remote metadata from `listPools()`. Add a private request option such as `{ acceptStructuredError: true }` used only by `testPool`; after JSON parsing, return non-2xx body when `typeof body.ok === "boolean"`, otherwise preserve the existing thrown API error. Change config default from `60` to `360`, normalization from `clamp(..., 1, 1440)` to `clamp(..., 360, 1440)`, and `data/settings.json` to `360`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```sh
node --import tsx --test tests/ninerouter-client.test.ts tests/app-config.test.ts
npm run typecheck
```

Expected: PASS and no TypeScript diagnostics.

- [ ] **Step 5: Commit**

```sh
git add src/lib/types.ts src/server/nine-router-client.ts src/server/app-config.ts data/settings.json tests/ninerouter-client.test.ts tests/app-config.test.ts
git commit -m "feat: add 9router metadata and six-hour sync minimum"
```

---

### Task 2: Implement deduped track-only remote refresh

**Files:**
- Modify: `src/server/pool-ranker.ts:28-53,107-220,845-859`
- Modify: `src/lib/types.ts:35-54`
- Test: `tests/pool-ranker.test.ts`

**Interfaces:**
- Consume `deps.listPools(): Promise<NineRouterPool[]>`.
- Produce `refreshRemoteTracking(): Promise<{ refreshed: boolean; skipped: boolean; error?: string }>`.
- Produce `startSyncIfStale(): Promise<{ started: boolean; running: boolean; stale?: boolean; tracked?: boolean }>` in Task 3; Task 2 only prepares tracking internals.
- Track-only MUST not call `testPool`, `checkProxy`, `setPoolActive`, `deletePool`, or `updatePool`.

- [ ] **Step 1: Write failing track-only tests**

Extend the test harness with remote metadata and call counters:

```ts
let listCalls = 0;
let testCalls = 0;
let deleteCalls = 0;
let updateCalls = 0;
const ranker = createPoolRanker({ dataDir }, {
  listPools: async () => {
    listCalls++;
    return [{ id: "remote-1", name: "1", proxyUrl: "http://127.0.0.1:8080", type: "http", isActive: false, testStatus: "failed", lastError: "timeout", lastTestedAt: "2026-09-24T09:00:00.000Z" }];
  },
  testPool: async () => { testCalls++; return { ok: false }; },
  deletePool: async () => { deleteCalls++; },
  updatePool: async () => { updateCalls++; return {}; },
});
const before = ranker.readState().lastSyncAt;
await ranker.refreshRemoteTracking();
const pool = ranker.readState().pools["local-1"];
assert.equal(pool.isActiveOnRouter, false);
assert.equal(pool.tier, "reserve");
assert.equal(pool.remoteTestStatus, "failed");
assert.equal(pool.remoteLastError, "timeout");
assert.equal(ranker.readState().lastSyncAt, before);
assert.equal(testCalls, 0);
assert.equal(deleteCalls, 0);
assert.equal(updateCalls, 0);
```

Add a missing-remote test asserting `remoteId === null`, `remoteState === "removed"`, `tier === "removed"`. Add a dedupe test calling `refreshRemoteTracking()` twice inside 60 seconds and asserting one `listPools` call. Add a concurrent test using a gate made with `Promise.withResolvers<void>()` and assert concurrent calls share one remote request.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test --test-name-pattern "track|remote|refresh" tests/pool-ranker.test.ts
```

Expected: FAIL because `refreshRemoteTracking` and metadata reconciliation do not exist.

- [ ] **Step 3: Implement atomic reconciliation and a 60-second dedupe lock**

Add a process-local `lastRemoteRefreshAt` and `refreshPromise` inside `createPoolRanker`. Implement:

```ts
async function refreshRemoteTracking(): Promise<{ refreshed: boolean; skipped: boolean; error?: string }> {
  if (refreshPromise) return refreshPromise;
  if (Date.now() - lastRemoteRefreshAt < 60_000) return { refreshed: false, skipped: true };
  refreshPromise = refreshRemoteTrackingInternal();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}
```
Use `writeState` once after reconciling the full response. Match by remote ID, then parsed endpoint. Copy `isActive` only when it is boolean: true sets linked tier to `active`; false sets linked active tier to `reserve`. Map ISO `lastTestedAt` to epoch milliseconds when valid and copy `testStatus`/`lastError`. Mark missing `linked` records removed. Preserve `lastSyncAt`, latency, and operational status. Do not use remote `testStatus` to set local operational status during track-only. Skip immediately while `syncing === true`. On list failure, preserve state, log a throttled error, and return `{ refreshed: false, skipped: false, error }`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```sh
node --import tsx --test --test-name-pattern "track|remote|refresh" tests/pool-ranker.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/server/pool-ranker.ts src/lib/types.ts tests/pool-ranker.test.ts
git commit -m "feat: track 9router remote state without health checks"
```

---

### Task 3: Replace full sync health lifecycle with 9Router test/deactivate/delete

**Files:**
- Modify: `src/server/pool-ranker.ts:6-46,222-546,845-859`
- Test: `tests/sync-lifecycle.test.ts`
- Test: `tests/pool-ranker.test.ts`

**Interfaces:**
- Add `testPool: typeof defaultTestPool` to `PoolRankerDeps` and `defaultDeps`.
- Consume `NineRouterTestResult` from `deps.testPool(remoteId)`.
- Preserve `syncPools(options?: { force?: boolean })`; `force: true` bypasses cooldown and `force: false` enforces it.
- Produce `startSyncIfStale(): Promise<{ started: boolean; running: boolean; stale: boolean; tracked: boolean }>`.
- `startSyncIfStale()` uses the newer of persisted `lastSyncAt` and process-local `lastAutoSyncAttemptAt`; when locked it returns running, when recent it awaits `refreshRemoteTracking()`, and when stale it sets `lastAutoSyncAttemptAt`, starts `syncPools({ force: false })` without awaiting completion, and returns started.
- `executeSingleCheckAndLifecycle` and `checkProxy` MUST no longer be used by full sync or manual pool tests.

- [ ] **Step 1: Rewrite existing sync tests as failing 9Router tests**

Replace local checker fixture with remote test fixture:

```ts
const testCalls: string[] = [];
const deactivated: string[] = [];
const deletedRemotes: string[] = [];
const remoteTests = new Map([
  ["remote-local-a", { ok: false, error: "Proxy test timed out", elapsedMs: 6000 }],
]);

const ranker = createPoolRanker({ dataDir }, {
  listPools: async () => [{ id: "remote-local-a", name: poolA.name, proxyUrl: poolA.proxyUrl, type: "http", isActive: true }],
  testPool: async (id) => { testCalls.push(id); return remoteTests.get(id)!; },
  setPoolActive: async (id, isActive) => { if (!isActive) deactivated.push(id); return {}; },
  deletePool: async (id) => { deletedRemotes.push(id); },
  bulkSetActive: async () => [],
  checkProxy: async () => { throw new Error("local checker must not be called"); },
});
```

Assert `testCalls` contains the remote ID, `deactivated` occurs before `deletedRemotes`, and the explicit `{ ok: false }` record is Removed. Add a thrown `testPool` case asserting no deactivate/delete call, record remains linked, and it is absent from activation/rename for this run. Add a success test with 3 `elapsedMs` values and assert rank order plus activation. Add a test where delete fails for one explicit-fail proxy and two healthy proxies still get ranked/renamed. Add a stale-admission test where the started full sync fails; a second `startSyncIfStale()` in the same process MUST not start another full sync before six hours, while `syncPools({ force: true })` still starts.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test --test-name-pattern "sync|health|rename|delete" tests/sync-lifecycle.test.ts tests/pool-ranker.test.ts
```

Expected: FAIL because full sync currently calls `checkProxy`, retries local checks, and deletes without a preceding deactivation.

- [ ] **Step 3: Implement the 9Router-only test lifecycle**

Add `testPool` dependency. For each fetched eligible pool, call `testPool(remoteId)` once; use `elapsedMs` as latency and `testedAt` as checked timestamp. Add successful IDs to a `verifiedSurvivorIds` set. On explicit `ok === false`:

```ts
await deps.setPoolActive(remoteId, false).catch((error) => recordRemoteError(error));
try {
  await deps.deletePool(remoteId);
  markRemoved(localId);
} catch (error) {
  if ((error as { status?: number }).status === 404) markRemoved(localId);
  else markDeleteFailed(localId, error);
}
```

On thrown `testPool`, record the infrastructure error and leave remote identity/activity untouched; do not add it to `verifiedSurvivorIds`. Always attempt delete after deactivation failure only for explicit `ok === false`. Keep per-pool errors isolated. Remove retry and all `checkProxy` calls from `syncPools`. Keep `checkConcurrency` for the 9Router test worker count. Persist failed-pool lifecycle before ranking. Rank/activate/rename only `verifiedSurvivorIds`. Do not use old background `testPools` recheck after sync.

- [ ] **Step 4: Implement cooldown and non-blocking stale admission**

At the start of `syncPools`, after duplicate-lock/config checks but before `syncing = true`, enforce cooldown when `force !== true`:

```ts
const intervalMs = Math.max(360, getSettingsSecrets().nineRouterSyncMinutes) * 60_000;
const lastSyncAt = readState().lastSyncAt;
if (typeof lastSyncAt === "number" && Date.now() - lastSyncAt < intervalMs) {
  await refreshRemoteTracking();
  return { started: false, running: false, stale: false, tracked: true };
}
```

Implement `startSyncIfStale()` using the same interval calculation and `const automaticReference = Math.max(lastSyncAt ?? 0, lastAutoSyncAttemptAt ?? 0)`. Immediately before starting an admitted automatic sync, set `lastAutoSyncAttemptAt = Date.now()`. Call `syncPools({ force: false })` without awaiting the full run, attach a `.catch()` that logs the failure, and return `started: true` immediately. Calling `syncPools` sets `syncing = true` before its first remote await, preventing two stale admissions in the same event-loop turn. Set persisted `lastSyncAt` only after successful full-sync completion; failed full sync preserves the previous timestamp. Force sync ignores `lastAutoSyncAttemptAt`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```sh
node --import tsx --test tests/sync-lifecycle.test.ts tests/pool-ranker.test.ts tests/pool-ranker-lifecycle.test.ts
npm run typecheck
```

Expected: all updated lifecycle tests pass; no local checker invocation remains in full sync.

- [ ] **Step 6: Commit**

```sh
git add src/server/pool-ranker.ts src/lib/types.ts tests/sync-lifecycle.test.ts tests/pool-ranker.test.ts tests/pool-ranker-lifecycle.test.ts
git commit -m "feat: make sync use 9router health lifecycle"
```

---

### Task 4: Make activation truth and rename ordering remote-correct

**Files:**
- Modify: `src/server/pool-ranker.ts:191-220,461-509`
- Test: `tests/sync-lifecycle.test.ts`
- Test: `tests/pool-ranker.test.ts`

**Interfaces:**
- `assignTiers` computes requested active/reserve membership but final persistence reconciles against each remote update result.
- Full sync activation persistence consumes `bulkSetActive` per-item `{ id, isActive, ok, error? }`.
- On success, both `isActiveOnRouter` and tier use the requested value. On failure, both stay aligned to prior remote truth: prior true means `active`, otherwise `reserve`.
- [ ] **Step 1: Write failing activation truth and ordering tests**

Use a fake bulk response:

```ts
bulkSetActive: async (items) => items.map((item) =>
  item.id === "remote-b"
    ? { ...item, ok: false, error: "remote update refused" }
    : { ...item, ok: true }
)
```

After sync assert:

```ts
assert.equal(state.pools["local-b"].isActiveOnRouter, false);
assert.equal(state.pools["local-b"].tier, "reserve");
assert.match(state.pools["local-b"].last_error ?? "", /remote update refused/);
assert.deepEqual(renameCalls, [
  { id: "remote-c", name: "3" },
  { id: "remote-b", name: "2" },
  { id: "remote-a", name: "1" },
]);
```

- [ ] **Step 2: Run test and verify failure**

Run:

```sh
node --import tsx --test --test-name-pattern "activation|rename" tests/sync-lifecycle.test.ts
```

Expected: FAIL because current code sets `isActiveOnRouter` from intended tier before checking activation results.

- [ ] **Step 3: Persist per-item remote activation result**

Build a map from activation results. For each linked pool:

```ts
const result = activationById.get(pool.remoteId!);
if (result?.ok) {
  pool.isActiveOnRouter = result.isActive;
  pool.tier = result.isActive ? "active" : "reserve";
} else if (result) {
  pool.tier = pool.isActiveOnRouter ? "active" : "reserve";
  pool.last_error = result.error || "Activation update failed";
}
```

Do not persist intended tier as active when 9Router rejected activation. Compute stats after this reconciliation.

- [ ] **Step 4: Keep rename after cleanup/activation and highest-to-one order**

Use the ranked survivor list after failed pools are removed. Iterate from `ranked.length - 1` down to `0`. Skip only when current name already equals target. Catch each rename error, log it, and continue.

- [ ] **Step 5: Run focused tests and commit**

Run:

```sh
node --import tsx --test --test-name-pattern "activation|rename" tests/sync-lifecycle.test.ts
npm run typecheck
```

Then commit:

```sh
git add src/server/pool-ranker.ts tests/sync-lifecycle.test.ts tests/pool-ranker.test.ts
 git commit -m "fix: persist 9router activation truth before rename"
```

---

### Task 5: Wire server scheduler, login-time tracking, and remove manual recovery routes

**Files:**
- Modify: `src/server/server.ts:89-226,424-466,468-525`
- Modify: `src/lib/api.ts:69-135`
- Modify: `tests/api-contract.test.ts`
- Test: `tests/pool-ranker.test.ts`

**Interfaces:**
- `POST /api/ninerouter/sync` calls `poolRanker.syncPools({ force: true })` and still returns `202` immediately.
- `GET /api/ninerouter/pools` calls `await poolRanker.startSyncIfStale()` before reading state; stale login starts full sync, recent login performs track-only, and running sync is only observed.
- Server owns a 60-second `setInterval` for `poolRanker.refreshRemoteTracking()` after server startup.
- Delete `POST /api/ninerouter/test`, `POST /api/ninerouter/pools/:id/restore`, browser `testPools`, and browser `restorePool`.
- [ ] **Step 1: Write failing client and stale-admission tests**

In `tests/api-contract.test.ts`, remove the obsolete test/restore imports and tests. Add a `syncPools("secret")` test asserting `POST /api/ninerouter/sync`, authenticated headers, and returned `{ started: true }`. In `tests/pool-ranker.test.ts`, use a recent `lastSyncAt` to assert `startSyncIfStale()` calls list tracking but not `testPool`; use stale `lastSyncAt` to assert it returns `started: true` and the full-sync test gate is entered once.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test --test-name-pattern "sync|stale|tracking" tests/api-contract.test.ts tests/pool-ranker.test.ts
```

Expected: FAIL because `startSyncIfStale` is not wired into the server and obsolete browser test/restore contracts still exist.
- [ ] **Step 3: Wire force sync and GET tracking**

Change the route to:

```ts
if (request.method === "POST" && pathname === "/api/ninerouter/sync") {
  if (poolRanker.isSyncing()) return json(response, { started: false, running: true }, 202);
  poolRanker.syncPools({ force: true }).catch((error) => {
    const message = (error as Error).message;
    logActivity("error", `Sync failed: ${message}`);
    console.error("9Router sync failed:", message);
  });
  return json(response, { started: true, force: true }, 202);
}
```

At the beginning of the GET pools branch, await `poolRanker.startSyncIfStale()`; do not call `refreshRemoteTracking()` directly there because `startSyncIfStale()` decides stale full sync versus recent track-only. Delete the `/api/ninerouter/test` handler and the `/api/ninerouter/pools/:id/restore` action. Remove `testPools` and `restorePool` from `src/lib/api.ts`.

- [ ] **Step 4: Wire 60-second background tracking and stale scheduler**

Add a `remoteTrackingIntervalId` beside `syncIntervalId`. Start it after `app.prepare()`/server readiness:

```ts
const remoteTrackingIntervalId = setInterval(() => {
  void poolRanker.refreshRemoteTracking();
}, 60_000);
```

Keep automatic `runScheduledSync` as `poolRanker.startSyncIfStale()`, not a direct `syncPools({ force: false })` call. Its ranker method decides stale full sync versus recent track-only, so startup, login, and timer cannot bypass the six-hour floor. Schedule remaining time after a recent `lastSyncAt`. Do not create a second login-specific full-sync trigger; the first authenticated GET pools performs the same stale admission.

- [ ] **Step 5: Run tests, typecheck, and commit**

Run:

```sh
node --import tsx --test --test-name-pattern "sync|stale|tracking" tests/api-contract.test.ts tests/pool-ranker.test.ts
npm run typecheck
```

Commit:

```sh
git add src/server/server.ts src/lib/api.ts tests/api-contract.test.ts tests/pool-ranker.test.ts
git commit -m "feat: wire force sync and remote tracking scheduler"
```

---

### Task 6: Remove manual health-check/recovery UI and update sync copy

**Files:**
- Modify: `src/app/(dashboard)/proxies/page.tsx:130-230,274-290,540-575,780-790,900-945,1100-1145`
- Modify: `src/components/right-panel.tsx:390-410`
- Modify: `src/components/sync-progress-strip.tsx:11-16`
- Test: visual smoke on `/proxies`

**Interfaces:**
- `handleSync` remains the only pool health operation in the page and calls force `syncPools(password)`.
- No `handleTestSingle`, `handleTestBatch`, `openRestore`, `submitRestore`, `Test selected`, row/context-menu `Test`, row/context-menu `Restore proxy`, or restore dialog remains.
- `anyItemTesting` no longer controls polling because manual test queue no longer exists; polling uses `status.running` and normal refresh interval.

- [ ] **Step 1: Remove manual test and restore actions**

Delete imports, state, and functions used only by `testPools` or `restorePool`. Remove dropdown/context menu test and restore items, `Test selected`, and restore dialog. Retain selection only for actions that still consume `selectedIds`; if no action consumes it after removal, delete selection controls/state as dead UI.
- [ ] **Step 2: Update sync progress and interval wording**

Change progress copy to:

```ts
if (phase === "check" && total > 0) label = `9Router health check ${done}/${total}`;
```

Show the effective `syncIntervalMinutes` in the right panel. Update page subtitle/toast to state that tests run on 9Router and failed pools are deactivated/deleted before ranking.

- [ ] **Step 3: Run typecheck and visual smoke**

Run:

```sh
npm run typecheck
npm run build
```

Start the app with the existing dev command, open `/proxies`, and verify:

1. `Sync now` is present and starts a force sync.
2. No `Test`, `Test selected`, or `Restore proxy` action/dialog is visible.
3. During sync, progress says `9Router health check`.
4. A locally Removed pool with remote `isActive: false` is not shown in Active.

- [ ] **Step 4: Commit**

```sh
git add "src/app/(dashboard)/proxies/page.tsx" src/components/right-panel.tsx src/components/sync-progress-strip.tsx
 git commit -m "feat: remove manual proxy health-check controls"
```

### Task 7: Remove obsolete local-check/restore lifecycle and update documentation

**Files:**
- Modify: `src/server/pool-ranker.ts:222-327,693-779,845-859`
- Modify: `tests/pool-ranker.test.ts`
- Modify: `tests/pool-ranker-lifecycle.test.ts`
- Modify: `README.md:1-78`
- Test: full existing suite

**Interfaces:**
- `createPoolRanker` public return keeps `syncPools`, `startSyncIfStale`, `refreshRemoteTracking`, `listByTier`, `getStatus`, `activatePool`, `readState`, `isSyncing`, `getMetrics`, `renamePool`, `removePool`, and existing diagnostic promotion APIs.
- `testPools` and `restorePool` are removed from the ranker public return and no caller remains.
- `checkProxy`/`checkMany` remain available to independent checker/auditor code but are not dependencies of pool-ranker sync.

- [ ] **Step 1: Remove known obsolete symbols and callers**

Delete `executeSingleCheckAndLifecycle`, `scheduleBackgroundBatch`, `testPools`, `restorePool`, their imports/dependencies, and their return-object properties from `pool-ranker.ts`. Delete only pool-ranker/manual pool-test code; keep `checker.ts`, detailed diagnostics, and auditor paths intact. Re-run repository search for `testPools`, `restorePool`, `executeSingleCheckAndLifecycle`, `scheduleBackgroundBatch`, and `/api/ninerouter/test`; expected remaining matches are zero except unrelated generic names outside this 9Router pool lifecycle.

- [ ] **Step 2: Update lifecycle tests**

Remove tests that assert local retry, revived, restore, and manual test-queue behavior. Retain tests for rename, manual remove, activation, unknown IDs for remaining actions, legacy normalization, and conflict handling. Full sync tests in `tests/sync-lifecycle.test.ts` now own failed-pool cleanup coverage.

- [ ] **Step 3: Update README operational behavior**

Document:

```text
Automatic 9Router sync runs no more than once every 6 hours.
Dashboard login/open and a 60-second backend tracker reconcile remote active/test metadata.
Sync now forces a 9Router health-check pass, deactivates and deletes failed remote pools, then ranks and renames survivors.
Removed pools remain locally visible as read-only history in Removed; manual restore is no longer available.
```

Replace README values `top 50` with `top 20`, `NINEROUTER_SYNC_MINUTES=60` with `360`, remove manual test/retry/recheck/restore claims, and do not claim that local TCP checker audits 9Router pool health.

- [ ] **Step 4: Run complete verification**

Run:

```sh
npm run typecheck
npm test
npm run build
```

Expected: all tests pass, build succeeds, and no manual pool health-check caller remains. A real smoke may call only `GET /api/ninerouter/pools`; do not run destructive production delete tests.

- [ ] **Step 5: Commit**

```sh
git add src/server/pool-ranker.ts tests/pool-ranker.test.ts tests/pool-ranker-lifecycle.test.ts README.md
git commit -m "chore: remove obsolete local pool lifecycle"
```

---

## Final Verification Matrix

| Requirement | Proof |
|---|---|
| Six-hour automatic cooldown | config test + recent/stale admission tests |
| Force Sync now | browser API contract + ranker force test |
| 60-second continuous tracking | track-only dedupe/concurrency test + server smoke |
| Remote active truth | metadata/tier reconciliation test + UI smoke |
| No local health check in sync | injected `checkProxy` throws; sync still passes |
| Deactivate then delete | ordered call assertions |
| Delete 404/idempotency | lifecycle regression test |
| Continue after one failed delete | survivor ranking/rename test |
| Rank after cleanup | call-order assertions |
| Rename highest rank to 1 | exact rename sequence assertion |
| Activation truth from remote result | failed activation state assertion |
| Removed history retained | missing/fail pool remains in `tier: removed` |
| Manual health-check/restore removed | client/UI search + server smoke |
| Existing backend audit preserved | full test suite and unchanged auditor tests |
