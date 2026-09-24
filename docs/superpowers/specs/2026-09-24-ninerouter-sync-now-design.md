# 9Router Sync Now and Remote Tracking Design

**Date:** 2026-09-24

## Goal

Đổi flow đồng bộ proxy để 9Router là nguồn health-check duy nhất cho proxy pools, full sync tự chạy tối đa một lần mỗi 6 giờ, trạng thái remote được theo dõi liên tục mỗi 60 giây, proxy hỏng được deactivate rồi xóa khỏi 9Router trước khi ranking và rename, và UI không còn hiển thị proxy active khi 9Router đã deactivate hoặc xóa nó.

## Scope

In scope:

- Full sync tự động khi server/login flow vào trạng thái stale, với cooldown mặc định và tối thiểu 6 giờ.
- Nút `Sync now` là force sync, không bị cooldown 6 giờ chặn.
- Track-only refresh lấy danh sách proxy và trạng thái `isActive`, `testStatus`, `lastError`, `lastTestedAt` trực tiếp từ 9Router.
- Background track-only refresh mỗi 60 giây và refresh có dedupe khi dashboard mở/gọi API.
- Full sync chỉ dùng `POST /api/proxy-pools/:id/test` của 9Router để health-check.
- Proxy test fail: deactivate trước, sau đó delete khỏi 9Router; giữ local record ở tab `Removed`.
- Chỉ rank và rename sau khi mọi proxy fail đã được xử lý.
- Active/reserve state local phản ánh kết quả activation thực tế từ 9Router.
- Xóa UI/API manual proxy health-check (`POST /api/ninerouter/test`, `Test selected`, `Test` row action).
- Giữ backend proxy audit độc lập; không thay đổi các health probe phục vụ safety auditor.

Out of scope:

- Không xóa proxy record local sau khi xóa khỏi 9Router.
- Không đổi flow manual rename, manual remove, hoặc backend safety audit.
- Không thêm dependency.
- Không đưa credential proxy vào browser, activity log, hoặc error response.
- Không dùng file text làm runtime source of truth; pool state hiện tại vẫn dùng `data/pool-state.json` theo kiến trúc repo.

## Definitions

- **Full sync:** lấy remote pool list, test từng pool bằng 9Router, deactivate/delete pool fail, rank survivor, activate/deactivate theo tier, rename theo rank, ghi `lastSyncAt`.
- **Track-only refresh:** lấy remote pool list có metadata trạng thái, reconcile local state, không test lại, không delete, không rank, không rename, không đổi `lastSyncAt`.
- **Stale:** `lastSyncAt` là `null` hoặc `Date.now() - lastSyncAt >= 6 hours`.
- **Force sync:** request từ nút `Sync now`; bỏ qua stale check nhưng vẫn không chạy trùng khi một sync khác đang chạy.
- **Remote truth:** `isActive`, `testStatus`, `lastError`, `lastTestedAt`, và pool tồn tại/không tồn tại trong response 9Router.
- **Operational health:** kết quả gần nhất của full sync, lưu trong `status`, `latency_ms`, `checked_at`, `last_error`.

## Data contracts

### Remote pool

`listPools()` trả về các trường cần cho cả import và tracking:

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

`listPools()` vẫn lọc/để caller lọc relay như hiện tại; không bỏ các trường remote metadata.

### Remote test

```ts
export interface NineRouterTestResult {
  ok: boolean;
  status?: number;
  statusText?: string | null;
  error?: string | null;
  elapsedMs?: number;
  testedAt?: string;
}
```

`testPool()` MUST return a structured `NineRouterTestResult` even when the HTTP status is non-2xx, as long as the body contains boolean `ok`; 9Router currently uses HTTP 500 with `{ ok: false, error }` for proxy test failures. `ok === true` is usable. Explicit `ok === false` is a confirmed proxy failure and enters deactivate/delete lifecycle. Network, authentication, malformed-response, or other request throws are infrastructure errors: keep the remote pool linked, preserve its remote active truth, exclude it from ranking/rename for this run, record the error, and continue other pools without delete.

### Local PoolRecord additions

Giữ các field hiện có, thêm metadata remote:

```ts
remoteTestStatus?: string | null;
remoteLastError?: string | null;
remoteLastTestedAt?: number | null;
```

`isActiveOnRouter` MUST luôn phản ánh lần track/list hoặc activation update thành công gần nhất, không suy ra từ `tier`.

