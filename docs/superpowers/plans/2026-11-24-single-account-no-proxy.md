# Single-Account Antigravity Rotation Without Proxies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace proxy-bound multi-account rotation with quota-driven single-account rotation and remove proxy management from this repository while preserving live 9Router pools.

**Architecture:** Keep Antigravity account discovery, usage extraction, rotation history, endpoint isolation, activity logging, backup, and token telemetry. Replace the proxy-dependent rotation plan with a pure account activation/deactivation plan that persists one random 10–20% threshold per active tenure. Remove proxy runtime, UI, API, DB, scripts, skills, tests, and proxy-only historical plans/specs; use one temporary dry-run-safe command to remove only live account bindings.

**Tech Stack:** TypeScript, Node.js 22, Next.js, Hono, Drizzle ORM, better-sqlite3, Node test runner, Biome.

**Spec:** `docs/superpowers/specs/2026-11-24-single-account-no-proxy-design.md`

## Global Constraints

- Keep one selected Antigravity account active globally at steady state; activate-before-deactivate handoff may briefly overlap two accounts.
- Sample threshold uniformly as an integer in `[10, 20]`, persist it by endpoint-qualified account identity, and resample only after confirmed deactivation/new active tenure.
- Replacement requires fresh finite session quota `> 20%`, available quota, no current account error, and earliest valid reset time; endpoint-qualified ID breaks ties.
- If no replacement or activation fails, keep old active account; never intentionally empty an exhausted active set.
- Unread endpoints block new activations until global state is safely known; report degraded reconciliation.
- Remove all proxy assignment, pool, audit, intelligence, ranking, repair, ownership, import/export, and binding behavior from code and retained API/UI state.
- Live migration may remove only `providerSpecificData.proxyPoolId`; never delete 9Router pools or account records.
- Preserve `antigravityRotatorEnabled` and `antigravityRotateMinutes`; remove proxy-pool settings and `antigravityActiveLimit`/`antigravitySessionThreshold`.
- Do not alter unrelated user changes in the shared worktree; use selective commits.

## Execution boundaries

Tasks 1–4 form one integration unit because exported TypeScript contracts change together. Migrate every caller without compatibility shims; delete proxy-only tests alongside their owning subsystem. Commit Tasks 1–4 together only after focused tests and typecheck pass. Narrow tests run once per coherent change; full checks run once after integration. Use language-server references before changing exported symbols.

All commit steps below mean selective `commit.draft()` / `draft.commit(subject)`, never shell `git add` or `git commit`. The quoted shell commit syntax is a subject example only. No implementation or live command runs during plan authoring.

---

### Task 1: Lock down pure single-account rotation contract

**Files:**
- Modify: `src/server/antigravity-rotator.ts`
- Modify: `src/server/antigravity-rotation-history.ts`
- Test: `tests/antigravity-rotator.test.ts`
- Test: `tests/antigravity-rotation-history.test.ts`

**Interfaces:**
- Replace `UsableProxyInput`, proxy fields in `AntigravityAccountInput`, and proxy fields in `RotationPlan` with account-only types.
- Produce `computeRotationPlan(accounts: AntigravityAccountInput[], options: { allEndpointsReadable: boolean }): RotationPlan`, where `RotationPlan = { activations: string[]; deactivations: string[]; activeIds: string[]; degraded: boolean }`. Inputs add persisted `thresholdPercentage: number`. IDs are endpoint-qualified. Plan describes intended steady state, not verified remote success.
- Preserve `createAntigravityRotator(deps)` and single-flight `runRotation()`/`getSnapshot()` public behavior, but remove proxy dependencies and reset/optimization methods.
- Extend rotation history with endpoint-qualified active threshold persistence; keep existing history format readable and normalize invalid/missing thresholds once.

- Modify `src/db/rotation/schema.ts` and add a forward-only rotation migration through `src/db/common/migrate.ts`; never rewrite an applied baseline. Add nullable `thresholdPercentage` and tenure state to history rows. History gains `prepareActivation(accountId, thresholdPercentage)`, `confirmActivation(accountId, activatedAt)`, and `confirmDeactivation(accountId)`: prepare persists once; duplicate confirm cannot double-count; confirmed deactivation clears threshold. Existing active accounts adopt one threshold without inventing activation events. Reopen an isolated seeded DB and assert threshold stability plus idempotent confirmation. Expose threshold, quota availability and degraded status in retained account snapshot/API types.

Use these account-only predicates and comparator in the pure plan; usage validation must occur before sorting. Reuse existing imports rather than adding dependencies:

