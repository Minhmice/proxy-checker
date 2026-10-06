# Proxy Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gộp quick diagnostics và deep safety audit vào Proxy Intelligence, lưu inventory/audit detail trong SQLite, hỗ trợ filter bulk server-side, audit lại proxy đã lưu, và export proxy hoạt động tốt từ Settings.

**Architecture:** Giữ `data/proxies.sqlite3` làm source of truth, thêm một repository SQLite nhỏ và schema migration idempotent. Quick diagnosis và deep audit dùng cùng inventory nhưng lưu bảng measurement riêng; job manager xử lý proxy keys server-side, ghi snapshot audit bất biến và cập nhật trạng thái tổng hợp transactionally. Một trang Proxy Intelligence dùng API phân trang/filter, thay thế hai UI hiện tại; routes cũ redirect về trang mới.

**Tech Stack:** Node.js >=22, `node:sqlite` built-in, TypeScript/tsx, Node `node:test`, Next 16 custom server, React 19, existing shadcn/Radix UI, TanStack Table.

**Spec:** `docs/superpowers/specs/2026-09-24-proxy-intelligence-design.md`

## Global Constraints

- SQLite `data/proxies.sqlite3` hiện hữu MUST được giữ nguyên; migration MUST additive và idempotent.
- `.txt` MUST chỉ là import/export artifact; runtime inventory MUST đọc từ SQLite.
- Bulk action MUST chỉ chạy trên proxy đã lưu trong SQLite.
- Quick diagnose MUST NOT create `dangerous`; deep audit MUST preserve immutable snapshots.
- Credentials MAY remain plaintext in DB per approved project decision; UI, API responses, logs, and exports MUST redact by default.
- Existing quick 9Router sync semantics MUST NOT change.
- Browser MUST receive paginated/filter results, never the full proxy inventory.
- Use existing shadcn primitives; do not add a custom UI primitive or dependency for an existing capability.
- Every task MUST add behavior-focused tests before implementation and run its focused test before commit.

---

### Task 1: SQLite adapter and additive schema migration

**Files:**
- Create: `src/server/proxy-intelligence-db.ts`
- Create: `tests/proxy-intelligence-db.test.ts`
- Modify: `src/server/server.ts:18-33` to initialize the database before handlers are used
- Modify: `package.json` only if the current TypeScript configuration requires an explicit `node:sqlite` type import adjustment; do not add a SQLite dependency

**Interfaces:**
- Produces `openProxyIntelligenceDb(dataDir: string): ProxyIntelligenceDb`.
- Produces `ProxyIntelligenceDb.exec(sql: string, params?: readonly unknown[]): void`.
- Produces `ProxyIntelligenceDb.all<T>(sql: string, params?: readonly unknown[]): T[]`.
- Produces `ProxyIntelligenceDb.get<T>(sql: string, params?: readonly unknown[]): T | undefined`.
- Produces `ProxyIntelligenceDb.transaction<T>(work: () => T): T`.
- Produces `ProxyIntelligenceDb.close(): void`.
- Produces `migrateProxyIntelligence(db): void`.
- Consumes existing `data/proxies.sqlite3`; does not alter quick sync callers yet.

- [ ] **Step 1: Write failing migration tests**

Add tests that create a temporary SQLite database and assert:

```ts
const db = openProxyIntelligenceDb(tempDir);
const columns = db.all<{ name: string }>("PRAGMA table_info(proxies)");
assert.ok(columns.some((column) => column.name === "source"));
assert.ok(columns.some((column) => column.name === "lifecycle_state"));
assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxy_audits")?.count, 0);
```

Also insert an existing legacy `proxies` row, run migration twice, and assert the row remains once with `source = 'legacy'` and `lifecycle_state = 'unknown'`.

- [ ] **Step 2: Run focused test and verify failure**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-db.test.ts
```

Expected: FAIL because `src/server/proxy-intelligence-db.ts` does not exist.

- [ ] **Step 3: Implement minimal adapter and migration**

Use `DatabaseSync` from `node:sqlite` with the existing database path. Create the existing `proxies` table only when the database is empty; inspect `PRAGMA table_info(proxies)` before each `ALTER TABLE`, so reruns do not fail. Add the approved columns and tables/indexes from the spec. Wrap schema creation in one transaction. Use parameterized statements for all values.

Migration MUST not create synthetic diagnosis/audit rows. Existing rows get default `source = 'legacy'` and `lifecycle_state = 'unknown'`.

- [ ] **Step 4: Add startup initialization**

Open the DB once beside the existing `dataDir` initialization in `src/server/server.ts`. Call migration before constructing routes/job managers. Keep the DB object process-local and close it during graceful shutdown if the server already has a shutdown path.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-db.test.ts
npm run typecheck
```

