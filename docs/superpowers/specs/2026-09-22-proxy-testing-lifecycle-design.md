# Proxy Testing and Lifecycle Design

## Summary

Improve proxy testing on Proxies and Diagnostics while adding safe lifecycle operations for 9Router pools. A proxy confirmed dead is deleted from 9Router but retained in the app's local registry. Removed proxies are rechecked after the main sync and may be restored manually when they recover. Operators can rename proxies consistently across the app and 9Router.

## Goals

- Make per-proxy and batch health checks real, observable, and efficient.
- Avoid false deletion by requiring two consecutive failures against the same health-check target.
- Delete confirmed-dead pools from 9Router while preserving local identity, history, and endpoint data.
- Detect recovered proxies without slowing the primary sync and ranking flow.
- Let operators restore recovered proxies to 9Router deliberately.
- Keep proxy names synchronized between the app and 9Router.
- Make Diagnostics faster and more useful through configurable scope, bounded concurrency, filtering, and progressive results.
- Remove misleading metrics and make all UI states operationally clear.

## Non-goals

- Diagnostics will not delete or modify failed pools in 9Router.
- Removed proxies will not be restored automatically.
- Recovered proxies will not be activated automatically during restore.
- No WebSocket or Server-Sent Events transport will be added.
- No new database or persistence dependency will be introduced.
- This change does not measure proxy throughput. Latency must not be presented as Mbps.

## Current Problems

- The Proxies row refresh action reloads page data but does not test the selected proxy.
- A single health-check failure currently classifies a proxy as dead.
- Sync deactivates dead pools but cannot delete them from 9Router or preserve a deliberate removed/recovery lifecycle.
- Pool identity assumes the local ID and 9Router ID are always the same.
- The Proxies table omits the pool name and displays a derived "Speed" value calculated from latency; that value is not a throughput measurement.
- Diagnostics always tests 30 percent, runs sequentially, samples by random sort, and rewrites the complete job file after every result.
- Diagnostics results lack practical search and status filtering.

## Architecture

### Local Registry

Extend `data/pool-state.json` from a sync snapshot into the durable local proxy registry. Continue using atomic temp-file replacement; do not add SQLite or a repository abstraction.

Each proxy record has stable local identity and optional remote identity:

```ts
type RemoteState = "linked" | "removed" | "revived" | "delete_failed";
type TestState = "idle" | "queued" | "checking" | "retrying";

interface PoolRecord {
  localId: string;
  remoteId: string | null;
  name: string;
  proxyUrl: string;
  type: string;
  remoteState: RemoteState;
  testState: TestState;
  status: "usable" | "dead";
  tier: "active" | "reserve" | "dead";
  healthStatus?: "pending" | "checking" | "done";
  latency_ms: number | null;
  exit_ip: string | null;
  checked_at: number;
  isActiveOnRouter: boolean;
  successes: number;
  failures: number;
  firstFailure?: string;
  last_error?: string;
}
```

`localId` is the identity used by UI and app APIs. `remoteId` is the current 9Router pool ID and becomes `null` after remote deletion. Existing `id` references are migrated to `localId`; no permanent duplicate alias remains after callers are updated.

### Backward-compatible State Read

When reading an old record without lifecycle fields:

- set `localId` to its existing `id`;
- set `remoteId` to its existing `id`;
- set `remoteState` to `linked`;
- set `testState` to `idle`.

The normalized form is persisted on the next state write. No standalone migration script is required.

### Reconciliation During Sync

1. Fetch pools from 9Router.
2. Match remote pools to local records by `remoteId`.
3. If no remote ID match exists, fallback to the normalized proxy endpoint.
4. Update matched linked records with current remote data.
5. Add genuinely new remote pools to the registry.
6. Preserve `removed`, `revived`, and `delete_failed` records that are absent remotely.
7. If a removed endpoint reappears remotely, reconcile it to the existing local record instead of creating a duplicate.

## Proxy Lifecycle

### Linked

A `linked` record exists in 9Router. It may be active, reserve, or dead according to current checks and ranking.

### Confirmed Dead and Removed

A linked proxy is only considered confirmed dead after:

1. its initial health check fails;
2. an immediate retry against the same `api.ipify.org` check also fails.

After the second failure:

1. call the 9Router DELETE endpoint;
2. on success, or remote HTTP 404, set `remoteId` to `null`;
3. set `remoteState` to `removed`;
4. keep its local name, endpoint, counters, timestamps, and errors;
5. set `isActiveOnRouter` to `false` and `tier` to `dead`.

A 404 means the desired remote state already exists and is treated as successful deletion.

If remote deletion fails for another reason, retain `remoteId`, set `remoteState` to `delete_failed`, and expose the error. The app must not claim the pool was removed.

### Recheck and Revival