```ts
const eligible = (a: AntigravityAccountInput) =>
  a.quotaAvailable !== false && Number.isFinite(a.sessionPercentage) &&
  a.sessionPercentage > 20 && !a.lastError;
const resetTime = (a: AntigravityAccountInput) => {
  const value = a.resetAt ? Date.parse(a.resetAt) : NaN;
  return Number.isFinite(value) ? value : Infinity;
};
const byResetThenId = (a: AntigravityAccountInput, b: AntigravityAccountInput) => {
  const left = resetTime(a), right = resetTime(b);
  return (left === right ? 0 : left - right) || a.id.localeCompare(b.id);
};
```

Add one behavioral regression case with the existing Node test imports (`test`, strict `assert`) and updated account input type:

```ts
test("keeps exhausted incumbent when no successor qualifies", () => {
  const plan = computeRotationPlan([{
    id: "https://router.example:::old", isActive: true,
    sessionPercentage: 10, weeklyPercentage: 0, resetAt: null,
    quotaAvailable: true, thresholdPercentage: 15,
  }], { allEndpointsReadable: true });
  assert.deepEqual(plan.activeIds, ["https://router.example:::old"]);
  assert.deepEqual(plan.activations, []);
  assert.deepEqual(plan.deactivations, []);
});
```

History persistence failure must abort new activation before any remote write. Confirmed deactivation ends a tenure; an uncertain mutation never ends one. Inject threshold sampling in rotator dependencies for deterministic 10/20 boundary and restart tests, using native `crypto.randomInt(10, 21)` in production. Tests must assert mutation order and resulting remote state, not implementation text.

- [ ] **Step 1: Add failing pure-plan tests** for one healthy active account, threshold-triggered replacement, deterministic reset-time selection, no replacement preservation, multiple-active convergence, empty-state activation, and unread-endpoint activation suppression.
- [ ] **Step 2: Run `node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts` and verify failures describe old proxy contract or missing account-only behavior.
- [ ] **Step 3: Implement the smallest account-only plan:** retain healthy active account above persisted threshold; choose replacement only when quota is fresh, finite, available, `>20`, and error-free; order reset time then endpoint-qualified ID; preserve exhausted account if no replacement; return degraded state for unread endpoints.
- [ ] **Step 4: Add threshold sampling/persistence:** integer sample `[10,20]`; persist before activation; reuse through restart, force, and no-successor cycles; resample only after confirmed deactivation.
- [ ] **Step 5: Rewrite rotator execution:** fetch endpoints with `Promise.allSettled`, qualify IDs, confirm replacement enabled before old deactivation, retain old account on failure, reconcile extra active accounts, and remove all proxy reads/writes/repair calls.
- [ ] **Step 6: Run the focused rotation tests and verify PASS.**
- [ ] **Step 7: Integration checkpoint:** retain Task 1 changes; commit together with Tasks 2–4 after caller migration and focused checks.

---

### Task 2: Remove proxy settings and server orchestration

**Files:**
- Modify: `src/server/app-config.ts`
- Modify: `data/settings.json`
- Modify: `.env.example`
- Modify: `src/server/unified-sync-coordinator.ts`
- Modify: `src/server/server.ts`
- Modify: `src/server/api/routes/antigravity.ts`
- Modify: `src/server/api/types.ts`
- Modify: `src/server/api/app.ts`
- Modify: `src/server/nine-router-client.ts`, `src/server/api/routes/ninerouter.ts`
- Delete: `src/server/api/routes/proxies.ts`
- Delete: `src/server/pool-ranker.ts`
- Delete: `src/server/proxy-intelligence-repository.ts`
- Delete: `src/server/proxy-intelligence-db.ts`
- Delete: `src/server/proxy-check-handler.ts`
- Delete: `src/server/proxy-core.ts`
- Delete: `src/server/antigravity-repair.ts`
- Delete: `src/server/antigravity-ownership.ts`
- Delete: `src/server/antigravity-observation.ts`
- Delete: `src/server/google-code-audit.ts`
- Test: `tests/app-config.test.ts`, `tests/unified-sync-coordinator.test.ts`, `tests/antigravity-server-api.test.ts`, related API contract tests

**Interfaces:**
- `createUnifiedSyncCoordinator` consumes only account rotator and retained maintenance dependencies; no pool ranker or intelligence repository.
- Antigravity routes retain quota/account operations but remove `/reset-proxies`, route repair, ownership, and proxy endpoint validation.
- Settings public/private types expose only retained settings; no removed proxy keys or active-limit key.

