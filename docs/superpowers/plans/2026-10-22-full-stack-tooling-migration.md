# Full-Stack Tooling Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace native API dispatch, raw SQLite access, ESLint-only tooling, placeholder MSW setup, and import-only Axe checks with Hono, Drizzle, Biome, MSW, and authenticated Axe scans while preserving product behavior.

**Architecture:** Keep one Node HTTP server and one port. Next continues to serve pages/assets/HMR and native code continues to serve installer/binary routes; Hono becomes the sole `/api/*` dispatcher. Drizzle becomes the sole runtime SQLite layer over the existing three database files, with preflight backups and explicit migrations. Biome, MSW, and Axe are cut over only after their complete scopes pass.

**Tech Stack:** Node.js >=22, Next.js 16.2.12, React 19.2.8, TypeScript strict, Hono 4, Drizzle ORM 0.45.4, better-sqlite3 13, Biome 2.6.2, MSW 3, Playwright 1.63, axe-core 4.14.

**Spec:** `docs/superpowers/specs/2026-10-22-full-stack-tooling-migration-design.md`

## Global Constraints

- Runtime is Node.js `>=22.0.0`.
- Keep one HTTP server, one port, one process, and no duplicate API fallback in the final code.
- Preserve existing URL, method, status, response JSON, cookies, auth compatibility, body limits, scheduler, HMR, installer, binary, proxy, fleet, and rotation behavior.
- Use stable `drizzle-orm/better-sqlite3`; never import `drizzle-orm/node-sqlite` or use the Drizzle 1.0 release candidate.
- Use the existing three SQLite files under `APP_DATA_DIR`; never create `dev.db` or reset production data.
- Never run `drizzle-kit push` against live data.
- Do not copy a live WAL database with `copyFileSync`; use `VACUUM INTO` after stopping writers.
- Keep double-quoted strings and avoid repository-wide style-only rewrites.
- MSW must never start in production. Browser mocking is opt-in in development.
- Axe scans must use the real running app and real authentication; no permanent exclusions or severity waivers.
- Every task ends with its own targeted check. The final task runs affected full test modules, the complete suite, build, typecheck, Biome, and runtime smoke checks.

---

## File and boundary map

### Database boundary

- `src/db/common/sqlite.ts`: private connection bootstrap and schema-generic `SqliteClient` contract; WAL/foreign keys/busy timeout/lock retries and close ownership.
- `src/db/proxies/schema.ts`, `src/db/proxies/client.ts`: proxy intelligence tables, typed DB, migration entrypoint.
- `src/db/fleet/schema.ts`, `src/db/fleet/client.ts`: fleet tables, typed DB, migration entrypoint.
- `src/db/rotation/schema.ts`, `src/db/rotation/client.ts`: rotation history tables, typed DB, migration entrypoint.
- `src/db/migrations/*.sql`: baseline and forward migrations, one directory per database.
- Existing repository files under `src/server/` and `src/proxyfleet/`: retain public service/repository interfaces while replacing internal SQL connection/query code.

### API boundary

- `src/server/api/types.ts`: `ApiDependencies` and shared route types.
- `src/server/api/app.ts`: `createApiApp(deps): Hono` and shared error/not-found behavior.
- `src/server/api/middleware/auth.ts`: auth middleware using existing `requireDashboardAuth` and request adapter.
- `src/server/api/middleware/body-limit.ts`: bounded JSON parsing for 10,000-byte login, 1,000,000-byte general, 5,000,000-byte intelligence import/preview, and 65,536-byte fleet agent runtime bodies. These are decimal byte counts, not KiB.
- `src/server/api/routes/{auth,fleet,ninerouter,antigravity,settings,intelligence,proxies}.ts`: one registration function per existing namespace.
- `src/server/server.ts`: startup/dependency construction, Next/native routes, Hono listener delegation, scheduler, upgrade/HMR, shutdown; remove old `/api` branch after cutover.

### Tooling/test boundary

- `biome.json`, `package.json`, `eslint.config.mjs`: final formatter/linter migration.
- `src/mocks/handlers.ts`, `src/mocks/node.ts`, `src/mocks/browser.ts`, `public/mockServiceWorker.js`: MSW runtime boundaries.
- `tests/msw/*.test.ts`: Node and browser mock behavior.
- `tests/a11y/dashboard.spec.ts`, `tests/helpers/isolated-server.ts`, `.github/workflows/quality.yml`: authenticated Axe gate using installed node:test/Playwright.
- `tests/*`: existing API, DB, lifecycle, fleet, proxy, and auth tests remain the regression suite.

---

## Task 1: Capture database preflight and migration verification

**Files:**
- Create: `scripts/db-preflight.ts`
- Create: `scripts/db-verify.ts`
- Create: `tests/db-preflight.test.ts`
- Modify: `package.json` scripts
- Modify: `.gitignore` only if generated backup/report paths are not already ignored
- Create: `src/db/common/maintenance-lease.ts`; modify `src/server/server.ts` and `scripts/test-proxies-low-bandwidth.mjs` to coordinate the same resolved data directory before opening connections.