Expected: all migration tests pass and typecheck is clean.

- [ ] **Step 6: Commit**

```sh
git add src/server/proxy-intelligence-db.ts src/server/server.ts tests/proxy-intelligence-db.test.ts package.json
git commit -m "feat: add proxy intelligence sqlite schema"
```

---

### Task 2: Inventory repository, import, redaction, and server-side filters

**Files:**
- Create: `src/server/proxy-intelligence-repository.ts`
- Create: `tests/proxy-intelligence-repository.test.ts`
- Modify: `src/lib/types.ts` after repository contracts are fixed
- Modify: `src/server/server.ts` to expose inventory handlers
- Create or modify: `src/lib/proxy-intelligence-api.ts`

**Interfaces:**
- Consumes `ProxyIntelligenceDb` from Task 1.
- Produces `listProxies(filter: ProxyInventoryFilter): Promise<ProxyInventoryPage>`.
- Produces `getProxy(proxyKey: string): Promise<ProxyInventoryDetail | null>`.
- Produces `importProxies(input: ProxyImportInput): Promise<ProxyImportSummary>`.
- Produces `redactProxy(proxy): RedactedProxy`.
- `ProxyInventoryFilter` includes `search`, `source`, `protocol`, `lifecycle`, `verdict`, `country`, `asn`, `isp`, `minReliability`, `maxLatencyMs`, `auditAge`, `hasCriticalRisk`, `page`, and `pageSize`.
- `ProxyInventoryPage` includes `items`, `page`, `pageSize`, and `total`.
- Bulk endpoints accept `proxyKeys: string[]` or a validated filter object, never raw credentials.

- [ ] **Step 1: Write failing repository tests**

Cover:

```ts
const imported = await repository.importProxies({ source: "bulk.txt", content: "http://user:pass@127.0.0.1:8080\n127.0.0.2:8080\nnot-a-proxy\n" });
assert.equal(imported.inserted, 2);
assert.equal(imported.invalid, 1);

const page = await repository.listProxies({ page: 1, pageSize: 1, lifecycle: "unknown" });
assert.equal(page.items.length, 1);
assert.equal(page.total, 2);
assert.equal(page.items[0].password, undefined);
```

Also test deduplication by canonical protocol/host/port/username, stable legacy keys, search/pagination, and redaction of credentials and raw authorization-like error text.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-repository.test.ts
```

Expected: FAIL because repository types and implementation do not exist.

- [ ] **Step 3: Define shared types**

Add explicit types to `src/lib/types.ts`: `ProxyLifecycleState`, `ProxyDiagnosisStatus`, `ProxyInventoryFilter`, `ProxyInventoryItem`, `ProxyInventoryDetail`, `ProxyInventoryPage`, `ProxyImportInput`, `ProxyImportSummary`, and `RedactedProxy`. Keep existing `PoolRecord`, `DiagnosticJob`, and `AuditorJob` types unchanged for compatibility during migration.

- [ ] **Step 4: Implement repository queries**

Use parameterized SQL. Build filter predicates from a fixed allowlist; never interpolate user-provided column names. Join latest diagnosis and latest audit using correlated subqueries or CTEs. Apply `LIMIT/OFFSET` after filters and return a separate `COUNT(*)` query result. Parse `result_json` only for detail responses. Keep credentials internal to repository methods.

- [ ] **Step 5: Implement import**

Parse each input line through the existing proxy parser. Insert/update canonical inventory rows in a transaction. Preserve source name and malformed count. Do not write the input file as runtime state. Redact parser/network errors before returning them.

- [ ] **Step 6: Add authenticated API handlers**

Add:

```text
GET  /api/intelligence/proxies
GET  /api/intelligence/proxies/:proxyKey
POST /api/intelligence/import
```

Return only redacted DTOs. Validate page size to 1–100, filter enum values, numeric ranges, and max search length. Keep the legacy diagnostics upload endpoint untouched until the unified UI task.

- [ ] **Step 7: Run tests and typecheck**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-repository.test.ts tests/proxy-intelligence-db.test.ts
npm run typecheck
```

- [ ] **Step 8: Commit**

```sh
git add src/server/proxy-intelligence-repository.ts src/lib/types.ts src/lib/proxy-intelligence-api.ts src/server/server.ts tests/proxy-intelligence-repository.test.ts
git commit -m "feat: add proxy intelligence inventory repository"
```