- [ ] **Step 1: Add/update failing settings and server contract assertions** for removed keys/routes/dependencies, including a seeded settings file containing every removed key.
- [ ] **Step 2: Run focused settings/coordinator/API tests and capture expected failures.**
- [ ] **Step 3: Remove proxy settings, normalization, env synchronization, scheduled pool sync, Google proxy audit, and proxy server handlers.
- [ ] **Step 4: Reduce unified sync to rotation plus retained backup/maintenance behavior without introducing a second scheduler.
- [ ] **Step 5: Remove proxy-only modules and repair/ownership/observation imports; preserve node transport module.
- [ ] **Step 6: Remove pool CRUD/test helpers and forwarding routes from router client/API, preserving account discovery/update/usage, token telemetry, authentication and `ninerouter-node-proxy.ts` transport. Raw connection payload may contain legacy provider data; rotator/UI must not interpret bindings.
- [ ] **Step 7: Integration checkpoint:** run focused migrated server tests; defer global typecheck and commit until Task 4 resolves consumers.

---

### Task 3: Remove proxy database and persistence surfaces

**Files:**
- Delete: `src/db/proxies/schema.ts`
- Delete: `src/db/proxies/client.ts`
- Delete: `src/db/migrations/proxies/0000_baseline.sql`
- Delete: `src/db/migrations/proxies/meta/0000_snapshot.json`
- Delete: `src/db/migrations/proxies/meta/_journal.json`
- Modify: `src/db/common/migrate.ts`
- Modify: `src/db/common/client.ts`
- Modify: `src/db/sync/schema.ts`
- Modify: `src/server/backup/backup-service.ts`
- Modify: `scripts/db-preflight.ts`, `scripts/db-verify.ts`, `scripts/backup-sync.ts`
- Test: `tests/db-clients.test.ts`, `tests/db-preflight.test.ts`, `tests/drizzle-migration-regression.test.ts`, backup tests

**Interfaces:**
- Retained DB startup opens only databases needed by account rotation, router sync that remains, telemetry, activity, and backup.
- Backup manifests no longer require proxy database files; existing old files are tolerated as unowned legacy data and never deleted automatically.

- [ ] **Step 1: Update DB/backup tests** to assert no proxy schema is required, threshold history survives close/reopen, and legacy proxy files are not deleted.
- [ ] **Step 2: Run focused DB and backup tests to verify old assumptions fail.
- [ ] **Step 3: Remove proxy schema/client/migration registration and proxy-only backup/preflight entries; add only forward migration for retained rotation history.
- [ ] **Step 4: Run focused DB/backup tests. Preserve existing on-disk SQLite files and retained-domain migration integrity; new databases must not create proxy-only tables. Do not destructively edit an already-applied retained database baseline.
- [ ] **Step 5: Integration checkpoint:** retain Task 3 changes until Task 4 completes caller migration.

---

### Task 4: Remove proxy UI, API clients, and retained proxy copy

**Files:**
- Delete: `src/app/(dashboard)/proxies/page.tsx`
- Delete: `src/app/(dashboard)/bindings/page.tsx`
- Delete: `src/components/proxies/`
- Delete: `src/components/ninerouter/proxy-pools-table.tsx`
- Delete: `src/components/ninerouter/binding-picker-dialog.tsx`
- Delete: `src/components/ninerouter/binding-context-bar.tsx`
- Delete: `src/components/ninerouter/account-bindings-table.tsx`, `src/components/proxy-detail-drawer.tsx`
- Rename/refactor: `src/components/account-proxy-status-card.tsx` to `src/components/account-status-card.tsx`, export `AccountStatusCard`, migrate dashboard callers via language-server references, retaining account quota functionality.
- Modify: `src/components/app-sidebar.tsx`, `src/components/command-palette.tsx`, `src/components/antigravity-quota-widget.tsx`, `src/app/(dashboard)/page.tsx`
- Modify: `src/app/(dashboard)/settings/page.tsx`, `src/app/(dashboard)/help/page.tsx`, `src/app/auth/page.tsx`, `src/app/auth/layout.tsx`, `src/app/layout.tsx`, `src/components/dashboard-shell.css`, `src/components/topbar.tsx`
- Modify: `src/lib/api.ts`, `src/lib/types.ts`, `src/lib/utils.ts`, `src/mocks/fixtures.ts`, `src/mocks/handlers.ts`; delete `src/lib/proxy-binding-state.ts`, `src/lib/proxy-intelligence-api.ts`, `src/lib/proxy-parser.ts`, `src/lib/proxy-url-state.ts` after migrating retained callers.
- Test: dashboard, sidebar, quota UX, settings UX, API/UI contract tests

**Interfaces:**
- Dashboard account quota UI consumes account state without proxy fields.
- Navigation has no `/proxies` or `/bindings` item.
- Settings renders only retained account rotation and application settings.