- Track-only remote `isActive === true`: ghi `isActiveOnRouter = true` và `tier = "active"` cho linked pool.
- Track-only remote `isActive === false`: ghi `isActiveOnRouter = false` và hạ linked pool đang `active` về `reserve`; không tự đánh dấu dead.
- Track-only remote `isActive` không có: giữ giá trị local và ghi activity warning một lần theo throttle.
- Remote `testStatus`, `lastError`, `lastTestedAt`: ghi vào metadata; không dùng track-only để tự kết luận operational `status = dead`.
- Remote pool biến mất khỏi list trong khi local record là `linked`: set `remoteId = null`, `remoteState = "removed"`, `tier = "removed"`, `isActiveOnRouter = false`; giữ record local.
- Remote pool mới: tạo local record với `healthStatus = "pending"`, `testState = "idle"`, `remoteState = "linked"`, `remoteId` từ remote, `isActiveOnRouter` từ remote nếu có, và tier `active`/`reserve` theo remote boolean; nếu boolean thiếu thì dùng `reserve`.
- Full sync test success cập nhật `remoteTestStatus`, `remoteLastError = null`, `remoteLastTestedAt`, `status = "usable"`, `latency_ms = elapsedMs` nếu có.
- Full sync test failure cập nhật metadata/error rồi deactivate/delete; local record trở thành `removed` nếu delete thành công hoặc 404.

## Full sync state machine

```text
request
  -> reject duplicate if syncing
  -> fetch remote pools
  -> reconcile local linked records
  -> 9Router test each eligible remote pool
  -> for each failed pool: PUT isActive=false, then DELETE
  -> persist survivors and removed records
  -> rank usable survivors by latency, success count, localId
  -> PUT active state for every linked survivor
  -> persist only successful activation state
  -> rename survivors from highest rank to rank 1
  -> set lastSyncAt and done
```

### Entry points

- `POST /api/ninerouter/sync` calls `poolRanker.syncPools({ force: true })` and returns `202`.
- Scheduled sync calls `poolRanker.startSyncIfStale()`; stale check happens inside ranker so every automatic entry point shares one policy.
- The first authenticated `GET /api/ninerouter/pools` calls `poolRanker.startSyncIfStale()`: if stale, it starts the same full sync used by the scheduler; if recent, it performs track-only refresh.
- Track-only refresh never updates `lastSyncAt` and MUST skip while a full sync is running.

### Fetch and matching

- Supported remote types remain `http`, `socks`, and `socks5`; relay types are tracked in `stats.skipped` and are not tested/ranked.
- Match remote records first by `remoteId`, then by parsed endpoint.
- Preserve local IDs for matched records.
- Remote list is authoritative for linked existence. Missing linked remote records become local `removed` records during track-only or full fetch reconciliation.
- Existing local removed records remain for history and are not re-added unless the same endpoint appears remotely; a reappeared endpoint is linked to the existing local record.

### 9Router health-check lifecycle

For every eligible remote pool, call `testPool(remote.id)` through `nine-router-client.ts`. Do not call `checker.ts`, `checkProxy`, `checkMany`, TCP connect, SOCKS tunnel, ipify, or any local proxy probe from this sync path.

On explicit `{ ok: false }`:

1. Call `setPoolActive(remote.id, false)`.
2. Attempt `deletePool(remote.id)` even if deactivation returned an error, so a stale active pool is not left behind.
3. If delete succeeds or returns 404, set local `remoteId = null`, `remoteState = "removed"`, `tier = "removed"`, and `isActiveOnRouter = false`.
4. If delete fails with another error, preserve `remoteId`, set `remoteState = "delete_failed"`, `tier = "removed"`, `isActiveOnRouter = false`, and persist the delete error.
5. Continue processing every other pool; one lifecycle failure MUST NOT abort ranking of successful survivors.

On thrown test request, record an infrastructure error and exclude that pool from the current run's survivor set; do not deactivate, delete, activate, or rename it. On test success, add the pool to the current run's verified survivor set. Ranking uses this set, not stale `status` values from earlier runs.

On test success, do not delete or deactivate before ranking. Ranking decides active/reserve state after all tests finish.

### Ranking, activation, rename

- Eligible survivors are `status === "usable" && remoteState === "linked"`.
- Sort ascending by `latency_ms`; tie-break with descending `successes`, then ascending `localId`.
- First `activePoolLimit` survivors are `active`; remaining survivors are `reserve`.
- Send one activation update for every linked survivor. Successful results set both `isActiveOnRouter` and tier to the requested value.
- Failed activation results keep the prior remote-known `isActiveOnRouter`, set `last_error`, and reconcile tier to that truth: `active` when prior remote state is true, otherwise `reserve`.
- UI and stats MUST use this reconciled tier; they MUST NOT present intended-but-rejected activation as active.
- Rename all ranked survivors using rank numbers, from highest rank down to rank 1, so rank 1 is applied last. A rename failure logs warning, keeps prior name, and does not cancel remaining renames.
- Set `lastSyncAt` only after fetch, tests, failed-pool lifecycle, activation updates, and rename loop finish. If the full sync throws before completion, preserve the previous timestamp and write `lastError`.

## Track-only refresh

