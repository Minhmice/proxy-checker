# Token Analysis & Proxy Auto-Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hợp nhất Dashboard Token + Proxy/Account status, giữ auto-binding Antigravity theo Settings, và loại bỏ Fleet, machine monitoring, dual-router reconciliation, proxy-server provisioning và các deployment surface tương ứng.

**Architecture:** Giữ một server Node/Next/Hono kết nối tới một 9Router Raspberry Pi. `antigravity-rotator` tiếp tục đọc quota Gemini, xoay account theo `antigravitySessionThreshold`, `antigravityActiveLimit`, `antigravityRotateMinutes`, và giữ/thay proxy binding theo trạng thái proxy. Tách `antigravityOwnership`/repair route single-router khỏi dual-router reconciliation trước khi xóa dual-router; giữ `proxies.sqlite3` và `antigravity-rotation.sqlite3`, xóa Fleet database cùng schema/runtime artifacts.

**Tech Stack:** TypeScript, Node.js 22+, Next.js App Router, Hono, React, shadcn/ui, better-sqlite3, Drizzle schema, node:test, Biome, Docker/systemd.

**Spec:** `docs/superpowers/specs/2026-10-30-token-analysis-proxy-autobind-design.md`

## Global Constraints

- Chỉ giữ app shell gồm Dashboard, Proxies, Bindings, Settings, Login.
- Dashboard `/` là màn hình hợp nhất Token/Cost telemetry và active Antigravity account/proxy bindings.
- Quota rotation chỉ xét Gemini session quota; không dùng Claude, GPT hoặc weekly quota để quyết định rotation.
- Account hết quota khi `sessionQuota <= settings.antigravitySessionThreshold`; account dự phòng phải có quota `> settings.antigravitySessionThreshold`.
- Số account hoạt động lấy từ `settings.antigravityActiveLimit`; không hardcode giới hạn đồng thời.
- Ưu tiên account có reset time còn lại thấp nhất; giữ proxy đang sống, chỉ thay proxy chết/chưa có bằng proxy sống tốt nhất.
- Router định tuyến độc quyền qua Raspberry Pi; không giữ dual-master synchronization hoặc dynamic fleet inventory.
- Giữ `proxies.sqlite3` và `antigravity-rotation.sqlite3`; xóa `fleet.sqlite3` runtime/backup và mọi Fleet schema/runtime code.
- Không thêm dependency mới; giữ shadcn components và dot-matrix 5x7 renderer.
- Mọi route, import, test, script, Docker/systemd reference bị xóa phải được grep lại toàn repo.

---

## File Map

### Giữ và sửa
- `src/app/(dashboard)/page.tsx` — Dashboard hợp nhất Token + active account/proxy status.
- `src/app/(dashboard)/settings/page.tsx` — Settings router, rotation threshold, active limit, password.
  - `src/app/(dashboard)/proxies/page.tsx` — Giữ proxy inventory, health observation, import/export và các thao tác cần cho auto-binding; không tạo proxy server/daemon hoặc máy host.