Removed proxies are rechecked by a separate background job after the primary sync, ranking, and 9Router activation updates complete. This job must not delay the sync completion response or sync progress.

Operators may also select removed proxies and use `Test selected`, or test one proxy with `Test now`.

- A successful removed-proxy check sets `remoteState` to `revived`.
- A failed check keeps it `removed` and updates history.
- Revival does not create or activate a 9Router pool.

### Restore

Only a `revived` record may be restored through the primary UI action.

1. Re-list 9Router pools before creation.
2. If the normalized endpoint already exists, reconcile the local record to that remote pool instead of creating a duplicate.
3. Otherwise create a pool using the local name, proxy URL, type, and `isActive: false`.
4. Store the returned remote ID.
5. Set `remoteState` to `linked`, `tier` to `reserve`, and `isActiveOnRouter` to `false`.

A later sync and ranking pass decides whether the restored proxy becomes active.

### Manual Delete

A linked record may be manually removed from 9Router through an explicit destructive action. It follows the same remote-first behavior and local `removed` transition as automatic confirmed-dead deletion. This action is secondary to automatic dead removal and exists for operational recovery.

## Rename

Rename keeps the local name and 9Router name consistent.

- Trim whitespace.
- Reject empty names.
- Limit names to 100 Unicode code points in both server and UI validation.
- For `linked` and `delete_failed` records, update 9Router first. Update local state only after remote success.
- If remote rename returns 404, refresh/reconcile the record and return a conflict; do not update the local name.
- For `removed` and `revived` records, update local state only. This name is used during restore.

## Health-check Execution

### Single and Batch Tests

The Proxies page supports:

- `Test now` for one row;
- checkbox selection plus `Test selected` for multiple rows;
- existing `Sync & rank` for the full linked pool.

Batch execution uses the existing `checkConcurrency` setting. Each item proceeds independently through:

```text
queued -> checking -> retrying (only after failure) -> usable/dead/removed
```

One item failure does not fail the whole batch. Results publish incrementally. The server maintains an in-memory set of local IDs currently being checked so sync, manual tests, and removed-proxy background rechecks cannot test the same endpoint concurrently. Duplicate requests report the item as busy rather than starting another socket flow.

### Counters

A check attempt updates historical counters per completed health-check attempt:

- first attempt success: increment successes once;
- first failure followed by retry success: increment failures once and successes once; retain the first error as `firstFailure` for transient-failure visibility;
- both attempts fail: increment failures twice and retain the retry error as `last_error`.

Ranking uses the final result of the current check and accumulated history as its tie-breaker, preserving current behavior.

## 9Router Client

Add only the CRUD operations required by lifecycle actions:

```ts
updatePool(id, { name?, isActive? })
deletePool(id)
createPool({ name, proxyUrl, type, isActive: false })
```

Reuse the existing authenticated `request` function and 401 retry behavior. Do not add a generic client abstraction beyond these operations.

## App API

### Test Proxies

`POST /api/ninerouter/test`

Request:

```json
{ "ids": ["local-id"] }
```

Behavior:

- accepts unique local IDs only;
- rejects an empty list and unknown IDs;
- starts a bounded background batch;
- skips IDs already in progress and reports them as busy;
- returns HTTP 202 with accepted/busy item IDs.

Polling the existing pools endpoint exposes per-item `testState` and results.

### Rename Proxy

`PATCH /api/ninerouter/pools/:localId`

Request:

```json
{ "name": "New pool name" }
```

Returns the updated local record. Validation errors use HTTP 400, missing local records use 404, and remote conflicts use 409 or 502 as appropriate.

### Remove Proxy

`DELETE /api/ninerouter/pools/:localId`

Deletes remotely when linked and preserves the local record. Returns the transitioned record. A remote 404 is successful and idempotent.

### Restore Proxy

`POST /api/ninerouter/pools/:localId/restore`

Only accepts a `revived` record. Returns the reconciled or newly created linked record. Invalid lifecycle state uses HTTP 409.

### Diagnostics Run

`POST /api/diagnostics/run`

Request accepts exactly one scope form:

```json
{ "file": "list.txt", "samplePercent": 30 }
```

or:

```json
{ "file": "list.txt", "sampleCount": 200 }
```

Rules:

- percent is restricted to 10, 30, 50, or 100 from the UI and clamped to 1–100 server-side;
- count is clamped to 1–eligible endpoint count;
- `sampleCount` takes precedence if both are present;
- an empty source creates a completed zero-result job rather than starting workers.

## Diagnostics Execution

- Retain uploaded `.txt` files as the only Diagnostics source.
- Replace random sorting with an in-place Fisher–Yates shuffle, then take the requested prefix.
- Run detailed checks with at most `checkConcurrency` workers.
- Keep each result independent; a failed proxy does not terminate the job.
- Failed Diagnostics results never modify 9Router.
- Publish in-memory results immediately for polling.
- Persist the job at a throttled interval and once at completion instead of rewriting the full file after each result.
- Preserve the latest 500 result cap unless the selected scope is smaller.