Add `refreshRemoteTracking(): Promise<{ refreshed: boolean; skipped: boolean; error?: string }>` to the ranker.

- Guard with a process-local refresh lock.
- Enforce a 60-second minimum interval between successful remote list requests. Concurrent calls reuse the active promise or return `{ refreshed: false, skipped: true }`.
- Call `listPools()` only; never call `testPool`, `checkProxy`, `setPoolActive`, `deletePool`, or `updatePool`.
- Reconcile `isActiveOnRouter` and remote metadata for every returned pool.
- Mark linked local records absent from the remote list as removed.
- Persist atomically without changing `lastSyncAt`, latency, or operational health results. Track-only does not rerank by latency; it changes tier only to mirror remote `isActive` truth or remote removal.
- On request failure, keep prior state, write throttled activity/error, and return the error without throwing into the HTTP polling loop.
The server starts a 60-second interval after app preparation. `GET /api/ninerouter/pools` invokes `startSyncIfStale()` before reading local pools: stale state starts one full sync, recent state performs the deduped track-only refresh, and a running full sync is only observed. This keeps dashboard login current without causing a 9Router request on every browser poll.
## Cooldown and scheduler

- Effective default full-sync interval is `360` minutes in `src/server/app-config.ts` and `data/settings.json`.
- Configuration MUST clamp `nineRouterSyncMinutes` to at least `360`; a lower environment or settings value cannot bypass the six-hour automatic cooldown.
- Ranker keeps process-local `lastAutoSyncAttemptAt`. Automatic stale admission compares the current time against the newer of persisted successful `lastSyncAt` and `lastAutoSyncAttemptAt`, preventing dashboard polling from relaunching a failed full sync every 15 seconds. Process restart permits one fresh automatic attempt.
- Startup and scheduled paths call `startSyncIfStale()`. If not stale, it performs track-only refresh and schedules the next full sync for the remaining time.
- The first authenticated `GET /api/ninerouter/pools` also calls `startSyncIfStale()`. This is the login/open-dashboard trigger; stale state starts full sync, recent state only tracks remote metadata.
- Manual `POST /api/ninerouter/sync` is force and may run before six hours; force does not read `lastAutoSyncAttemptAt`, but duplicate concurrent requests still return `202 { started: false, running: true }`.
- A track-only request MUST NOT run while full sync owns the sync lock. Browser polling only observes state/progress while full sync runs.

## API and UI changes
Remove manual pool health-check and recovery contracts:

- Delete `POST /api/ninerouter/test` route and its validation.
- Delete `testPools()` browser API client.
- Remove row `Test` actions and `Test selected` action from proxies page.
- Delete restore endpoint/client/UI/ranker action because removed pools no longer have an approved health source that can move them to `revived`; history remains read-only in Removed.
- Keep sync progress phase `check`, but label it `9Router health check`.
- Sync button remains `Sync now`; its request is force sync and its toast states that health-check comes from 9Router.
- Polling remains for progress/status, but `fetchPools` route refresh is deduped to 60 seconds.
- Right panel interval displays the effective six-hour automatic interval.

No endpoint returns raw proxy credentials, remote cookies, password, or API key.

## Error handling

- Missing 9Router configuration prevents scheduled/forced full sync and produces existing configured error response.
- Duplicate sync is not an error; return `202` with `running: true`.
- Track-only failure never deletes or rewrites proxy records; it only records the last tracking error.
- Test failure, deactivation failure, and delete failure are isolated per pool and visible in activity/state.
- Delete 404 is idempotent removal.
- Activation failure does not roll back successful activation updates; local state records per-item result.
- Rename failure does not roll back ranking or activation.
- `finally` always releases sync/track locks and returns progress to `idle` unless a completed sync is intentionally shown as `done`.

## Verification

Required behavior tests:

- Remote list metadata updates local `isActiveOnRouter` and metadata during track-only refresh.
- Track-only refresh does not call test, deactivate, delete, rank, rename, or change `lastSyncAt`.
- Missing remote linked pool becomes `removed` locally and remains visible in Removed.
- Track-only refresh is deduped within 60 seconds and concurrent calls do not create duplicate remote requests.
- Full sync uses `testPool`, never local `checkProxy`.
- Failed test calls deactivate then delete; delete 404 is treated as removed; delete failure becomes `delete_failed` and other pools continue.
- Ranking and rename occur only after failed-pool cleanup; rename order is highest rank to 1.
- Activation result, not intended tier, controls `isActiveOnRouter` truth.
- Automatic sync skips before six hours; force sync bypasses cooldown; duplicate force sync is rejected.
- Manual health-check route/client/UI are absent.

Run:

```sh
npm run typecheck
npm test
npm run build
```

Use a fake 9Router dependency in unit tests. Do not run real destructive delete tests against production 9Router; one controlled smoke test may call `GET /api/ninerouter/pools` and observe metadata only.