- `src/app/(dashboard)/ninerouter/proxies/page.tsx` — Binding surface to move to `/bindings`.
- `src/components/app-sidebar.tsx` — Four short labels: Dashboard, Proxies, Bindings, Settings.
- `src/components/token-usage-card.tsx` — Existing token/cost dot-matrix and trend display.
- `src/components/ninerouter/account-bindings-table.tsx` and related binding components — Reuse for Dashboard/Bindings.
- `src/server/server.ts` — Single-router initialization, maintenance cycle, API dependencies, shutdown.
- `src/server/unified-sync-coordinator.ts` — Router sync + Antigravity rotation only; no dual-router task.
- `src/server/antigravity-rotator.ts` — Settings-driven quota rotation and binding behavior.
- `src/server/antigravity-repair.ts`, `src/server/antigravity-ownership.ts` — Single-router repair/ownership boundary.
- `src/server/api/app.ts`, `src/server/api/types.ts` — Remove dual-router dependency and mount.
- `src/server/api/routes/ninerouter.ts` — Retain token stats and binding endpoints; remove node/live-console endpoints.
- `src/server/app-config.ts`, `src/lib/types.ts` — Keep only supported settings fields.
- `src/server/proxy-intelligence-db.ts`, `src/server/proxy-intelligence-repository.ts` — Remove Fleet table setup and dead managed-endpoint methods.
- `src/db/proxies/schema.ts`, `src/db/migrations/proxies/0000_baseline.sql`, `src/db/common/migrate.ts` — Remove Fleet table safely without losing proxy rows.
- `src/server/backup/backup-service.ts`, `scripts/db-preflight.ts`, `scripts/db-verify.ts` — Keep only retained DBs and remove Fleet assertions.
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/quality.yml`, `deploy/**`, `package.json` — Remove agent/WireGuard/3proxy/Fleet deployment contracts.

### Delete
- `src/server/dual-router/`
- `src/components/dual-router/dual-router-card.tsx`
- `src/components/right-panel.tsx` and only its now-unused callers.
- Placeholder routes `/cdk`, `/invoice`, `/referral`, `/reseller`, `/scraping`, `/wallet`.
- Node/machine monitoring surfaces, including node inventory/live console UI and corresponding API routes.
- `data/fleet.sqlite3`, `backups/databases/fleet.sqlite3`.
- Fleet/agent/WireGuard/3proxy deployment units and dead scripts identified by repository-wide grep.

### Tests to update/add
- Add/modify focused tests for single-router ownership, settings-driven rotation, proxy preservation/replacement, token stats, route absence, and migration cleanup.
- Remove tests that exclusively assert deleted Fleet, node monitoring, live console, dual-router, agent, WireGuard, or proxy-creation UI behavior.
- Keep full module tests for every retained subsystem.

---

## Task 1: Establish single-router ownership boundary

**Files:**
- Modify: `src/server/server.ts:90-140,897-918`
- Modify: `src/server/antigravity-repair.ts` and `src/server/antigravity-ownership.ts` only if their signatures currently require dual-router IDs.
- Modify: `src/server/api/types.ts` to expose only ownership dependency needed by retained Antigravity routes.
- Test: `tests/antigravity-repair.test.ts`, `tests/proxy-ownership.test.ts`, `tests/server-api-runtime.test.ts`

**Interfaces:**
- `antigravityRotator` receives one configured router URL and the ownership authority.
- Repair callback remains `(accountId: string, routerUrl?: string) => Promise<unknown>` but resolves only the configured Raspberry Pi URL.
- No retained caller may require `DualRouterCoordinator`, `DualRouterScheduler`, `SyncRepository`, or `RouterAdapter`.

- [ ] **Step 1: Write failing single-router contract test**
  - Assert the rotator repair callback uses the configured primary router when no URL is supplied.
  - Assert no second router adapter is created when settings contain multiple legacy URLs.
  - Assert ownership repair still receives the existing authority object.

- [ ] **Step 2: Run focused tests and confirm failure**
  - Run: `node --import tsx --test tests/antigravity-repair.test.ts tests/proxy-ownership.test.ts`
  - Expected: failure or type errors showing the current dual-router dependency.

- [ ] **Step 3: Implement single-router boundary**
  - Keep `getSettingsSecrets().nineRouterUrl` as the sole route target.
  - Retain `router-sync.sqlite3` only if ownership authority requires it; remove coordinator/reconciliation construction from `server.ts`.
  - Remove `dualRouterRepo`, `dualRouterAdapters`, `dualRouterCoordinator`, and `dualRouterScheduler` from `createApiApp` dependencies after all ownership callers are independent.

- [ ] **Step 4: Run focused tests**
  - Run: `node --import tsx --test tests/antigravity-repair.test.ts tests/proxy-ownership.test.ts tests/server-api-runtime.test.ts`
  - Expected: PASS.

- [ ] **Step 5: Commit**
  - `git add src/server/server.ts src/server/antigravity-repair.ts src/server/antigravity-ownership.ts src/server/api/types.ts tests/antigravity-repair.test.ts tests/proxy-ownership.test.ts tests/server-api-runtime.test.ts`
  - `git commit -m "refactor: isolate antigravity ownership from dual router"`

---

## Task 2: Remove dual-router reconciliation

**Files:**
- Modify: `src/server/unified-sync-coordinator.ts`
- Modify: `src/server/api/app.ts`, `src/server/api/types.ts`
- Delete: `src/server/api/routes/dual-router.ts`, `src/server/dual-router/`
- Delete: dual-router-only client helpers/types from `src/lib/api.ts` and `src/lib/types.ts`.
- Modify: `src/server/server.ts` maintenance initialization and shutdown.
- Test: `tests/unified-sync-coordinator.test.ts`, `tests/dual-router-*.test.ts`, `tests/dual-router-api.test.ts`, `tests/dual-router-integration.test.ts`

**Interfaces:**
- `UnifiedSyncCoordinatorDeps` contains pool ranker, Antigravity rotator, optional proxy intelligence working-pool sync only if still required, and no dual-router scheduler.
- `UnifiedSyncReport` contains router sync, rotation, duration, completion, skip and error fields; no `dualRouterResult`.
- `/api/ninerouter/dual/*` returns 404 because route is not mounted.

- [ ] **Step 1: Update coordinator tests to assert only retained tasks**
  - Remove dual-router scheduler fixtures and assertions.
  - Add assertion that a cycle runs router sync and rotation concurrently and reports their errors independently.

- [ ] **Step 2: Run the full coordinator module**
  - Run: `node --import tsx --test tests/unified-sync-coordinator.test.ts`
  - Expected: FAIL until implementation removes the dual task.

- [ ] **Step 3: Remove dual task and dependency types**
  - Delete scheduler task insertion, settled-result indexing, error aggregation, logging, and report assignment.
  - Remove route mount and dependency properties.
  - Remove dual-router client helper functions and dual-only response types only when grep confirms no retained callers.

- [ ] **Step 4: Delete dual-router implementation and tests**
  - Delete the route/module files and tests whose only purpose is dual-master reconciliation/conflicts/write-back.
  - Preserve usage telemetry used by `/api/ninerouter/stats` if it is not dual-specific.

- [ ] **Step 5: Run complete affected tests**
  - Run: `node --import tsx --test tests/unified-sync-coordinator.test.ts tests/api-contract.test.ts tests/hono-api-contract.test.ts tests/server-api-runtime.test.ts tests/ninerouter-client.test.ts`
  - Expected: PASS; request to `/api/ninerouter/dual/status` must be 404 in the route contract test.

- [ ] **Step 6: Commit**
  - `git add src/server/unified-sync-coordinator.ts src/server/api src/server/server.ts src/lib/api.ts src/lib/types.ts tests`
  - `git commit -m "refactor: remove dual-router reconciliation"`

---

## Task 3: Make auto-binding fully Settings-driven

**Files:**
- Modify: `src/server/antigravity-rotator.ts`
- Modify: `src/server/server.ts`, `src/server/unified-sync-coordinator.ts`
- Modify: `src/server/api/routes/antigravity.ts` and binding routes as needed.
- Modify: `src/components/ninerouter/account-bindings-table.tsx`, `src/components/ninerouter/binding-picker-dialog.tsx`, `src/app/(dashboard)/ninerouter/proxies/page.tsx`.
- Test: `tests/antigravity-rotator.test.ts`, `tests/antigravity-server-api.test.ts`, `tests/proxy-binding-actions.test.ts`, `tests/proxy-binding-state.test.ts`, `tests/proxy-binding-status.test.ts`.

**Interfaces:**
- Rotation input reads `antigravitySessionThreshold`, `antigravityActiveLimit`, and `antigravityRotateMinutes` from `AppSettings`/`getSettingsSecrets()`.
- Candidate selection excludes Gemini session quota `<= threshold`, then sorts by earliest reset time with stable account-ID tie-break.
- Binding selection preserves a live current proxy and replaces only missing/dead proxies with the best usable proxy.

- [ ] **Step 1: Add failing tests for settings precedence and binding preservation**
  - Test threshold `25` deactivates account at `25` and only candidates above `25` activate.
  - Test active limit `1` activates exactly one account, regardless of any old default.
  - Test candidate reset time beats higher quota.
  - Test a live existing proxy remains unchanged.
  - Test a dead/missing proxy is replaced by the lowest-latency usable proxy.

- [ ] **Step 2: Run full affected modules and confirm failures**
  - Run: `node --import tsx --test tests/antigravity-rotator.test.ts tests/proxy-binding-actions.test.ts tests/proxy-binding-state.test.ts tests/proxy-binding-status.test.ts`
  - Expected: FAIL for any hardcoded/default precedence or proxy swap behavior.

- [ ] **Step 3: Implement minimum rotation/binding changes**
  - Remove hardcoded concurrent-account defaults from the decision path.
  - Keep Gemini-only quota evaluation and reset-time ordering.
  - Reuse existing proxy state and health fields; do not introduce a second binding store.
  - Ensure failed remote binding returns an explicit error and does not silently delete local account/proxy state.

- [ ] **Step 4: Update API and UI contracts**
  - Expose active accounts, quota, bound proxy, latency, and rotation state through one binding response shape.
  - Ensure Settings form sends the three rotation values and reads them back from the server.

- [ ] **Step 5: Run full affected modules**
  - Run: `node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-server-api.test.ts tests/proxy-binding-actions.test.ts tests/proxy-binding-state.test.ts tests/proxy-binding-status.test.ts settings-ux-validation.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit**
  - `git add src/server/antigravity-rotator.ts src/server/server.ts src/server/unified-sync-coordinator.ts src/server/api/routes/antigravity.ts src/components/ninerouter src/app/(dashboard)/settings src/app/(dashboard)/ninerouter/proxies tests`
  - `git commit -m "feat: make antigravity proxy binding settings-driven"`

---

## Task 4: Remove Fleet schema and database artifacts safely

**Files:**
- Modify: `src/db/proxies/schema.ts`
- Modify: `src/db/migrations/proxies/0000_baseline.sql` and migration metadata only according to existing migration convention.
- Modify: `src/db/common/migrate.ts`
- Modify: `src/server/proxy-intelligence-db.ts`
- Modify: `src/server/proxy-intelligence-repository.ts`
- Modify: `src/server/backup/backup-service.ts`, `scripts/db-preflight.ts`, `scripts/db-verify.ts`
- Delete: `data/fleet.sqlite3`, `backups/databases/fleet.sqlite3`
- Test: `tests/db-clients.test.ts`, `tests/proxy-intelligence-db.test.ts`, `tests/proxy-intelligence-migration.test.ts`, `tests/backup-service.test.ts`, `tests/db-preflight.test.ts`

**Interfaces:**
- Existing proxy rows and proxy check history remain readable after migration.
- `migrateDomain(raw, "proxies")` removes/ignores only the explicitly obsolete `fleet_managed_endpoints` table and does not drop `proxies`, `proxy_test_history`, or other retained tables.
- Backup database list is exactly `proxies.sqlite3` and `antigravity-rotation.sqlite3`.

- [ ] **Step 1: Add migration regression test with legacy Fleet table**
  - Create temporary proxies DB with `fleet_managed_endpoints` plus a valid proxy row.
  - Run proxy migration.
  - Assert the proxy row remains and `fleet_managed_endpoints` is absent.
  - Assert unknown non-legacy tables still fail migration.

- [ ] **Step 2: Run migration module and confirm failure**
  - Run: `node --import tsx --test tests/db-clients.test.ts tests/proxy-intelligence-db.test.ts tests/proxy-intelligence-migration.test.ts`
  - Expected: FAIL while the old schema/runtime code remains.

- [ ] **Step 3: Remove Fleet schema and runtime table setup**
  - Delete Drizzle table declaration and indexes.
  - Remove raw create/alter/index code from `openProxyIntelligenceDb`.
  - Remove repository interface and implementation methods only after repository-wide caller search confirms zero callers.
  - Update migration handling to safely remove the known obsolete table from existing retained DBs; do not rewrite unrelated history rows.

- [ ] **Step 4: Remove Fleet DB backup/preflight contracts**
  - Remove Fleet from backup file list and verification scripts.
  - Delete only Fleet DB files explicitly approved by user; retain `proxies.sqlite3` and `antigravity-rotation.sqlite3` plus their backups.

- [ ] **Step 5: Run complete DB/backup modules**
  - Run: `node --import tsx --test tests/db-clients.test.ts tests/proxy-intelligence-db.test.ts tests/proxy-intelligence-migration.test.ts tests/backup-service.test.ts tests/db-preflight.test.ts`
  - Expected: PASS; proxy/rotation DBs remain present, Fleet DB is not expected.

- [ ] **Step 6: Commit**
  - `git add src/db src/server/proxy-intelligence-db.ts src/server/proxy-intelligence-repository.ts src/server/backup scripts tests data/fleet.sqlite3 backups/databases/fleet.sqlite3`
  - `git commit -m "refactor: remove fleet database layer"`

---

## Task 5: Consolidate frontend dashboard, Bindings route and sidebar

**Files:**
- Modify: `src/app/(dashboard)/page.tsx`
- Move/modify: `src/app/(dashboard)/ninerouter/proxies/page.tsx` to `src/app/(dashboard)/bindings/page.tsx`.
- Modify: `src/components/app-sidebar.tsx`, `src/components/command-palette.tsx`.
- Modify: `src/components/ninerouter/account-bindings-table.tsx` and binding context components.
- Delete: `src/app/(dashboard)/ninerouter/dashboard/page.tsx` after its token components are embedded/reused, `src/components/ninerouter/live-console-terminal.tsx`, `src/components/right-panel.tsx`, `src/components/dual-router/dual-router-card.tsx`.
- Delete: placeholder routes `/cdk`, `/invoice`, `/referral`, `/reseller`, `/scraping`, `/wallet`.
- Test: `tests/dashboard-content-integrity.test.ts`, `tests/token-usage-dashboard.test.ts`, `tests/token-usage-card-refactor.test.ts`, `tests/app-sidebar-nav.test.ts`, `tests/ninerouter-proxies-page.test.ts`, `tests/proxy-binding-ux.test.ts`.

**Interfaces:**
- Dashboard `/` renders token telemetry plus active account/proxy bindings without live console or right-panel sync operations.
- Sidebar labels and paths are exactly `Dashboard` `/`, `Proxies` `/proxies`, `Bindings` `/bindings`, `Settings` `/settings`.
- Token selector supports `today`, `24h`, `7d`, `30d`; token/cost toggle keeps trend and efficiency metric aligned to selected metric.

- [ ] **Step 1: Update frontend contract tests**
  - Assert required sidebar labels/paths and absence of Nodes, Monitoring, Events, Fleet, Dual Router, and console links.
  - Assert Dashboard contains TokenUsageCard and account/proxy binding surface.
  - Assert `/bindings` exists and `/ninerouter/dashboard` is no longer linked.

- [ ] **Step 2: Run full affected UI tests and confirm failures**
  - Run: `node --import tsx --test tests/dashboard-content-integrity.test.ts tests/token-usage-dashboard.test.ts tests/token-usage-card-refactor.test.ts tests/app-sidebar-nav.test.ts tests/ninerouter-proxies-page.test.ts tests/proxy-binding-ux.test.ts`
  - Expected: FAIL until the route and navigation are consolidated.

- [ ] **Step 3: Move binding route and compose Dashboard**
  - Move the existing binding page to `/bindings` without duplicating binding logic.
  - Render existing token card/period selector and account-binding table in `/`.
  - Remove live SSE console and proxy sync drawer from the Dashboard.
  - Giữ Proxies page và proxy record operations được spec duyệt: inventory, import/export, health check, pin/delete và pool state; không thêm proxy-server provisioning.

- [ ] **Step 4: Rename navigation and remove dead links**
  - Set sidebar to four items with short labels.
  - Update command palette and breadcrumbs to `/bindings`.
  - Remove deleted placeholder route links and obsolete copy.

- [ ] **Step 5: Run complete affected UI tests**
  - Run: `node --import tsx --test tests/dashboard-content-integrity.test.ts tests/token-usage-dashboard.test.ts tests/token-usage-card-refactor.test.ts tests/app-sidebar-nav.test.ts tests/ninerouter-proxies-page.test.ts tests/proxy-binding-ux.test.ts`
  - Expected: PASS.

- [ ] **Step 6: Commit**
  - `git add src/app src/components tests`
  - `git commit -m "feat: consolidate token and binding dashboards"`

---

## Task 6: Remove machine monitoring and proxy-server creation/deployment surfaces

**Files:**
- Modify: `src/server/api/routes/ninerouter.ts`, `src/server/ninerouter-node-proxy.ts`.
- Modify: `src/server/server-interactive-updater.ts` only if no retained router settings operation uses it; otherwise delete only dead upgrade surface.
  - Delete: node stats/live-console routes and components, `src/components/ninerouter/mini-usage-card.tsx` only after token usage uses the aggregate `/stats` contract directly.
  - Delete/update: `Dockerfile`, `docker-compose.yml`, `.github/workflows/quality.yml`, `deploy/systemd/3proxy.service`, `deploy/systemd/proxyfleet-agent.service`, WireGuard examples, obsolete Pi install/deploy scripts, and fleet benchmark scripts. This removes proxy-server provisioning artifacts, not proxy record import/health management.
- Modify: `package.json` to remove scripts referencing deleted agent/acceptance files.
- Test: `tests/ninerouter-node-proxy.test.ts`, `tests/live-console-terminal.test.ts`, `tests/server-api-runtime.test.ts`, CI/config contract tests.

**Interfaces:**
- `/api/ninerouter/stats` remains the sole usage telemetry endpoint for the Dashboard.
- Node inventory, node-specific stats, live console SSE, agent install, 3proxy, WireGuard and machine provisioning endpoints do not exist.
- Settings continues to configure the single 9Router connection and auth.

- [ ] **Step 1: Add route absence and aggregate telemetry tests**
  - Assert `/api/ninerouter/stats?period=today` is retained.
  - Assert node inventory, node stats and console endpoints return 404.
  - Assert no package script references deleted agent/acceptance files.

- [ ] **Step 2: Run full affected module and confirm failures**
  - Run: `node --import tsx --test tests/ninerouter-node-proxy.test.ts tests/server-api-runtime.test.ts tests/live-console-terminal.test.ts`
  - Expected: FAIL only for contracts that still assert intentionally deleted machine-monitoring surfaces; retain and update aggregate token telemetry contracts.

- [ ] **Step 3: Keep aggregate token stats, delete machine monitoring**
  - Remove `getNodeInventory` and node-specific proxy forwarding from the retained route module if aggregate stats can call the configured Pi directly.
  - Preserve real token/cost aggregation fields and fallback behavior required by `fetchTokenUsage`.
  - Remove live console component and all callers.

- [ ] **Step 4: Clean deploy and CI artifacts**
  - Remove Go build/test/acceptance steps, WireGuard/3proxy packages, agent binaries, Fleet service files, WireGuard examples and fleet benchmarks.
  - Keep Node/Next service and only required backup/deploy steps.
  - Ensure Docker build context contains no deleted `agent/` path.

- [ ] **Step 5: Run affected tests and config checks**
  - Run: `node --import tsx --test tests/ninerouter-node-proxy.test.ts tests/server-api-runtime.test.ts tests/token-usage-dashboard.test.ts`
  - Run: `npm run typecheck`
  - Expected: PASS.

- [ ] **Step 6: Commit**
  - `git add src/server src/components src/app package.json Dockerfile docker-compose.yml .github deploy scripts tests`
  - `git commit -m "refactor: remove machine monitoring and proxy server deployment"`

---

## Task 7: Repository-wide consistency cleanup and documentation

**Files:**
- Modify: `README.md`, `.env.example`, `src/mocks/fixtures.ts`, backup manifests and retained deploy docs.
- Modify/delete every file found by the consistency grep that references removed Fleet, machine monitoring, dual-router, WireGuard, agent, 3proxy, live console, or deleted routes.
- Test: all retained test files; add a repository contract test only if existing conventions support it.

- [ ] **Step 1: Run required consistency searches**
  - Run repository searches for:
    - `fleet|Fleet|proxyfleet`
    - `dualRouter|dual-router|router-sync`
    - `wireguard|3proxy|proxyfleet-agent|install-agent.sh`
    - `/nodes|/monitoring|/events|/proxy-endpoints|/ninerouter/dashboard|/api/ninerouter/dual`
    - deleted files and scripts from `package.json`, Docker, CI and deploy.
  - Classify each match as retained historical data, active code, test contract, or stale artifact.

- [ ] **Step 2: Remove active stale references**
  - Remove active imports, routes, scripts, config fields and docs.
  - Keep only explicitly retained database names and token/rotation terminology.
  - Do not rename historical proxy source values inside retained DB rows unless a migration requirement proves it safe.

- [ ] **Step 3: Run typecheck and lint**
  - Run: `npm run typecheck`
  - Run: `npm run lint`
  - Run: `npm run format:check`
  - Expected: all pass.

- [ ] **Step 4: Run full test suite**
  - Run: `npm test`
  - Expected: all retained tests pass; no deleted-feature test remains in the test glob.

- [ ] **Step 5: Build and smoke test actual surface**
  - Run: `npm run build`.
  - Start: `npm start` with isolated settings and a test port.
  - Exercise: login, `/`, `/settings`, `/proxies`, `/bindings`, `/api/ninerouter/stats`, settings update, and logout.
  - Confirm: `/nodes`, `/monitoring`, `/events`, `/proxy-endpoints`, `/ninerouter/dashboard`, `/ninerouter/dual/status`, `/install-agent.sh` return 404.

- [ ] **Step 6: Final consistency and scope review**
  - Repeat every search from Step 1.
  - Compare changed files against this plan; confirm no unrelated behavior changed.
  - Run the full test module/file for each affected subsystem, not only newly added assertions.

- [ ] **Step 7: Commit final cleanup**
  - `git add .`
  - `git commit -m "refactor: finalize token analysis console cutover"`

## Acceptance Criteria

- `/` shows Token/Cost telemetry and active account/proxy binding status in one dashboard.
- Sidebar contains exactly Dashboard, Proxies, Bindings, Settings plus auth footer controls.
- Settings values control quota threshold, active-account limit, and rotation interval.
- Live proxies remain bound; dead/missing proxies are replaced with the best usable proxy.
- Single Raspberry Pi router remains the only runtime router target.
- Fleet DB is absent; retained proxy and rotation DBs remain usable.
- No active Fleet, node/machine management, live console, WireGuard, 3proxy, agent, dual-router reconciliation, or deleted route references remain.
- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run build` pass.