**Interfaces:**
- Produces `db:preflight -- <data-dir> <backup-dir>` via `preflightAndBackupDatabase(sourcePath: string, backupPath: string): void`; throws `DatabasePreflightError` on missing source, existing destination, failed quiescence verification, failed backup, or schema inspection.
- Produces `db:verify -- <before-dir> <after-dir>` via `inspectDatabase(filePath: string): DatabaseInspection`. Compare ordered schema metadata and deterministic row digests per application table. Exclude only the explicitly named new migration journal, and report each expected schema delta; file sizes and connection-scoped PRAGMAs are reported, not asserted byte-identical.

- [ ] **Step 1: Write failing preflight tests**

Create temp SQLite files with a sentinel table and row, back up, inspect matching schema/row digests, and reject an existing destination. Hold a real write transaction in a separate connection for the busy-path test; never fake a writer with a boolean option.

```ts
preflightAndBackupDatabase(sourcePath, backupPath);
assert.deepEqual(inspectDatabase(backupPath).tables, inspectDatabase(sourcePath).tables);
assert.throws(() => preflightAndBackupDatabase(sourcePath, backupPath), /destination exists/i);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --import tsx --test tests/db-preflight.test.ts
```

Expected: new imports fail before implementation. After implementation these tests prove WAL-consistent backup and refusal to overwrite; missing-file and locked-writer cases must leave the source untouched.

- [ ] **Step 3: Implement consistent SQLite backup and inspection**

Use `VACUUM INTO` with an absent destination and safe path quoting; never unlink a pre-existing backup. A successful `BEGIN IMMEDIATE; ROLLBACK;` proves only absence of a current write transaction, NOT that a server is stopped. Integrate an exclusive data-directory maintenance lease shared with server bootstrap and operational scripts; acquire it before opening any app DB and hold it through backup/migration. For the first deployment from the pre-lease revision, explicitly stop known server/writers using OS process evidence and refuse when quiescence cannot be established. Never claim SQLite lock probing detects an idle live process.

- [ ] **Step 4: Add CLI scripts and package commands**

Add:

```json
"db:preflight": "node --import tsx scripts/db-preflight.ts",
"db:verify": "node --import tsx scripts/db-verify.ts"
```

The CLI must print source, backup, metadata counts, and a clear failure reason; it must never print passwords or full credential rows.

- [ ] **Step 5: Run the focused test and verify pass**

Run the test again and assert the backup and comparison paths pass. Commit only this task:

```bash
git add scripts/db-preflight.ts scripts/db-verify.ts tests/db-preflight.test.ts package.json .gitignore
git commit -m "chore(db): add safe preflight verification"
```

---

## Task 2: Define Drizzle schemas and clients for all three databases

**Files:**
- Create: `src/db/common/sqlite.ts`
- Create: `src/db/proxies/schema.ts`, `src/db/proxies/client.ts`
- Create: `src/db/fleet/schema.ts`, `src/db/fleet/client.ts`
- Create: `src/db/rotation/schema.ts`, `src/db/rotation/client.ts`
- Create: `tests/db-clients.test.ts`
- Modify: `package.json` only if client code needs an explicit migration script

**Interfaces:**

```ts
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
export interface SqliteClient<TSchema extends Record<string, unknown>> {
  db: BetterSQLite3Database<TSchema>;
  close(): void;
}
// Each declaration lives beside an import * as schema from "./schema.js".
export function openProxyDb(filePath: string): SqliteClient<typeof schema>;
export function openFleetDb(filePath: string): SqliteClient<typeof schema>;
export function openRotationDb(filePath: string): SqliteClient<typeof schema>;
```

Domain schemas keep their exact inferred types; raw connections remain private to bootstrap/migration code, never exposed as a repository SQL escape hatch. Accept absolute file paths and `:memory:` explicitly, create parent directories only for files, keep 3000 ms timeout and close semantics. Rotation also preserves `synchronous = NORMAL`.

- [ ] **Step 1: Inventory exact current schemas before writing definitions**

Read the existing `CREATE TABLE`, `ALTER TABLE`, index, and foreign-key statements in `src/server/proxy-intelligence-db.ts`, `src/proxyfleet/db.ts`, `src/proxyfleet/runtime-store.ts`, and `src/server/antigravity-rotation-history.ts`. Record every table, column, nullability, default, key, index, and legacy column in the plan task notes or migration files. Do not infer names from the sample `items` table.

- [ ] **Step 2: Write failing client/schema contract tests**

Open each client against a temporary file, assert the file path is the requested path, execute the existing migration entrypoint on it, and compare `PRAGMA` metadata against the recorded schema inventory. Assert `close()` releases the file so a second connection can open it.

- [ ] **Step 3: Implement `openSqlite` and domain clients**

Use `better-sqlite3` and `drizzle-orm/better-sqlite3`. Configure:

```ts
const raw = new Database(filePath, { timeout: 3000 });
raw.pragma("journal_mode = WAL");
raw.pragma("foreign_keys = ON");
const db = drizzle(raw, { schema });
```

Keep retry behavior for transient SQLite lock errors in one bootstrap helper. Do not put application data in a fixed relative path.

- [ ] **Step 4: Implement exact schema definitions**