---

### Task 3: Diagnosis and deep-audit persistence jobs

**Files:**
- Create: `src/server/proxy-intelligence-jobs.ts`
- Create: `tests/proxy-intelligence-jobs.test.ts`
- Modify: `src/server/server.ts` with job routes
- Modify: `src/lib/types.ts` with `ProxyIntelligenceJob` contracts
- Modify: `src/lib/proxy-intelligence-api.ts` with job client methods

**Interfaces:**
- Consumes repository methods from Task 2 and existing `createDiagnosticRunner`/`checkProxy`.
- Produces `createDiagnoseJob(input: ProxySelectionJobInput): Promise<ProxyIntelligenceJob>`.
- Produces `createAuditJob(input: ProxySelectionJobInput): Promise<ProxyIntelligenceJob>`.
- Produces `getJob(id: string): ProxyIntelligenceJob | null`.
- Produces `cancelJob(id: string): Promise<ProxyIntelligenceJob>`.
- `ProxySelectionJobInput` is `{ mode: "diagnose" | "audit"; proxyKeys?: string[]; filter?: ProxyInventoryFilter; options: AuditorJobOptions }`.
- Job snapshots contain counts and proxy-key references only; credentials never enter job JSON or browser payloads.

- [ ] **Step 1: Write failing job tests**

Use injected fake diagnose/audit functions. Assert:

```ts
const job = await manager.createAuditJob({ mode: "audit", proxyKeys: ["p1", "p2"], options });
await waitForJob(manager, job.id);
assert.equal(manager.getJob(job.id)?.status, "done");
assert.equal(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxy_audits")?.count, 2);
```

Add tests proving one thrown audit error creates one failed item and the second proxy still completes; two audit runs create two rows; cancellation preserves completed rows; filter selection resolves from SQLite at job creation.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-jobs.test.ts
```

Expected: FAIL because the manager does not exist.

- [ ] **Step 3: Implement bounded worker manager**

Create an in-memory job map with explicit `queued`, `running`, `cancelling`, `cancelled`, `done`, and `error` states. Resolve selected keys once at job creation, cap concurrency to 20, and use an `AbortController`. Every item is wrapped in `try/catch`; failed items update the job but do not reject `Promise.all` for other workers.

- [ ] **Step 4: Persist diagnosis rows**

For diagnose mode, call the existing quick-check path and insert one `proxy_diagnostics` row per attempt result. Update `proxies.status`, `proxies.latency_ms`, `proxies.exit_ip`, counters, `last_error`, `checked_at`, `lifecycle_state`, and `updated_at` in the same transaction. Diagnose lifecycle may only be `working`, `dead`, or `unknown`.

- [ ] **Step 5: Persist immutable audit snapshots**

For audit mode, call `checkProxy` with the stored parsed credentials and requested options. Redact the result before storing `result_json`. Insert `proxy_audits` and one `proxy_audit_risks` row per risk in one transaction. Compute lifecycle from measured result: critical risk → `dangerous`; failed transport → `dead`; low reliability → `unstable`; otherwise successful no-critical-risk → `working`; insufficient evidence → `unknown`. Never update or delete prior audit rows.

- [ ] **Step 6: Add job routes**

Add:

```text
POST /api/intelligence/jobs
GET  /api/intelligence/jobs/:id
POST /api/intelligence/jobs/:id/cancel
```

Validate that exactly one of `proxyKeys` and `filter` is provided, cap explicit keys at 10,000, and require filter resolution through the repository. Return 202 for accepted jobs and 409 when no selection exists. Redact all errors.

- [ ] **Step 7: Run focused tests**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-jobs.test.ts tests/proxy-intelligence-repository.test.ts
```

- [ ] **Step 8: Commit**

```sh
git add src/server/proxy-intelligence-jobs.ts src/server/server.ts src/lib/types.ts src/lib/proxy-intelligence-api.ts tests/proxy-intelligence-jobs.test.ts
git commit -m "feat: persist proxy intelligence diagnose and audit jobs"
```

---

### Task 4: Proxy Intelligence UI and compatibility routes

**Files:**
- Create: `src/app/(dashboard)/intelligence/page.tsx`
- Create: `src/components/proxy-intelligence.css` only for layout styles not covered by existing tokens
- Modify: `src/app/(dashboard)/diagnostics/page.tsx` to redirect/render compatibility navigation
- Modify: `src/app/(dashboard)/auditor/page.tsx` to redirect/render compatibility navigation
- Modify: dashboard navigation component/layout where the two old links are declared
- Modify: `src/lib/proxy-intelligence-api.ts` if UI response contracts need no new endpoints
- Create: `tests/proxy-intelligence-ui-contract.test.ts` only for pure formatting/filter helpers; do not test JSX source text