Diagnostics summary derives:

- eligible endpoint count;
- selected scope count;
- completed count;
- passed and failed counts;
- elapsed time;
- average completion rate;
- estimated remaining time after enough observations exist for a stable estimate.

## Proxies UI/UX

### Navigation and Table

Use tabs:

- `Active`
- `Reserve`
- `Removed`

The Removed tab includes `removed`, `revived`, and `delete_failed` records.

The Proxy cell displays the pool name prominently and the proxy URL in monospace beneath it. Remove the current Speed column because inverse latency is not throughput. Keep:

- Proxy
- Latency
- Uptime
- Health
- Last checked
- Actions

### Actions

Use a compact row action menu:

- Test now
- Rename
- Activate or Deactivate when linked
- Restore to 9Router when revived
- Retry removal when `delete_failed`
- Remove from 9Router as a secondary destructive action when linked

Selection bar actions include `Test selected` and `Clear selection`. Batch state updates individual rows; unrelated rows remain usable.

### Status Communication

Per-row labels include icon and text:

- Queued
- Checking
- Retrying
- Healthy
- Dead
- Offline · removed from 9Router
- Revived · ready to restore
- Removal failed · retry delete

After automatic deletion, show: `Removed from 9Router; kept locally for recovery`.

### Dialogs

Rename uses an accessible dialog with current name, inline validation, Enter to save, and Escape to cancel.

Restore uses a confirmation dialog showing name and endpoint and stating that the new 9Router pool starts inactive. Browser-native `confirm` is not used.

All interactive targets are at least 44 px where practical. Color is paired with text or icons. Existing reduced-motion support remains effective for new states.

## Diagnostics UI/UX

- Consolidate file, scope, and Run controls into one setup toolbar.
- Offer 10, 30, 50, and 100 percent plus a custom count input.
- Show summary metrics for Scope, Completed, Passed, Failed, and Elapsed.
- During a run show checked/total, average rate, and ETA only after sufficient completed samples.
- Add search across endpoint, exit IP, country, and ISP.
- Add `All`, `Passed`, and `Failed` filters.
- Add select-all for successful results currently visible under search/filter.
- Keep Promote limited to successful selected results.
- Show failed-result error summaries inline with an expandable detail region.
- Render results progressively while workers continue.
- Preserve responsive card-row behavior on narrow screens.

## Error Handling

- Invalid IDs, names, files, or scope values return actionable 4xx errors.
- A busy proxy is reported per item and does not fail the batch.
- A 9Router DELETE 404 is an idempotent success.
- A rename 404 triggers reconciliation and leaves the local name unchanged.
- A restore endpoint collision reconciles instead of creating a duplicate.
- Remote mutation failures retain truthful local state and include the remote error.
- Partial batch failures return per-item results.
- Activity log records test batches, transient recovery, removal, removal failure, revival, restore, rename, and remote reconciliation.

## Verification

Permanent behavior tests should cover contracts where regression could cause destructive or inconsistent state:

1. first check failure plus retry success does not delete the pool;
2. two failures call remote delete and retain a local removed record;
3. remote delete failure produces `delete_failed` without clearing `remoteId`;
4. remote DELETE 404 produces `removed`;
5. removed-proxy success produces `revived` without remote creation;
6. restore creates an inactive pool and attaches its new remote ID;
7. restore reconciles an existing endpoint instead of duplicating it;
8. linked rename is remote-first and local state stays unchanged on remote failure;
9. local-only rename works for removed and revived records;
10. diagnostics worker count never exceeds `checkConcurrency`;
11. diagnostics percent/count scope selects the correct bounded number;
12. one detailed-check failure does not stop remaining workers.

Runtime verification must exercise:

- one real per-row proxy test;
- a selected batch test with visible progressive states;
- rename success and remote failure behavior;
- confirmed-dead removal and local retention through a 9Router API test double;
- removed-proxy recheck, revival, and inactive restore;
- Diagnostics percentage and custom-count runs;
- desktop and mobile layouts in a browser, including keyboard dialog flow.

## Files Expected to Change

- `src/lib/types.ts`
- `src/lib/api.ts`
- `src/server/nine-router-client.ts`
- `src/server/checker.ts`
- `src/server/pool-ranker.ts`
- `src/server/detailed-checker.ts`
- `src/server/server.ts`
- `src/app/(dashboard)/proxies/page.tsx`
- `src/app/(dashboard)/diagnostics/page.tsx`
- `src/components/dashboard-shell.css`
- `src/components/diagnostics.css`
- focused existing/new test files only where behavior contracts above require them

No new production dependency is expected.