Use `sqliteTable`, `text`, `integer`, `real`, `blob`, `primaryKey`, `foreignKey`, and indexes matching existing metadata. Preserve `INTEGER PRIMARY KEY AUTOINCREMENT`, text IDs, nullable fields, defaults, and cascade actions exactly.

- [ ] **Step 5: Run the focused client tests**

Run:

```bash
node --import tsx --test tests/db-clients.test.ts
npm run typecheck
```

Expected: all client metadata assertions pass and typecheck remains clean. Commit the task:

```bash
git add src/db tests/db-clients.test.ts package.json
git commit -m "refactor(db): define typed sqlite clients"
```

---

## Task 3: Convert migrations and repositories without changing public interfaces

**Files:**
- Create: `src/db/migrations/proxies/0000_baseline.sql`
- Create: `src/db/migrations/fleet/0000_baseline.sql`
- Create: `src/db/migrations/rotation/0000_baseline.sql`
- Create: forward migration files for every existing legacy-column upgrade
- Create: `src/db/migrate.ts`
- Modify: `src/server/proxy-intelligence-db.ts`
- Modify: `src/proxyfleet/db.ts`
- Modify: `src/proxyfleet/runtime-store.ts`
- Modify: `src/server/antigravity-rotation-history.ts`
- Modify: `src/server/proxy-intelligence-repository.ts`, `src/server/proxy-check-handler.ts`, `scripts/test-proxies-low-bandwidth.mjs`, all DB consumers and related tests; add `tests/drizzle-migration-regression.test.ts`
- Delete after callers migrate: `src/db/index.ts`, `src/db/schema.ts`, `tests/drizzle-smoke.test.ts`, `dev.db` if created and untracked
- Remove in Task 6: Prisma files/dependencies. Modify `drizzle.config.ts` into separate per-database configurations and retain `drizzle-kit` with generated journals/snapshots per domain.

**Interfaces:**
- Preserve `FleetRepository`, `AntigravityRotationHistory`, `ProxyIntelligenceRepository` service behavior and return values; preserve `createFleetRepository({ sqlitePath })` and `openAntigravityRotationHistory(dataDir)` call signatures.
- Retire `ProxyIntelligenceDb.exec/all/get/run/transaction`. Move raw-SQL consumers to typed `openProxyDb(...).db`, update repository construction and tests together, and remove the obsolete facade after cutover.
- Domain client factories own migration execution before exposing the typed database; migration modules accept the exact schema-specific `BetterSQLite3Database<typeof schema>`. No undefined `DrizzleDatabase` or generic-empty-schema alias.

- [ ] **Step 1: Add regression tests against existing and legacy schemas**

Extend existing tests on empty, populated and legacy files. A concrete persistence regression uses existing public rotation methods:

```ts
let history = openAntigravityRotationHistory(dataDir);
history.recordActivation("account-a", 1234);
history.close();
history = openAntigravityRotationHistory(dataDir);
try {
  assert.deepEqual(history.get("account-a"), {
    accountId: "account-a", turnCount: 1, lastActivatedAt: 1234,
  });
} finally { history.close(); }
```

Use the existing legacy fixtures in the full fleet/proxy migration modules. Preserve desired-revision backfills, deleted/tombstoned records, encrypted credentials, composite keys, audit history and foreign keys. Prove rollback using an actual unique/FK failure midway through enrollment/import, not a fabricated `runFailingTransaction` helper.

- [ ] **Step 2: Run the full affected DB modules and verify failure**

Run:

```bash
node --import tsx --test tests/proxy-intelligence-db.test.ts tests/proxy-intelligence-migration.test.ts tests/proxy-intelligence-migration-regression.test.ts tests/fleet-db.test.ts tests/fleet-state-safety.test.ts tests/fleet-runtime-store.test.ts tests/antigravity-rotation-history.test.ts tests/drizzle-migration-regression.test.ts
```

Expected: new Drizzle migration regression tests fail until migration and repository adapters are implemented.

- [ ] **Step 3: Generate baseline SQL from verified current metadata**

Generate per-domain baseline/journal/snapshots with the installed Drizzle Kit. Fresh DBs apply the baseline; recognized current DBs verify all tables/columns/indexes/FKs before recording it. Recognized legacy DBs first execute the exact idempotent upgrade/backfill operations from old migrations, then verify and record the baseline atomically. Unknown schema or checksum mismatch fails before mutation. `user_version = 0` alone never identifies a fresh DB. Never feed current baseline CREATE statements blindly into a populated file.

- [ ] **Step 4: Convert legacy upgrades to idempotent forward migrations**

Replace each inline `PRAGMA table_info`/`ALTER TABLE` path with a named migration that checks column existence and applies only the missing change. Keep existing default values and legacy data backfill semantics. Leave WAL, foreign keys, timeout, and retries in client bootstrap.

- [ ] **Step 5: Replace repository internals with typed Drizzle queries**

Replace repository internals with typed Drizzle queries, including all direct SQL in `proxy-intelligence-repository.ts`, `proxy-check-handler.ts`, fleet runtime store and the low-bandwidth operational script. Preserve ordering, pagination, SQL null semantics, booleans/integers, credential encryption and transaction modes. Preserve `BEGIN IMMEDIATE` behavior using Drizzle transaction configuration and nested savepoints; never emulate a typed ORM with a raw SQL passthrough.