**Interfaces:**
- Consumes paginated inventory and job APIs from Tasks 2–3.
- Produces unified route `/intelligence` with row selection, server-side filters, diagnose/audit actions, progress, cancel, and detail drawer.

- [ ] **Step 1: Write failing pure UI contract tests**

Extract pure helpers for lifecycle labels, filter serialization, pagination bounds, and redacted display. Test behavior:

```ts
assert.equal(formatLifecycle("dangerous"), "Dangerous");
assert.equal(serializeProxyFilter({ page: 0, pageSize: 500 }).pageSize, 100);
assert.equal(displayCredential("secret"), "••••••••");
```

- [ ] **Step 2: Run focused test and verify failure**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-ui-contract.test.ts
```

Expected: FAIL until helpers exist.

- [ ] **Step 3: Implement server-side filter table**

Use existing shadcn `Input`, `Select`, `Checkbox`, `Button`, `Badge`, `Sheet`, `Tabs`, `Progress`, and table primitives. Keep pagination state in the client, but fetch each page from `/api/intelligence/proxies`. Include filters for search, source, protocol, lifecycle, verdict, country, ASN, ISP, min reliability, max latency, audit age, and critical risk.

- [ ] **Step 4: Implement bulk selection and actions**

Provide page selection plus `Select filtered`. Actions call job creation with explicit proxy keys or current filter snapshot:

```text
Quick diagnose selected
Safety audit selected
Safety audit filtered
Cancel current job
```

Poll the job endpoint while active, show checked/total and state counters, and clear selection only after accepted job creation.

- [ ] **Step 5: Implement detail drawer**

Clicking a row fetches `/api/intelligence/proxies/:proxyKey`. Render tabs for Overview, Connectivity, Security, Privacy, Reputation, Risks, and History. Render full evidence fields from the redacted snapshot; never render stored password. Add `Audit again` to row menu and detail header.

- [ ] **Step 6: Add compatibility navigation**

Make `/diagnostics` and `/auditor` navigate to `/intelligence` without duplicating old workflows. Replace dashboard navigation entries with one Proxy Intelligence entry. Do not remove legacy API handlers in this task.

- [ ] **Step 7: Verify actual UI**

Start the server, open `/intelligence` in the browser, authenticate, verify filters, pagination, row drawer, redaction, and a single audit job. Verify old URLs land on `/intelligence`.

- [ ] **Step 8: Run typecheck/build and commit**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-ui-contract.test.ts
npm run typecheck
npm run build
```

```sh
git add src/app/(dashboard)/intelligence src/app/(dashboard)/diagnostics src/app/(dashboard)/auditor src/components/proxy-intelligence.css src/lib/proxy-intelligence-api.ts tests/proxy-intelligence-ui-contract.test.ts
 git commit -m "feat: add unified proxy intelligence page"
```

---

### Task 5: Strict working-proxy export in Settings

**Files:**
- Modify: `src/server/proxy-intelligence-repository.ts` with export query and formatter
- Modify: `src/server/server.ts` with export endpoint
- Modify: `src/lib/proxy-intelligence-api.ts` with download helper
- Modify: `src/app/(dashboard)/settings/page.tsx` with export controls
- Create: `tests/proxy-intelligence-export.test.ts`

**Interfaces:**
- Consumes latest audit data and inventory from Task 2.
- Produces `exportWorkingProxies(filter: WorkingExportFilter): Promise<ExportResult>`.
- `WorkingExportFilter` defaults to `{ verdict: "PASS", minReliability: 90, maxAuditAgeMs: 86_400_000, includeCredentials: false, format: "txt" }`.

- [ ] **Step 1: Write failing export tests**

Insert fixtures for PASS/reliability 95/fresh, PASS/reliability 89, WARN/reliability 99, PASS/critical risk, and stale PASS. Assert only the first is in default TXT output. Assert default output contains no password and explicit `includeCredentials: true` requires a server-side confirmation field.

