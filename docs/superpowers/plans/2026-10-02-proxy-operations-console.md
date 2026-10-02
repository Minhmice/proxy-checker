# Proxy Operations Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `/proxies` into one secure, explainable Proxy Operations Console with URL-persistent filters, bulk audit jobs, evidence-driven inspection, safe import/export, and restart-visible job state without rewriting the auditor transport engine.

**Architecture:** Keep `checkProxy` as the standard audit pipeline. Add a stable semantic contract at the auditor/repository boundary, persist compact proxy and job snapshots in SQLite, and let the UI render server-owned health/verdict/reason data. Migrate browser API calls to a server-validated session cookie, keep direct handler authorization, and compose the existing shadcn primitives into focused proxy workspace components.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 6, Node `node:http`, Node `node:sqlite` `DatabaseSync`, Playwright for optional browser audits, Node test runner, shadcn/Radix primitives, Tailwind tokens, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-10-02-proxy-operations-console-design.md`

## Global Constraints

- Preserve existing `checkProxy` probes, SSRF protections, reputation cache, WAL database, and DonutBrowser dark control-room visual system.
- Keep backend health values `working | regressed | dead`; present them as `Healthy | Regressed | Never verified` without frontend re-derivation.
- Keep `health`, `poolTier`, and `lastVerdict` as separate concepts.
- Unsupported, skipped, provider-unavailable, and transport-error measurements MUST NOT be rendered or scored as false failures.
- UDP, DNS leak, timezone, geo, and fingerprint data MUST NOT be claimed unless measured by backend evidence.
- Credentials MUST stay out of URLs, logs, list responses, detail responses, and audit result prose.
- All UI MUST use existing shadcn primitives and project tokens; do not add a UI dependency or a parallel custom component system.
- Keep `DatabaseSync` transactions short. Do not add PostgreSQL, cursor pagination, or a worker-thread database rewrite without profiling evidence.
- Every permanent behavior change requires a focused Node test; UI behavior requires an authenticated browser smoke scenario.

---

### Task 1: Replace raw browser-password transport with session authentication

**Files:**
- Create: `src/server/session-auth.ts`
- Modify: `src/server/server.ts:52-81,749-823`
- Modify: `src/server/app-config.ts` only if a small exported password-verification helper is needed
- Modify: `src/lib/api.ts:15-59,61-239`
- Modify: `src/lib/proxy-intelligence-api.ts:1-164`
- Modify: `src/lib/auditor-api.ts` and any other client helper importing `authHeaders`
- Modify: `src/components/auth-provider.tsx:6-44`
- Modify: `src/app/auth/page.tsx:68-170`
- Modify: dashboard pages/components currently destructuring `password` from `useAuth`, including `src/app/(dashboard)/layout.tsx`, `src/app/(dashboard)/proxies/page.tsx`, `src/components/proxy-detail-drawer.tsx`, `src/components/command-palette.tsx`, `src/components/right-panel.tsx`, `src/components/topbar.tsx`, and existing settings/overview/infrastructure callers
- Test: `tests/session-auth.test.ts`

**Interfaces:**
- Produces `POST /api/auth/login` accepting `{ password: string }`, setting `minhmiceproxy-session` with `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` when production transport is HTTPS.
- Produces `POST /api/auth/logout`, clearing the session cookie.
- Produces `GET /api/auth/session`, returning `{ authenticated: boolean }` without password material.
- Produces `requireDashboardAuth(request): { authenticated: true } | { authenticated: false }` for handler-level guards.
- Changes client helpers to use `credentials: "same-origin"` and no password parameter. JSON requests use a shared `jsonHeaders()` helper.
- Changes `AuthContextValue` to `{ authenticated, setAuthenticated, clearSession }`; no password is stored in React state, `sessionStorage`, `document.cookie`, URL, or request logs.

- [ ] **Step 1: Add session primitives and tests first.** Implement an opaque random session token held server-side with expiry and constant-time session lookup; expose `createSession`, `readSession`, `revokeSession`, `sessionCookie`, `clearSessionCookie`, and `requireDashboardAuth`. Keep session state separate from proxy/audit DB state.

```ts
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface DashboardSession {
  token: string;
  expiresAt: number;
}