- [ ] **Step 6: Add startup migration sequencing**

Migrate all three domain clients before exposing them to services; integrate data-directory lease before DB opening. Preserve `fleetReady`, rotation initialization and shutdown ownership. Fail startup on unknown schema; never create `dev.db` or restore data automatically.

- [ ] **Step 7: Run all affected DB modules and verify pass**

Run the command from Step 2, then run `npm run typecheck`. Compare before/after metadata and sentinel rows using `npm run db:verify`. Commit:

```bash
git add src/db src/server/proxy-intelligence-db.ts src/proxyfleet/db.ts src/proxyfleet/runtime-store.ts src/server/antigravity-rotation-history.ts tests
git commit -m "refactor(db): migrate sqlite repositories to drizzle"
```

---

## Task 4: Build Hono API modules around existing services

**Files:**
- Create: `src/server/api/types.ts`
- Create: `src/server/api/middleware/auth.ts`
- Create: `src/server/api/middleware/body-limit.ts`
- Create: `src/server/api/app.ts`
- Create: `src/server/api/routes/auth.ts`
- Create: `src/server/api/routes/fleet.ts`
- Create: `src/server/api/routes/ninerouter.ts`
- Create: `src/server/api/routes/antigravity.ts`
- Create: `src/server/api/routes/settings.ts`
- Create: `src/server/api/routes/intelligence.ts`
- Create: `src/server/api/routes/proxies.ts`
- Create: `tests/hono-api-contract.test.ts`
- Modify/migrate: `src/proxyfleet/api-router.ts`, `src/proxyfleet/runtime-api.ts`, `src/server/proxy-check-handler.ts` and every test importing their native handler factories. Remove obsolete native handler exports after all callers move.
- Modify: existing API contract tests only when changing the transport harness, never expected product responses
- Delete after cutover: `src/server/app.ts`, `tests/hono-smoke.test.ts`

**Interfaces:** Define `ApiDependencies` from existing exported service interfaces and concrete factories. Keep route modules dependent on narrow fields, not entire modules or native request handlers:

```ts
export interface ApiDependencies {
  verifyControlPassword: typeof verifyControlPassword;
  proxyIntelligenceRepo: ProxyIntelligenceRepository;
  fleetRepo: FleetRepository;
  poolRanker: ReturnType<typeof createPoolRanker>;
  antigravityRotator: ReturnType<typeof createAntigravityRotator>;
  unifiedSyncCoordinator: UnifiedSyncCoordinator;
  fleetWireguard: FleetRuntimeApiDependencies["getWireguard"];
  nodeRemovalService: NodeRemovalService;
  enrollmentService: EnrollmentService;
  provisioningService: ProvisioningService;
  router: {
    testNineRouterConnection: typeof testNineRouterConnection;
    listPools: typeof listPools;
    testPool: typeof testPool;
    setPoolActive: typeof setPoolActive;
    updatePool: typeof updatePool;
    deletePool: typeof deletePool;
    createPool: typeof createPool;
    listAntigravityConnections: typeof listAntigravityConnections;
    getAccountUsage: typeof getAccountUsage;
    updateConnection: typeof updateConnection;
    clearNineRouterSession: typeof clearNineRouterSession;
    nineRouterConfigured: typeof nineRouterConfigured;
  };
  settings: {
    getSettingsPublic: typeof getSettingsPublic;
    getSettingsSecrets: typeof getSettingsSecrets;
    updateSettings: typeof updateSettings;
  };
}
export function createApiApp(deps: ApiDependencies): Hono<ApiEnv>;
```

Import each named symbol from its actual current module. `ApiEnv` uses `HttpBindings` from `@hono/node-server` for genuine Node metadata. Port `createFleetApiHandler` and `createFleetRuntimeApi` to Hono route registration instead of wrapping native request/response handlers. Do not add an RPC client in this migration: preserve current clients/contracts. Any exported future RPC type must be inferred from chained routes, not a bare Hono annotation.

- [ ] **Step 1: Extract route contract cases from existing tests**

Extract route-by-route method, path, query, auth, response/status/header and body policy. Preserve separate fleet enrollment-token and node-agent-token paths rather than putting dashboard auth before all `/api/fleet/*`. Preserve query-password compatibility only where native `auth()` currently accepts it; settings/intelligence/proxies perform stricter session/header checks. Register specific routes before generic `:id` routes.

- [ ] **Step 2: Write failing Hono contract tests**

Use the real in-process session lifecycle with an isolated app fixture and the exact dependency type above. Do not use an undefined token or send `Set-Cookie` attributes as a `Cookie` request header:

```ts
const session = createSession();
try {
  const response = await api.request("/api/auth/session", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${session.token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true });
} finally {
  revokeSession(`${SESSION_COOKIE_NAME}=${session.token}`);
}
```

- [ ] **Step 3: Implement shared dependency types and request adapters**

Use Hono request/body/response APIs and pass only service inputs to domain functions. Where TLS state is needed use real `HttpBindings`; for request-level tests supply the documented Hono request bindings or test the Node listener. Preserve exact per-route JSON/text/download headers and fleet `Cache-Control: no-store`. Do not route Hono calls back through old native handlers.