- [ ] **Step 2: Run focused test and verify failure**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-export.test.ts
```

Expected: FAIL because export method/route does not exist.

- [ ] **Step 3: Implement strict SQL selection and output**

Select only the latest audit per proxy, enforce verdict/reliability/critical-risk/age in SQL, and format TXT one endpoint per line. Format CSV with RFC4180 quoting and redact credentials unless explicitly requested. Never include raw `result_json` in export.

- [ ] **Step 4: Add authenticated download endpoint**

Add:

```text
GET /api/settings/proxy-export?format=txt|csv&includeCredentials=false
```

Require the control password already used by settings. If credentials are requested, require `confirmCredentials=true` and send `Cache-Control: no-store`. Set a download filename and content type.

- [ ] **Step 5: Add Settings UI**

Add a card with strict policy summary, format selector, redacted/full credential checkbox, explicit confirmation dialog for full credentials, and download button. Show result count/error toast.

- [ ] **Step 6: Run tests and browser verification**

Run:

```sh
node --import tsx --test tests/proxy-intelligence-export.test.ts
npm run typecheck
```

Open Settings in the browser, download TXT, verify it contains only strict qualifying proxies and no password by default. Test the confirmation dialog before full credential export.

- [ ] **Step 7: Commit**

```sh
git add src/server/proxy-intelligence-repository.ts src/server/server.ts src/lib/proxy-intelligence-api.ts src/app/(dashboard)/settings/page.tsx tests/proxy-intelligence-export.test.ts
git commit -m "feat: export strict working proxies from settings"
```

---

### Task 6: Compatibility, migration regression coverage, and documentation

**Files:**
- Modify: `tests/auditor-jobs.test.ts` only where legacy behavior must remain covered
- Modify: `tests/api-contract.test.ts` for new route authentication/status contracts
- Create: `tests/proxy-intelligence-migration-regression.test.ts`
- Modify: `docs/PROXY_AUDITOR.md` with unified workflow and storage boundaries
- Modify: `README.md` only if existing command/page references become inaccurate

**Interfaces:**
- Consumes completed implementation from Tasks 1–5.
- Produces regression evidence that old quick sync and legacy auditor APIs still behave as before while the unified page uses SQLite inventory.

- [ ] **Step 1: Add migration regression fixtures**

Copy a fixture SQLite database containing existing `proxies` rows, run startup migration twice, and assert row count, proxy keys, status, exit IP, counters, and last error are unchanged. Assert no fake audit rows exist.

- [ ] **Step 2: Add API contract tests**

Assert unauthenticated inventory/jobs/export requests return 401, invalid filters return 400, empty bulk selection returns 409, and successful job creation returns 202 with no credentials in JSON.

- [ ] **Step 3: Verify legacy behavior**

Run existing quick sync, diagnostics, and auditor tests. Do not change expected quick-sync sampling or 9Router pool semantics.

- [ ] **Step 4: Update documentation**

Document:

- `.txt` import-only boundary
- SQLite inventory and audit snapshot storage
- quick diagnose versus deep safety audit
- lifecycle definitions and PASS limitations
- bulk filter behavior
- strict Settings export policy
- plaintext credential caveat and redaction behavior
- compatibility routes

- [ ] **Step 5: Run full verification**

Run:

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

Then smoke the actual path: import a small file, verify rows in SQLite, run one quick diagnose, run one deep audit again, inspect detail evidence, filter bulk audit, cancel a job, and export strict working proxies from Settings.

- [ ] **Step 6: Commit**

```sh
git add tests docs/PROXY_AUDITOR.md README.md
 git commit -m "test: document proxy intelligence migration and workflow"
```

---

## Plan self-review

### Spec coverage

- Additive migration and legacy preservation: Task 1 and Task 6.
- SQLite inventory/import/filter/redaction: Task 2.
- Separate quick diagnosis and immutable deep-audit snapshots: Task 3.
- Bulk selection, pagination, detail tabs, audit again, compatibility routes: Task 4.
- Strict Settings export: Task 5.
- Stability, cancellation, per-item isolation, and documentation: Tasks 3 and 6.
- Existing sync semantics unchanged: Task 6 regression checks.

### Placeholder scan

No `TBD`, `TODO`, “implement later”, or undefined follow-up step appears in the task instructions. Every task has concrete files, interfaces, tests, commands, and commit content.

### Type consistency

- Task 1 exports `ProxyIntelligenceDb`; Task 2 consumes it.
- Task 2 defines inventory/filter DTOs; Tasks 3–5 consume those DTOs.
- Task 3 defines `ProxySelectionJobInput`, `ProxyIntelligenceJob`, and job routes; Task 4 consumes them.
- Task 2/5 repository owns inventory/export selection; Task 5 consumes its strict query.
- Existing `AuditorJob` and `DiagnosticJob` remain untouched until unified UI compatibility is in place.