- [ ] **Step 1: Update UI contract tests to assert account-only quota presentation, no proxy navigation, no removed settings, and no proxy API calls.
- [ ] **Step 2: Run focused UI contract tests and verify failures against old proxy surfaces.
- [ ] **Step 3: Delete proxy pages/components and remove imports/API methods/types; simplify retained account table/widget.
- [ ] **Step 4: Remove proxy wording, export controls, pool commands, and proxy-only CSS while preserving shadcn layout and accessibility.
- [ ] **Step 5: Run focused UI tests and `npm run typecheck`.
- [ ] **Step 6: Commit Tasks 1–4 atomically after focused tests/typecheck pass:** `refactor: replace proxy management with single-account rotation`.

---

### Task 5: Delete proxy scripts, skills, tests, and historical plans/specs

**Files:**
- Delete: `.agents/skills/telegram-proxy-refresh/`
- Delete: `scripts/fleet-capacity-benchmark.mjs`, `scripts/test-proxies-low-bandwidth.mjs`, `scripts/proxy-operations-smoke.mjs`
- Delete: proxy-only tests including `telegram-proxy-refresh.test.ts`, proxy intelligence, proxy binding, pool ranker, proxy import/export/audit, proxy lifecycle, proxy split-brain, and reset-proxy tests
- Delete: proxy-only files under `docs/superpowers/plans/` and `docs/superpowers/specs/`

Deletion inventory: remove old proxy-only plan/spec pairs for Telegram refresh, token-analysis proxy autobind, proxy bindings UX, Google proxy safety/rebind, ninerouter-wrapper proxy management, proxy operations console, proxyfleet, proxy intelligence, proxy auditor dashboard, proxy safety auditor, proxy testing lifecycle, and unified-proxies donut workspace. Inspect old Antigravity rotation design/plan and remove obsolete proxy-bound design. Keep this `2026-11-24` plan and approved spec; never wildcard-delete documents based only on `proxy` in filename. Mixed fleet/telemetry docs retain non-proxy content only.
- Modify: `README.md`, `PRODUCT.md`, `DESIGN.md`, `Dockerfile`, `docker-compose.yml`, `deploy/pi/install.sh`, `deploy/pi/deploy.sh`, `.gitignore`, package scripts if proxy-only commands exist

**Interfaces:**
- Retained documentation describes direct account quota rotation and retained 9Router node transport, not proxy operations.
- No package script, deploy file, skill loader directory, test, plan, or spec references deleted proxy modules.

- [ ] **Step 1: Enumerate proxy-only files by imports/content and classify mixed files before deletion; do not delete retained router/node docs.
- [ ] **Step 2: Delete proxy-only skills, scripts, tests, and historical plans/specs; remove only proxy sections from mixed docs.
- [ ] **Step 3: Update README/product/design/deploy/env metadata and package scripts to retained scope.
- [ ] **Step 4: Run repository-wide search for `proxy`, `proxies`, `proxyPoolId`, `poolRanker`, and removed module names; resolve every retained-code hit or document intentional legacy-data references.
- [ ] **Step 5: Run `npm run lint` and `npm run format:check`; commit `docs: remove obsolete proxy materials`.

---

### Task 6: Add and execute temporary live unbind migration

**Files:**
- Create: `scripts/unbind-antigravity-proxies.ts`
- Test: `tests/unbind-antigravity-proxies.test.ts`

**Interfaces:**
- Export `planUnbind(connections: NineRouterConnectionItem[]): Array<{ id: string; providerSpecificData: Record<string, unknown> }>`; copy only connections owning `proxyPoolId`, preserve other data, delete that key.
- Export `applyUnbind(options: { dryRun: boolean; routerUrls: string[]; listConnections: typeof listAntigravityConnections; updateConnection: typeof updateConnection }): Promise<{ scanned: number; changed: number; skipped: number; failed: number }>`; pass endpoint URL overrides, write sequentially, continue individual failures. CLI exits non-zero if `failed > 0`. Default and `--dry-run` are read-only; require `--apply` for writes and reject unknown/conflicting flags before network access.

Binding transform implementation (this is the temporary command only, not retained runtime):

```ts
export function planUnbind(connections: NineRouterConnectionItem[]) {
  return connections.flatMap((connection) => {
    const data = connection.providerSpecificData;
    if (!data || !Object.hasOwn(data, "proxyPoolId")) return [];
    const providerSpecificData = { ...data };
    delete providerSpecificData.proxyPoolId;
    return [{ id: connection.id, providerSpecificData }];
  });
}
```