- [ ] **Step 4: Implement auth and body-limit middleware**

Reuse session creation/revocation and compatible credential parsing through one typed auth helper. Keep public health/login/logout/session, enrollment-token routes, node-agent bearer routes and dashboard routes distinct. Limits are 10,000 login, 1,000,000 general, 5,000,000 import/preview and 65,536 fleet runtime bytes. Preserve empty-body `{}` and malformed-JSON mappings. Do not normalize distinct `Unauthorized`, `Invalid control password`, `Invalid node credential`, and `not found` strings.

- [ ] **Step 5: Implement each route registration module**

Move each existing pathname block into its Hono module, reusing actual services and repository methods, not legacy `IncomingMessage`/`ServerResponse` dispatch factories. Migrate corresponding tests before removing native handlers. No generic wildcard fallback to old API routing at completion.

- [ ] **Step 6: Add centralized error and 404 handling**

Map known errors to existing status/body shapes. Return the existing JSON 404 response for unknown API paths. Log server-side diagnostics without logging passwords, cookies, proxy credentials, or request bodies containing secrets.

- [ ] **Step 7: Run Hono contract tests and all related API modules**

Run:

```bash
node --import tsx --test tests/hono-api-contract.test.ts tests/api-contract.test.ts tests/antigravity-server-api.test.ts tests/fleet-api.test.ts tests/proxy-management-api.test.ts tests/proxy-unified-api.test.ts tests/proxy-intelligence-export.test.ts
```

Expected: contract tests pass before server integration. Commit:

```bash
git add src/server/api tests/hono-api-contract.test.ts tests
 git commit -m "refactor(api): define hono route modules"
```

---