export function createSession(now = Date.now()): DashboardSession;
export function readSession(cookieHeader: string | undefined, now?: number): boolean;
export function revokeSession(cookieHeader: string | undefined): void;
```

- [ ] **Step 2: Run the focused session test and verify it fails before wiring routes.**

Run: `node --import tsx --test tests/session-auth.test.ts`

Expected before implementation: module/function or assertion failures; after session primitives are implemented: PASS for valid token, expired token, malformed cookie, logout revocation, and cookie flags.

- [ ] **Step 3: Add login/session/logout routes before the existing API auth gate.** Login MUST verify the submitted password with `verifyControlPassword`, return `401` without setting a cookie when invalid, and never echo or log the password. Session and logout routes MUST be safe to call without an existing session.

- [ ] **Step 4: Make every sensitive handler authorize itself.** Call `requireDashboardAuth` at the beginning of `handleIntelligence`, `handleProxiesUnified`, settings export handling, and existing operational handlers. Retain the outer gate as early rejection, but do not rely on path dispatch alone. Remove query-string auth acceptance for new session-based browser requests; keep any legacy Basic/Bearer compatibility only in one documented compatibility branch with no new callers.

- [ ] **Step 5: Migrate client helpers and auth provider.** Login stores only `authenticated=true` in memory; page reload calls `/api/auth/session`; logout calls `/api/auth/logout`. Remove `STORAGE_KEY`, `STORAGE_DATE_KEY`, `COOKIE_NAME`, `authHeaders(password)`, password query parameters, and all helper signatures that require raw password.

- [ ] **Step 6: Migrate all existing callsites.** Replace `fetchStatus(password, ...)` with `fetchStatus(...)`, and apply the same change to pool, metrics, diagnostics, settings, auditor, unified proxy, intelligence, command palette, right panel, and drawer callers. Preserve existing loading/error behavior.

- [ ] **Step 7: Run auth tests and typecheck.**

Run: `node --import tsx --test tests/session-auth.test.ts tests/api-contract.test.ts`

Expected: PASS; direct requests without session return `401`, authenticated same-origin requests succeed, no request URL contains password/token, and TypeScript compiles.

- [ ] **Step 8: Commit.**

```bash
git add src/server/session-auth.ts src/server/server.ts src/server/app-config.ts src/lib src/components/auth-provider.tsx src/app/auth/page.tsx src/app tests/session-auth.test.ts
git commit -m "feat(auth): use handler-validated dashboard sessions"
```

---

### Task 2: Add explicit audit capabilities, reason codes, and provenance

**Files:**
- Modify: `src/auditor/types.ts:29-209`
- Modify: `src/auditor/api.ts:64-373`
- Modify: `src/auditor/scoring/explanations.ts:11-143`
- Modify: `src/auditor/scoring/scores.ts` only where nullable capability semantics currently become misleading scores
- Modify: `src/auditor/reputation/provider.ts`, `src/auditor/reputation/aggregate.ts`, `src/auditor/reputation/cache.ts` to expose existing cache/provider timestamps without exposing secrets
- Create: `src/auditor/detail.ts` for the stable audit-detail serializer
- Modify: `src/auditor/cli/formatters.ts` sanitization if needed to preserve semantic fields
- Test: `tests/auditor/contracts.test.ts`
- Test: `tests/auditor/scoring.test.ts`
- Test: `tests/auditor/reputation.test.ts`

**Interfaces:**
- Produces `ProbeStatus = "PASS" | "WARN" | "FAIL" | "UNSUPPORTED" | "SKIPPED" | "ERROR"`.
- Produces `AuditReasonCode` values owned by backend evidence mapping, including existing concrete codes such as `ORIGIN_IP_EXPOSED`, `DNS_LEAK`, `SPKI_MISMATCH`, `CONTENT_TAMPERING`, `UNSTABLE_EXIT`, `ABUSE_HISTORY`, and `INSUFFICIENT_EVIDENCE`; do not rename existing risk codes without a migration map.
- Extends `ProxyAuditResult` with `probes`, `reasons`, and `provenance` while retaining current raw evidence for compatibility.
- Produces `serializeAuditDetail(result, proxyKey, auditId)` returning the `ProxyAuditDetail` contract from the spec.

- [ ] **Step 1: Write contract tests around real current evidence.** Verify a result with missing DNS/UDP evidence reports `UNSUPPORTED` or `SKIPPED`, not `FAIL`; a critical header/TLS/browser leak maps to a critical reason; provider quota exhaustion maps to unavailable/stale enrichment and does not create a false proxy failure; credentials are absent from serialized detail.

```ts
test("unsupported measurement is not a failure", () => {
  const detail = serializeAuditDetail(resultWithoutDnsOrUdp, "proxy-key", "audit-id");
  assert.equal(detail.probes.find((probe) => probe.name === "dns")?.status, "UNSUPPORTED");
  assert.notEqual(detail.probes.find((probe) => probe.name === "dns")?.status, "FAIL");
});
```

- [ ] **Step 2: Run the focused contract tests to establish the failing boundary.**

Run: `node --import tsx --test tests/auditor/contracts.test.ts`

Expected: FAIL until the new semantic serializer exists.

- [ ] **Step 3: Add typed status/reason/provenance fields.** Preserve unknown raw probe values; map them to `UNSUPPORTED`, `SKIPPED`, or `ERROR` based on actual execution state. Include auditor/schema/scoring versions, timeout profile, baseline capture metadata, provider cache state/timestamps, and browser engine metadata only when available.

- [ ] **Step 4: Make risk explanations backend-owned.** Reuse existing `RiskFactor.code`, `severity`, `title`, `description`, and `evidence`; normalize severity to detail-level `info | warning | critical` without deleting existing raw severity. Do not infer reasons in React from numeric score thresholds.

- [ ] **Step 5: Expose existing reputation cache state.** On cache hit, report `fresh` or `stale`; on 429/quota exhaustion, report `unavailable` and retain audit completion. Keep current IP-keyed TTL behavior and limiter.

- [ ] **Step 6: Add provenance for direct baseline and audit metadata.** Attach a baseline ID/capture timestamp to the baseline result; use existing metadata version values for initial `auditorVersion`, `scoringVersion`, and `schemaVersion` rather than inventing a second version registry.

- [ ] **Step 7: Run auditor tests.**

Run: `npm run test:auditor`

Expected: all existing auditor tests plus contract assertions PASS; existing SSRF, reputation, score, probe, browser and transport semantics remain unchanged.

- [ ] **Step 8: Commit.**

```bash
git add src/auditor tests/auditor
git commit -m "feat(audit): expose explainable probe contracts"
```

---

### Task 3: Migrate SQLite read model and add persistent audit jobs

**Files:**
- Modify: `src/server/proxy-intelligence-db.ts:17-167`
- Modify: `src/server/proxy-intelligence-repository.ts:7-154,519-835`
- Create or modify shared types: `src/lib/types.ts`
- Test: `tests/proxy-intelligence-migration.test.ts`
- Test: `tests/proxy-unified-status.test.ts`
- Test: `tests/proxy-unified-api.test.ts`

**Interfaces:**
- Repository exposes `getUnifiedProxies(filter): Promise<UnifiedProxyResponse>` with `pagination`, `facets`, `meta`, and server-owned list health.
- Repository exposes `getAuditDetail(proxyKey, auditId?): Promise<ProxyAuditDetail | null>`.
- Repository exposes `previewImport(input): Promise<ProxyImportPreview>` without mutating DB.
- Repository exposes `persistAuditSnapshot(input): Promise<void>` for both single and batch audit paths.
- Repository exposes `createAuditJob`, `updateAuditJob`, `getAuditJob`, `listAuditJobs`, and `markInterruptedJobs`.
- Shared client types live in `src/lib/types.ts`; client files MUST NOT import runtime job-manager modules from `src/server`.

- [ ] **Step 1: Add migration regression tests.** Open a fresh DB and a legacy DB fixture, run migration twice, assert the six proxy snapshot columns and `audit_jobs` exist, existing rows/audits survive, and existing `(proxy_key, finished_at DESC)` history index remains usable.

- [ ] **Step 2: Run migration tests before changing schema.**

Run: `node --import tsx --test tests/proxy-intelligence-migration.test.ts`

Expected: FAIL on missing columns/table in the legacy fixture.

- [ ] **Step 3: Add idempotent schema migration.** Add `last_verdict`, `last_checked_at`, `last_latency_ms`, `last_exit_ip`, `last_failure_code`, `ever_passed`; add `audit_jobs` with `queued/running/completed/cancelled/failed/interrupted`-compatible state values; add only query indexes justified by `EXPLAIN QUERY PLAN`. Pass `timeout: 3000` to `DatabaseSync` if supported by the current Node version and keep WAL/foreign keys.

- [ ] **Step 4: Centralize audit persistence.** `persistAuditSnapshot` inserts `proxy_audits`, typed risks, updates proxy snapshot/lifecycle fields, and optionally updates job counters in one short `BEGIN IMMEDIATE` transaction. Set `ever_passed = 1` only for PASS; do not overwrite a known exit IP/latency with null.

- [ ] **Step 5: Add read-model projection.** Replace repeated correlated history work in `getUnifiedProxies` with snapshot columns for last verdict/time/latency/exit/reason and one consistent health CASE. Preserve filter semantics and map `active/reserve` pool tier separately. Return protocol facets from the same query path.

- [ ] **Step 6: Add preview-only import projection.** Reuse `parseProxyInput` to return line counts, valid entries, duplicate keys, invalid lines and detected protocols without writes. Keep `importProxies` server parsing and transaction as the only DB mutation path.

- [ ] **Step 7: Add audit-detail projection.** Read sanitized `result_json`, typed risks, snapshot metadata and recent history into the `ProxyAuditDetail` contract. Never return username/password.

- [ ] **Step 8: Run repository tests.**

Run: `node --import tsx --test tests/proxy-intelligence-migration.test.ts tests/proxy-unified-status.test.ts tests/proxy-unified-api.test.ts`

Expected: PASS for working/regressed/dead semantics, facets/pagination, idempotent migration, snapshot persistence, and detail redaction.

- [ ] **Step 9: Commit.**

```bash
git add src/server/proxy-intelligence-db.ts src/server/proxy-intelligence-repository.ts src/lib/types.ts tests/proxy-intelligence-migration.test.ts tests/proxy-unified-status.test.ts tests/proxy-unified-api.test.ts
git commit -m "feat(proxy-db): add audit snapshots and unified read model"
```

---

### Task 4: Persist, hydrate, and expose audit job lifecycle

**Files:**
- Modify: `src/server/proxy-intelligence-jobs.ts:13-275`
- Modify: `src/server/server.ts:509-589,635-745`
- Modify: `src/lib/proxy-intelligence-api.ts:8-164`
- Modify: `src/lib/types.ts`
- Test: `tests/proxy-intelligence-jobs.test.ts`
- Test: `tests/proxy-intelligence-restart.test.ts`

**Interfaces:**
- `IntelligenceJobStatus` becomes `queued | running | cancelling | cancelled | completed | failed | interrupted`.
- `getJob(id)` reads persisted metadata, merging live `AbortController` state when the process owns the job.
- `listJobs()` returns recent persisted jobs for the audit tray.
- On manager creation, `markInterruptedJobs()` changes persisted queued/running jobs to interrupted before serving requests.
- Existing `POST /api/intelligence/jobs`, `GET /api/intelligence/jobs/:id`, and cancel routes retain paths but return the persisted contract.

- [ ] **Step 1: Extend the existing job test with counters and snapshot assertions.** Use the current mock audit function; assert each completed audit updates job `completed`, `passed/warned/failed`, proxy snapshot and immutable audit rows.

- [ ] **Step 2: Add restart test.** Create a queued/running row directly, construct a new manager, call `listJobs/getJob`, and assert state is `interrupted` and counters remain unchanged.

```ts
test("restart exposes interrupted audit job", () => {
  db.run("INSERT INTO audit_jobs (...) VALUES (...)", values);
  const manager = createProxyIntelligenceJobManager({ db, repo, auditFn: mockAuditProxy });
  assert.equal(manager.getJob(jobId)?.status, "interrupted");
});
```

- [ ] **Step 3: Run focused job tests before implementation.**

Run: `node --import tsx --test tests/proxy-intelligence-jobs.test.ts tests/proxy-intelligence-restart.test.ts`

Expected: restart test fails until persisted hydration exists.

- [ ] **Step 4: Persist job creation/options before scheduling runtime work.** Store total, counters, timestamps and serialized safe options. Never store credentials or an `AbortController`.

- [ ] **Step 5: Update job state/counters through the repository transaction.** Use `persistAuditSnapshot` for each result, increment completed and verdict counters, and set terminal state once all workers finish. Cancellation must distinguish already-completed rows from cancelled remaining work.

- [ ] **Step 6: Add list endpoint/client helper for the audit tray.** Return recent jobs and support polling with `AbortSignal`. Preserve 404 only for unknown IDs, not for persisted interrupted jobs.

- [ ] **Step 7: Run job tests and full typecheck.**

Run: `node --import tsx --test tests/proxy-intelligence-jobs.test.ts tests/proxy-intelligence-restart.test.ts && npm run typecheck`

Expected: PASS with no client import of a server runtime module.

- [ ] **Step 8: Commit.**

```bash
git add src/server/proxy-intelligence-jobs.ts src/server/server.ts src/lib/proxy-intelligence-api.ts src/lib/types.ts tests/proxy-intelligence-jobs.test.ts tests/proxy-intelligence-restart.test.ts
git commit -m "feat(audit-jobs): persist lifecycle and restart state"
```

---

### Task 5: Wire secure unified proxy endpoints, detail, import preview, and export policy

**Files:**
- Modify: `src/server/server.ts:509-745,784-823`
- Modify: `src/server/proxy-intelligence-repository.ts`
- Modify: `src/lib/api.ts:210-321`
- Modify: `src/lib/proxy-intelligence-api.ts`
- Modify: `src/lib/types.ts`
- Test: `tests/proxy-unified-api.test.ts`
- Test: `tests/proxy-export-policy.test.ts`
- Test: `tests/api-contract.test.ts`

**Interfaces:**
- `GET /api/proxies/unified` returns the new response contract and accepts `q`, `health`, `protocol`, `source`, `auditAge`, `sort`, `direction`, `page`, `pageSize`.
- `GET /api/proxies/:proxyKey/audit-detail` returns the detail contract.
- `POST /api/proxies/check` returns `{ proxy, auditDetail }` and persists through the shared repository method.
- `GET /api/proxies/history` returns verdict, reason summary, exit, location, latency, and timestamp without raw secrets.
- `POST /api/intelligence/import/preview` returns `ProxyImportPreview`; existing import writes only after explicit confirmation.
- Export accepts scope/filter/format and `includeCredentials=false`; credentials require a separate authorized confirmation field and create a redacted audit event.

- [ ] **Step 1: Add endpoint contract tests.** Test unified facets, detail shape, single-check response, preview non-mutation, export default redaction, and direct unauthenticated handler rejection.

- [ ] **Step 2: Run endpoint tests before route changes.**

Run: `node --import tsx --test tests/proxy-unified-api.test.ts tests/proxy-export-policy.test.ts tests/api-contract.test.ts`

Expected: failures identify old response/password assumptions.

- [ ] **Step 3: Add direct handler authorization.** Ensure all `/api/proxies/*`, `/api/intelligence/*`, `/api/ninerouter/sync`, and `/api/settings/proxy-export` paths call the session guard even if route dispatch changes later.

- [ ] **Step 4: Normalize query parsing and response serialization.** Validate page/pageSize bounds, whitelist sort/direction values, preserve abort-safe list fetching, and return `generatedAt` from the server.

- [ ] **Step 5: Replace duplicate single-check persistence.** Parse the stored proxy row safely, run `checkProxy`, serialize detail, call `persistAuditSnapshot`, then fetch only the updated list item. Do not reload the full list in the endpoint or client.

- [ ] **Step 6: Add import preview/commit separation.** Preview uses canonical parsing with no transaction; commit repeats server validation and returns inserted/updated/duplicate/invalid counts plus imported keys.

- [ ] **Step 7: Harden export.** Default to current filters, exclude credentials, validate explicit privileged confirmation server-side, avoid raw credentials in logs, and use safe CSV escaping rather than splitting credential-bearing endpoint strings naively.

- [ ] **Step 8: Run endpoint tests.**

Run: `node --import tsx --test tests/proxy-unified-api.test.ts tests/proxy-export-policy.test.ts tests/api-contract.test.ts`

Expected: PASS for direct auth, response contracts, preview non-mutation, single-row patch response, and export policy.

- [ ] **Step 9: Commit.**

```bash
git add src/server/server.ts src/server/proxy-intelligence-repository.ts src/lib/api.ts src/lib/proxy-intelligence-api.ts src/lib/types.ts tests/proxy-unified-api.test.ts tests/proxy-export-policy.test.ts tests/api-contract.test.ts
git commit -m "feat(proxy-api): expose secure audit and export contracts"
```

---

### Task 6: Build URL-backed proxy list workspace with shadcn primitives

**Files:**
- Modify: `src/app/(dashboard)/proxies/page.tsx`
- Create: `src/components/proxies/proxy-summary.tsx`
- Create: `src/components/proxies/proxy-toolbar.tsx`
- Create: `src/components/proxies/proxy-table.tsx`
- Create: `src/components/proxies/proxy-selection-bar.tsx`
- Create: `src/components/proxies/audit-job-indicator.tsx`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts` and `src/lib/proxy-intelligence-api.ts`
- Test: `tests/proxy-workspace-state.test.ts`
- Smoke: authenticated browser scenario in `scripts/proxy-operations-smoke.mjs`

**Interfaces:**
- `ProxyWorkspace` owns URL query state, request cancellation, selected keys, row-local checking keys, drawer selection, and active job IDs.
- `ProxySummary` consumes `facets` and emits `onHealthChange`.
- `ProxyToolbar` consumes/updates `UnifiedProxyListQuery` and emits import/sync/audit/export actions.
- `ProxyTable` consumes `UnifiedProxyListItem[]`, renders health/pool/verdict separately, and emits check/open/select/copy events.
- `ProxySelectionBar` supports page selection and explicit `select all matching` state.
- `AuditJobIndicator` polls persisted jobs and emits cancel/open actions.

- [ ] **Step 1: Add pure URL-state tests.** Verify search, health, protocol, source, auditAge, sort, direction and page serialize/parse; changing a filter resets page to 1; unrelated query keys survive.

```ts
assert.deepEqual(parseProxyQuery("?q=1.2.3&health=regressed&page=2"), {
  q: "1.2.3",
  health: "regressed",
  page: 2,
});
assert.equal(serializeProxyQuery({ health: "working", page: 1 }), "health=working");
```

- [ ] **Step 2: Run the state test before component extraction.**

Run: `node --import tsx --test tests/proxy-workspace-state.test.ts`

Expected: FAIL until query parser/serializer exists.

- [ ] **Step 3: Extract summary, toolbar, table, selection bar, and job indicator.** Use `Card`, `Badge`, `Button`, `Input`, `Checkbox`, `DropdownMenu`, `Table`, `Progress`, `Alert`, and `Separator`. Keep dense control-room spacing, semantic icon-plus-text statuses, 44px practical targets, visible focus rings and reduced-motion-safe transitions.

- [ ] **Step 4: Bind query state to App Router URL.** Use `useSearchParams`/`useRouter` or the project’s existing client-compatible equivalent. Debounce only network search by 250–350ms; abort prior requests; prevent stale responses from overwriting current state.

- [ ] **Step 5: Implement status and pool presentation.** Render `Healthy`, `Regressed`, `Never verified`, and `Stale` as text plus icon; render `Active`, `Reserve`, and `Unassigned` separately; render unsupported UDP as `Not measured` rather than deriving `socks5 = Yes`.

- [ ] **Step 6: Implement row-local single audit.** Maintain `Set<string>` or one keyed state for checking rows. On response, patch only the matching item, counts/facets if returned, and open drawer detail if selected. Do not set the whole table to loading.

- [ ] **Step 7: Implement bulk selection.** Selecting the page shows selected count; a second affordance selects all rows matching the current filter. Bulk audit sends selected keys or canonical filter to `/api/intelligence/jobs`, never loops single-check requests in the browser.

- [ ] **Step 8: Add job tray polling.** Poll active/interrupted jobs with abort cleanup; show completed/total, PASS/WARN/FAIL counts, concurrency, elapsed time and Cancel. Keep the tray visible across route filter changes.

- [ ] **Step 9: Run typecheck and focused UI state test.**

Run: `node --import tsx --test tests/proxy-workspace-state.test.ts && npm run typecheck`

Expected: PASS; `/proxies` compiles with focused components and no obsolete password API calls.

- [ ] **Step 10: Commit.**

```bash
git add src/app/(dashboard)/proxies/page.tsx src/components/proxies src/lib tests/proxy-workspace-state.test.ts
git commit -m "feat(ui): build URL-backed proxy operations workspace"
```

---

### Task 7: Replace the DonutBrowser drawer with an evidence-driven inspector

**Files:**
- Modify: `src/components/proxy-detail-drawer.tsx`
- Create if needed: `src/components/proxies/audit-score-grid.tsx`
- Create if needed: `src/components/proxies/audit-evidence-list.tsx`
- Create if needed: `src/components/proxies/audit-history.tsx`
- Create if needed: `src/components/proxies/regression-panel.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/types.ts`
- Test: `tests/proxy-audit-detail.test.ts`
- Smoke: drawer keyboard/focus scenario in `scripts/proxy-operations-smoke.mjs`

**Interfaces:**
- `ProxyDetailDrawer` consumes `{ proxy, auditDetail, history, open, onOpenChange, onCheck }`.
- Score cards accept `number | null` and render `Not measured` for null.
- Evidence rows accept `AuditProbe` and render all six statuses with neutral styling for unsupported/skipped.
- Reason rows accept `AuditReason` and render backend summary/evidence link without deriving a new code.

- [ ] **Step 1: Add detail projection tests.** Verify five scores, reasons, probe statuses, provider unavailable state, provenance, regression metadata and secret redaction survive API serialization.

- [ ] **Step 2: Run detail tests before replacing the drawer.**

Run: `node --import tsx --test tests/proxy-audit-detail.test.ts`

Expected: FAIL until the detail contract is wired.

- [ ] **Step 3: Build inspector hierarchy.** Header shows protocol/endpoint, verdict, checked time, exit IP/location/ISP/ASN and latency. Follow with five scores, `Why this is ...`, probe evidence, regression panel, and history.

- [ ] **Step 4: Use shadcn `Sheet`/`Tabs` semantics correctly.** Keep the sheet modal because it overlays the table; rely on Radix focus trap/Escape/focus return. Add explicit labels such as `Check proxy 1.2.3.4:1080`, `Copy 1.2.3.4:1080`, and `Close proxy details`.

- [ ] **Step 5: Remove unsupported claims.** Do not show `UDP Yes` from protocol inference. Show `Unsupported`/`Not measured` until evidence reports a real capability. Show reputation fresh/stale/unavailable distinctly.

- [ ] **Step 6: Add regression explanation.** When health is regressed, show last known good and first failure from persisted history; show changed latency/exit only when both observations exist.

- [ ] **Step 7: Preserve row-local checking.** Drawer action calls the single-check endpoint, shows pending state, replaces detail from server response, and refreshes history through an abortable request.

- [ ] **Step 8: Run detail tests and typecheck.**

Run: `node --import tsx --test tests/proxy-audit-detail.test.ts && npm run typecheck`

Expected: PASS with no unsupported measurements rendered as facts.

- [ ] **Step 9: Commit.**

```bash
git add src/components/proxy-detail-drawer.tsx src/components/proxies src/lib tests/proxy-audit-detail.test.ts
git commit -m "feat(ui): add explainable proxy audit inspector"
```

---

### Task 8: Add import preview and privileged export dialogs

**Files:**
- Create: `src/components/proxies/proxy-import-dialog.tsx`
- Create: `src/components/proxies/proxy-export-dialog.tsx`
- Modify: `src/app/(dashboard)/proxies/page.tsx`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/proxy-intelligence-api.ts`
- Test: `tests/proxy-import-preview.test.ts`
- Test: `tests/proxy-export-policy.test.ts`

**Interfaces:**
- `ProxyImportDialog` stages `{ source, content }`, fetches preview, shows total/valid/duplicates/invalid/protocol counts, exposes invalid lines, then commits explicitly and offers `Audit imported proxies` using returned keys.
- `ProxyExportDialog` accepts current query and selected keys, defaults to redacted `txt`, and requires explicit confirmation before credentials.

- [ ] **Step 1: Add preview tests.** Assert preview does not insert rows, canonical parser counts duplicate/invalid lines, and import commit returns stable imported keys.

- [ ] **Step 2: Run preview tests before dialog wiring.**

Run: `node --import tsx --test tests/proxy-import-preview.test.ts tests/proxy-export-policy.test.ts`

Expected: preview test fails until preview endpoint/client contract exists.

- [ ] **Step 3: Implement import dialog with `Dialog`, `Textarea`/file input, `Alert`, `Badge`, `Button`, and `ScrollArea`.** Keep client preview informational; commit endpoint reparses and validates again.

- [ ] **Step 4: Implement export dialog.** Scope current filters vs selected keys; format `txt/csv`; credentials checkbox starts false; enabling it renders plaintext warning and a second explicit confirmation action. Call server export only after confirmation.

- [ ] **Step 5: Connect post-import CTA.** On successful import, show inserted/updated/skipped/invalid summary and start a bulk audit using imported keys only when the operator clicks the CTA.

- [ ] **Step 6: Run focused tests and typecheck.**

Run: `node --import tsx --test tests/proxy-import-preview.test.ts tests/proxy-export-policy.test.ts && npm run typecheck`

Expected: PASS; no import writes occur during preview and credentials remain off by default.

- [ ] **Step 7: Commit.**

```bash
git add src/components/proxies/proxy-import-dialog.tsx src/components/proxies/proxy-export-dialog.tsx src/app/(dashboard)/proxies/page.tsx src/lib tests/proxy-import-preview.test.ts tests/proxy-export-policy.test.ts
git commit -m "feat(ui): add safe proxy import and export workflows"
```

---

### Task 9: Documentation, visual verification, and release checks

**Files:**
- Modify: `docs/operations.md`
- Modify: `README.md` only if route/auth behavior is documented there
- Create: `scripts/proxy-operations-smoke.mjs`
- Modify: `package.json` only to add the smoke command if no existing browser command can run it

**Interfaces:**
- Operations documentation explains session login, status vocabulary, unsupported measurements, bulk audit lifecycle, interrupted jobs, import preview, and credential export warning.
- Smoke script logs in through `/api/auth/login`, opens `/proxies`, exercises URL filters, row check, drawer, bulk job creation/cancel, import preview, and export warning without printing secrets.

- [ ] **Step 1: Add the authenticated browser smoke scenario.** Use Playwright/browser automation against the running server; assert visible text and URL state, not CSS implementation details. Cover desktop and a narrow viewport, then close the tab/process cleanly.

- [ ] **Step 2: Run the smoke scenario against the real app.**

Run: `npm run start` in one terminal, then `node scripts/proxy-operations-smoke.mjs`.

Expected: login succeeds; `/proxies` renders summary/table; filter URL persists after reload; row check updates locally; drawer opens/closes with keyboard; bulk job shows counters; import preview does not mutate before confirmation; export credentials warning appears.

- [ ] **Step 3: Run Impeccable detector once over changed UI targets.**

Run: `C:/Users/minhmice/.agents/skills/impeccable/scripts/impeccable.cmd detect --json "src/app/(dashboard)/proxies/page.tsx" "src/components/proxies" "src/components/proxy-detail-drawer.tsx"`

Expected: Review detector findings, fix only concrete issues within scope, then run the detector once more only if a fix changes the affected UI substantially.

- [ ] **Step 4: Run project verification.**

Run:

```bash
npm run typecheck
npm run test:auditor
npm test
npm run build
```

Expected: all tests pass, production build succeeds, and no credential/session or unsupported-measurement regression appears.

- [ ] **Step 5: Update operations docs.** Document the final endpoint/session behavior and operator workflows using the actual shipped labels and states; do not document protocol-inferred UDP as a measurement.

- [ ] **Step 6: Commit documentation and verification script.**

```bash
git add docs/operations.md README.md scripts/proxy-operations-smoke.mjs package.json
git commit -m "docs(proxy): document operations console workflows"
```

- [ ] **Step 7: Final review.** Confirm all affected callers use session auth, no old password storage/helper signatures remain, no `/intelligence` navigation was reintroduced, every endpoint has direct auth, every audit result is explainable or explicitly unsupported, and all acceptance scenarios from the spec have exercised evidence.

---

## Acceptance Matrix

| Requirement | Implemented by | Verification |
|---|---|---|
| Handler-level auth | Task 1, Task 5 | Session/API tests and direct unauthenticated requests |
| No raw password in browser API calls | Task 1 | Session tests, source callsite scan, browser network inspection |
| URL-persistent filters/search/page/sort | Task 6 | Workspace state test and reload smoke |
| Correct health/pool/verdict separation | Task 3, Task 6 | Repository status test and table smoke |
| Row-local single audit | Task 5, Task 6 | API response plus browser row state |
| Bulk audit/progress/cancel | Task 4, Task 6 | Job tests and audit tray smoke |
| Restart-visible interrupted jobs | Task 4 | Restart test |
| Import preview before mutation | Task 5, Task 8 | Preview test |
| Safe export with credentials off | Task 5, Task 8 | Export policy test and warning smoke |
| Scores/reasons/probes/history drawer | Task 2, Task 5, Task 7 | Detail serialization test and keyboard smoke |
| Unsupported probe semantics | Task 2, Task 7 | Auditor contract test |
| Reputation cache/quota distinction | Task 2 | Reputation tests |
| SSRF A/AAAA/special-range/pinning/redirect protection | Existing implementation preserved in Task 2/5 | Existing SSRF tests plus regression run |
| Short SQLite transactions/read model | Task 3, Task 4 | Migration/repository/job tests and query-plan review |
| Visual/accessibility quality | Task 6, Task 7, Task 9 | Impeccable detector and authenticated browser smoke |