Migration test must use a connection containing `{ proxyPoolId: "P1", retained: "value" }`, assert exactly `{ retained: "value" }` is sent in the update, and assert original input remains unchanged. Dry-run must produce zero update calls. Endpoint list failures count as failures, not zero-account success. Capture pool inventory through a temporary read-only operation before deleting pool-client helpers, or through 9Router UI; never restore pool management API to retained application for migration verification.

- [ ] **Step 1: Write tests for dry-run no writes, preserving unrelated provider fields, skipping unbound accounts, summarizing partial failures, and never invoking pool deletion.
- [ ] **Step 2: Run `node --import tsx --test tests/unbind-antigravity-proxies.test.ts` and verify failure.
- [ ] **Step 3: Implement the CLI with explicit dry-run default safety, endpoint-qualified output, bounded writes, and non-zero partial-failure exit.
- [ ] **Step 4: Run the migration test and `npm run typecheck`.
- [ ] **Step 5: Run `node --import tsx scripts/unbind-antigravity-proxies.ts --dry-run` against configured endpoints; inspect output without applying writes.
- [ ] **Step 6: After Task 7 verification, deploy the account-only release via repository Pi deployment skill, keeping one app instance active. Run dry-run then explicit `--apply` only after old rebinding process stops. Read back all connections to verify bindings absent and other provider data unchanged; compare router pool IDs/count before/after to prove pools untouched. Record failed endpoints/writes; partial success is not completion.
- [ ] **Step 7: Delete temporary script/test only after verified live migration, then selectively commit `chore: remove completed proxy unbind migration`. If live access is unavailable, retain working tooling and report live execution blocked, not done.

---

### Task 7: Full verification and final cleanup

**Files:**
- Modify: any retained files found by verification; no new compatibility layer
- Test: all retained `tests/**/*.test.ts`

- [ ] **Step 1: Run `npm run typecheck`.
- [ ] **Step 2: Run `npm run lint` and `npm run format:check`.
- [ ] **Runtime proof:** launch against isolated test data/controlled router fixture and observe activation confirmation before deactivation plus old-account retention on activation failure. Open dashboard/settings in browser; verify threshold/telemetry availability and removed controls/navigation. Never start a second live app against shared accounts. Use runtime helpers, not source-text assertions.
- [ ] **Step 3: Run `npm test`.
- [ ] **Step 4: Run `npm run build`.
- [ ] **Step 5: Search retained source/config/docs for proxy runtime references and verify only intentional historical/legacy-data notes remain.
- [ ] **Step 6: Verify acceptance criteria: one steady-state account, safe no-successor behavior, no scheduled proxy work, no proxy assignment creation, live pools untouched, obsolete proxy-only plans/specs absent.
- [ ] **Step 7: Commit final corrections as focused commits; do not squash unrelated user changes.

## Implementation recipes and review coverage

Task 2: whitelist retained settings at read/write boundaries rather than spreading stale persisted keys. Preserve credentials without printing them. Seed removed keys in settings fixture, save, and assert keys absent while rotation enable/interval remain. Removed mutation routes must not fall through to another side-effecting handler.

Task 3: exercise isolated real SQLite upgrade, close/reopen pending threshold state, confirm activation twice and assert one turn increment. Assert legacy proxy file byte-for-byte unchanged after startup and backup. Normalize restored settings through the same retained-key whitelist.

Task 4: reuse existing shadcn account table. Display persisted active threshold and explicitly unavailable quota, never fake `0%`. Rename imports through language-server actions. Delete incidental source-text/wording tests instead of pinning new copy. Verify actual dashboard/settings browser surface.

Focused integration checks:

```sh
node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts
node --import tsx --test tests/app-config.test.ts tests/unified-sync-coordinator.test.ts tests/antigravity-server-api.test.ts
node --import tsx --test tests/db-clients.test.ts tests/db-preflight.test.ts tests/backup-service.test.ts
```

Execution order: Tasks 1–4 integrated cutover; Task 5 cleanup; Task 6 Steps 1–4 migration readiness; Task 7 local checks/runtime proof; Task 6 Steps 5–7 live dry-run, deploy/apply, read-back and command removal. Plan authoring authorizes no deployment/live writes.

Spec coverage review: Task 1 covers selection, handoff, random threshold, endpoint safety and no-successor retention; Tasks 1/3 cover restart persistence; Task 2 covers settings/routes/scheduler; Task 3 covers DB/backup preservation; Task 4 covers UI/API cleanup; Task 5 covers obsolete scripts/skills/tests/plans/specs; Task 6 covers unbind without pool deletion; Task 7 covers automated and actual browser/runtime verification. No requirements left unmapped. Temporary migration removal occurs only after verified live success.