## Task 5: Mount Hono and remove native API dispatch

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/server/api/app.ts` only for dependency wiring gaps found by contract tests
- Create: `tests/server-api-runtime.test.ts`
- Create: `tests/helpers/isolated-server.ts` now, using the exact contract in Task 9; Tasks 8 and 9 reuse it rather than referring to a future missing helper.
- Delete after full cutover: old `/api` pathname branch from `src/server/server.ts`

**Interfaces:**
- `createApiApp(deps).fetch` is converted to a Node listener with `getRequestListener` from `@hono/node-server`.
- `src/server/server.ts` remains the only owner of `main`, server creation, Next preparation, upgrade/HMR, scheduling, and shutdown.

- [ ] **Step 1: Write a runtime dispatch regression test**

Start the server with an isolated `APP_DATA_DIR` and test port, wait for `/api/health`, then assert installer, binary, Next page, authenticated API, and unknown API behavior. Verify `/_next/webpack-hmr` remains the only upgrade path in development.

- [ ] **Step 2: Run the runtime behavior-preservation smoke**

Run:

```bash
node --import tsx --test tests/server-api-runtime.test.ts
```

This is a behavior-preservation regression, so it may already pass against native routing; do not force it to fail or assert source text/header provenance. Use new Hono contract tests from Task 4 for failing-before coverage and this real server run for unchanged installer/Next/auth/HMR behavior.

- [ ] **Step 3: Wire Hono into the existing server**

After constructing repositories and services, create the Hono app and listener. In the HTTP callback, keep installer and binary checks first, then delegate `/api/*` to the Hono listener, and delegate all other paths to Next. Do not create a second server or call `listen` from Hono.

- [ ] **Step 4: Remove old native API branches**

Delete the old `/api` branch and its duplicate helper dispatch only after all route tests pass. Keep shared service functions that remain used by Hono. Grep every route prefix and ensure exactly one registration remains.

- [ ] **Step 5: Preserve shutdown and scheduler behavior**

Close all Drizzle clients and existing non-DB resources in the existing shutdown path. Keep `fleetReady`, maintenance scheduling, unified sync, and router/account rotator timing unchanged.

- [ ] **Step 6: Run runtime and full affected API tests**

Run the runtime test, all API contract modules, `npm run typecheck`, and the relevant lifecycle tests. Commit:

```bash
git add src/server/server.ts src/server/api tests/server-api-runtime.test.ts
 git commit -m "refactor(api): mount hono in native server"
```

---

## Task 6: Remove Prisma and obsolete database scaffolding

**Files:**
- Delete: `prisma/schema.prisma`
- Delete: `src/lib/prisma.ts`
- Delete: `lib/prisma.ts` if it is not a separate required package boundary
- Delete: `src/db/index.ts`, `src/db/schema.ts`, `tests/drizzle-smoke.test.ts`, and generated `dev.db` if present
- Modify: `scripts/test-prisma.ts` or delete it if grep confirms no supported caller
- Modify: `package.json`, `package-lock.json`
- Modify: any docs that still instruct Prisma usage

**Interfaces:**
- No public runtime interface changes. Every Prisma/reference removal must be verified by repository-wide search.

- [ ] **Step 1: Grep all Prisma and sample DB references**

Run:

```bash
grep -RInE "@prisma|from ['\"]prisma|new PrismaClient|better-sqlite3|dev\.db|drizzle-smoke" src tests scripts lib prisma package.json README.md docs
```

Classify every match as migrated runtime code, test fixture, package metadata, or obsolete scaffolding. Do not delete a caller without migrating it.

- [ ] **Step 2: Remove obsolete files and packages**

Remove only obsolete Prisma/sample code after all callers move. Remove `@prisma/client` and `prisma`; retain `better-sqlite3`, `drizzle-orm`, and `drizzle-kit`, which owns the approved migration-generation workflow. Never delete unrelated existing `dev.db` data without confirming it belongs to the sample.

- [ ] **Step 3: Run consistency checks**

Run the grep command again and assert no runtime Prisma import, fixed `dev.db`, old Drizzle sample, or duplicate native DB client remains. Run `npm run typecheck` and all DB/API tests.

- [ ] **Step 4: Commit cleanup**

```bash
git add package.json package-lock.json prisma src/lib lib scripts README.md docs
 git commit -m "chore(db): remove obsolete prisma scaffolding"
```

---

## Task 7: Replace ESLint with Biome without broad style churn

**Files:**
- Modify: `biome.json`
- Modify: `package.json`
- Delete: `eslint.config.mjs`
- Modify: `.gitignore` for generated Biome/cache output only when the exact path is not already ignored

**Interfaces:**
- `npm run lint` invokes `biome ci .` over the complete intended source/test/script/config scope without modifying files.
- `npm run format:check` invokes `biome format .` without `--write`, so it reports formatting differences without modifying files.
- `npm run format` writes only explicitly supplied files; it must not silently rewrite all source files in CI.

- [ ] **Step 1: Capture current formatting and lint behavior**

Capture diagnostics without rewriting files. Existing tree now contains both single-quoted and double-quoted files, including dashboard layout; preserve concurrent user edits. Apply approved double-quote style in migrated files. Explicit per-file style overrides may preserve established files, but no blanket ignored directories or formatter-disabled escape hatch may hide full-scope check failures.

- [ ] **Step 2: Configure Biome 2.6.2**

Use schema `https://biomejs.dev/schemas/2.6.2/schema.json`, Git ignore integration, two-space indentation, double quotes, semicolons, trailing commas, and explicit includes for src/tests/scripts and root TS/MJS/JSON configs. Ignore generated Next/MSW assets, data/runtime files, binaries and dependencies. Enable Tailwind directive parsing for `src/app/globals.css`; validate installed schema keys rather than deprecated config. Isolate necessary formatting changes from behavior edits.

- [ ] **Step 3: Reconcile rules file-by-file**

Run read-only `npx biome ci .` for full configured scope. Fix real correctness findings and reconcile only named intentional rules. Do not suppress the recommended preset, skip source directories, or hide missing coverage with unmatched-path flags. Format selected files only, never blanket-reformat the repo.

- [ ] **Step 4: Add stable scripts and remove ESLint**

Set:

```json
"lint": "biome ci .",
"format:check": "biome format .",
"format": "biome format --write"
```

Remove ESLint packages/config only after no caller remains. Preserve `lint` as the existing command name for CI compatibility.

- [ ] **Step 5: Verify no broad rewrite**

Run `git diff --stat` and confirm changes are limited to intended migration fixes/config. Run `npm run lint`, `npm run format:check`, and `npm run typecheck`. Commit:

```bash
git add biome.json package.json package-lock.json eslint.config.mjs src tests scripts
 git commit -m "chore(tooling): replace eslint with biome"
```

---

## Task 8: Implement real MSW browser and Node setups

**Files:**
- Modify: `src/mocks/handlers.ts`
- Modify: `src/mocks/node.ts`
- Create: `src/mocks/browser.ts`
- Create: `src/mocks/fixtures.ts`
- Create: `public/mockServiceWorker.js` with `npx msw init public --save`
- Create: `src/mocks/start-browser.ts`
- Create: `tests/msw/node-contract.test.ts`
- Create: `tests/msw/browser-contract.spec.ts`
- Create `src/components/mock-bootstrap.tsx`, mounted in `src/app/layout.tsx` above auth/dashboard. In opt-in development only, await worker readiness before mounting providers/children; production returns children immediately. A late dashboard useEffect misses initial auth/session fetches.
- Delete: `tests/msw-smoke.test.ts` after replacement

**Interfaces:**

```ts
export const handlers: RequestHandler[]; // RequestHandler from "msw"
export const server: ReturnType<typeof setupServer>;
export const worker: ReturnType<typeof setupWorker>;
export async function startBrowserMocks(): Promise<void>;
```

- [ ] **Step 1: Inventory every frontend request**

Grep `src/lib`, `src/app`, and `src/components` for `fetch`, compare each method/path/body/response with the handler list, and create fixtures for auth, health, 9Router, intelligence, settings, fleet, Antigravity, and proxy endpoints used by the UI.

- [ ] **Step 2: Write failing Node MSW contract tests**

Test consumer behavior rather than HTTP fixture echoes: session expiry yields false from `checkSession`, failed import yields the client's error, filtering/pagination return matching records, and handler overrides cannot leak. Unhandled frames fail without internet access. MSW installed version 3.0.3 renamed the option to `onUnhandledFrame`:

```ts
server.listen({ onUnhandledFrame: "error" });
try {
  await assert.rejects(fetch("http://127.0.0.1:1/unhandled"), /./);
} finally {
  server.resetHandlers();
  server.close();
}
```

- [ ] **Step 3: Implement real handlers and Node lifecycle**

Use reusable origin configuration: browser handlers match same-origin API paths; Node handlers use absolute localhost URLs from the same factory. Match app origin only, not arbitrary upstream hosts. Reset fixture state as well as handlers. Use `onUnhandledFrame: "error"` in tests and close in teardown. Currently unsupported frontend calls must retain a 404 contract rather than invent new backend features.

- [ ] **Step 4: Generate and wire browser worker**

Run:

```bash
npx msw init public --save
```

Create `startBrowserMocks` with a hard production guard:

```ts
if (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_ENABLE_API_MOCKS !== "true") return;
if (typeof window === "undefined") return;
const { worker } = await import("./browser");
await worker.start({ onUnhandledFrame: "bypass", serviceWorker: { url: "/mockServiceWorker.js" } });
```

- [ ] **Step 5: Add browser contract coverage**

Use installed `node:test` with `playwright`, not an uninstalled Playwright test runner. Run `node --import tsx --test tests/msw/browser-contract.spec.ts` with separate browser contexts for mock-enabled/real modes. Verify a rendered fixture item, real login outcome when disabled, no initial auth race, and no surviving mock responses after disabling on a controlled page or switching to production. Check visible app behavior, not exports.

- [ ] **Step 6: Verify production guard and commit**

Run Node MSW tests and browser command from Step 5. Add `test:msw-browser` using that exact command. Test production-built app with the mock flag at BUILD time as well as startup, because Next inlines public env variables. Disable mocks in a11y. Remove sample interceptor-echo test after consumer behavior is covered.

```bash
git add src/mocks public/mockServiceWorker.js tests/msw src/app package.json package-lock.json
 git commit -m "test(api): add real msw browser contracts"
```

---

## Task 9: Add authenticated Axe dashboard gate

**Files:**
- Create: `tests/a11y/dashboard.spec.ts`, `.github/workflows/quality.yml`; extend `tests/helpers/isolated-server.ts` from Task 5
- Delete: `tests/axe-smoke.test.ts`
- Modify: `package.json`, `README.md` and only UI files with observed accessibility violations

**Interfaces:** Use installed `node:test`, `playwright` and `@axe-core/playwright`, not uninstalled `@playwright/test`. Share this helper with Task 5 and Task 8 runtime checks:

```ts
export async function startIsolatedServer(options: {
  mode: "development" | "production";
  mockApi: boolean;
}): Promise<{ baseUrl: string; password: string; stop(): Promise<void> }>;
```

- [ ] **Step 1: Build an isolated real server fixture**

Spawn `process.execPath` with `["--import", "tsx", "src/server/server.ts"]` and a free loopback port. Set temp `APP_DATA_DIR` AND `APP_CONFIG_PATH`, explicit `NODE_ENV`, fresh `CONTROL_PASSWORD` and disabled mocks/sync/rotation. Clear upstream credentials and point configured upstream URLs to loopback test endpoints so root `.env` cannot access live routers/fleet. Never reuse a developer process or `.next` server. Production uses the existing `.next-build` build output. Wait with a finite deadline for `/api/health`; print sanitized child logs on startup failure. Register cleanup as soon as each resource is acquired, terminate/wait for the owned process, then remove temp files. `stop()` is idempotent.

- [ ] **Step 2: Implement authenticated route scans**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { startIsolatedServer } from "../helpers/isolated-server.js";

test("dashboard routes have no selected WCAG violations", async (t) => {
  const app = await startIsolatedServer({ mode: "production", mockApi: false });
  t.after(() => app.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ baseURL: app.baseUrl });
  const login = await context.request.post("/api/auth/login", {
    data: { password: app.password },
  });
  assert.equal(login.status(), 200);
  assert.equal((await login.json()).authenticated, true);
  for (const route of [
    "/", "/proxies", "/proxy-endpoints", "/nodes", "/monitoring",
    "/events", "/settings", "/wallet", "/reseller", "/referral",
    "/invoice", "/cdk", "/scraping", "/help",
  ]) {
    const page = await context.newPage();
    try {
      const response = await page.goto(route);
      assert.equal(response?.status(), 200, route);
      await page.locator("main").waitFor({ state: "visible" });
      assert.notEqual(new URL(page.url()).pathname, "/auth", route);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      assert.deepEqual(result.violations, [], `${route}: ${JSON.stringify(result.violations)}`);
    } finally { await page.close(); }
  }
});
```

- [ ] **Step 3: Exercise ready states and fix observed UI violations**

Wait for concrete route data/loading indicators, not polling-sensitive `networkidle`. Include populated/empty/error states, important open dialogs/popovers, dynamic `/nodes/:id` seeded through a real local fixture, and `/help/components`; retain every approved base route. Fix semantics, labels, focusability, contrast and ARIA in existing shadcn UI. Never exclude portals, disable rules or re-pin expected violations. Inspect screenshots of corrected desktop and narrow surfaces. Axe automation alone is not complete WCAG/SEO proof.

- [ ] **Step 4: Run and wire CI**

```json
"test:a11y": "node --import tsx --test tests/a11y/dashboard.spec.ts"
```

Run `npx playwright install chromium`, `npm run build`, then `npm run test:a11y`. Add CI workflow using a supported Node release for the existing native bindings: `npm ci`, Chromium install with OS dependencies, typecheck, full-scope Biome, full Node suite, production build, MSW browser smoke and Axe gate. Do not use `--no-sandbox`, developer servers/data or credentials. Fail on subprocess startup/exit errors and upload only sanitized failure artifacts. Expected: every authenticated scan has zero selected-tag violations. Commit exact helper/test/workflow/UI/script/doc paths only after runtime proof; remove the import-only smoke check.

---

## Task 10: Final consistency audit, regression suite, and documentation

**Files:**
- Modify: `README.md`
- Modify: `.env.example` for `NEXT_PUBLIC_ENABLE_API_MOCKS` only if the variable is documented there
- Modify: `package.json` scripts if final command names differ from the plan
- Modify: `docs/superpowers/specs/2026-10-22-full-stack-tooling-migration-design.md` only to correct verified implementation drift

**Interfaces:**
- Final commands are `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, `npm run test:a11y`, `npm run db:preflight`, and `npm run db:verify`.

- [ ] **Step 1: Audit every old call site and duplicate path**

Run:

```bash
grep -RInE "DatabaseSync|node:sqlite|@prisma|new PrismaClient|dev\.db|eslint|setupServer|setupWorker|/api/(health|auth|fleet|ninerouter|antigravity|settings|intelligence|proxies)" src tests scripts lib prisma package.json README.md docs
```

For each match, verify it is an intentional final implementation, test fixture, generated worker, or documentation reference. Confirm every frontend API caller has one Hono route and one MSW handler where mocking is required.

- [ ] **Step 2: Run affected full modules, not isolated flipped tests**

Run the complete API, auth, DB, fleet, proxy, lifecycle, and rotation modules:

```bash
node --import tsx --test tests/api-contract.test.ts tests/session-auth.test.ts tests/proxy-intelligence-db.test.ts tests/proxy-intelligence-migration.test.ts tests/proxy-intelligence-migration-regression.test.ts tests/fleet-db.test.ts tests/fleet-state-safety.test.ts tests/fleet-runtime-store.test.ts tests/fleet-api.test.ts tests/proxy-management-api.test.ts tests/proxy-unified-api.test.ts tests/antigravity-server-api.test.ts tests/antigravity-rotation-history.test.ts tests/msw/node-contract.test.ts
```

- [ ] **Step 3: Run the complete verification matrix**

Run each command and retain observed output:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:msw-browser
npm run test:a11y
```

Then exercise the real isolated server: health, login, protected API, Next page, installer, binary and shutdown. Observe DB handles being released by reopening files after exit and verify existing scheduler effects through lifecycle tests; do not invent log messages as evidence. Keep generated reports sanitized and outside tracked source.

- [ ] **Step 4: Verify scope and diff**

Run `git diff --stat` and inspect the complete diff. Confirm no broad style-only rewrite, schema reset, API payload change, generated data file, credential, or unrelated product change entered the branch. If a behavior changed, add or update its contract test before completion.

- [ ] **Step 5: Document operations and final commit**

Update README with:

- `npm install` native build prerequisites for `better-sqlite3` on Windows/CI.
- Safe database preflight and verification commands.
- Development MSW flag and production guard.
- Biome lint/format commands.
- Chromium installation and Axe route-gate command.
- Rollback procedure: stop new process, preserve failed DB, restore `VACUUM INTO` backup, redeploy old revision, rerun full suite.

Commit:

```bash
git add README.md .env.example package.json docs
 git commit -m "docs: document migrated tooling operations"
```

## Plan self-review checklist

- [x] All approved decisions map to Tasks 1–10: single-process Hono, three stable-driver Drizzle domains, migration/rollback, Biome replacement, dev/test MSW, authenticated Axe/CI, caller cleanup and final verification.
- [x] Removed incomplete markers, invented writer options, raw-SQL Drizzle facades, unknown API dependency aliases and unsupported Playwright runner commands.
- [x] Cross-checked client/factory signatures and shared helpers. Existing fleet factory is `createFleetRepository({ sqlitePath })`; MSW 3 requires `onUnhandledFrame`; auth body limits preserve exact bytes and fleet exceptions.
- [x] Each behavioral slice specifies consumer-visible regressions and full affected-module checks. Behavior-preservation smoke may pass before migration; do not fabricate failing-before evidence or test implementation provenance.
- [x] No Drizzle RC, live WAL copying, production mocks, permanent Axe exclusions, duplicate server, or legacy routing fallback. Root configs, operational SQL scripts and all direct DB consumers are included.

## Verified API documentation

- MSW 3 migration and renamed options: https://mswjs.io/docs/migrations/2.x-to-3.x
- Hono Node adapter and `HttpBindings`: https://hono.dev/docs/getting-started/nodejs
- Biome read-only CI checks: https://biomejs.dev/recipes/continuous-integration/

