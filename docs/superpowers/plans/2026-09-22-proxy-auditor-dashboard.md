# Proxy Safety Auditor Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Safety Auditor` dashboard route and sidebar entry with single/bulk background audits, cancellation, server-side history, export, responsive results, and complete evidence inspection over the standalone auditor core.

**Architecture:** `src/server/auditor-jobs.ts` owns background execution, redacted persistence, bounded concurrency, cancellation, retention, and exports. Existing authenticated custom server exposes thin `/api/auditor/*` routes. A client-only `/auditor` page consumes those HTTP contracts through `src/lib/auditor-api.ts`; auditor core never imports dashboard, server, or 9Router code.

**Tech Stack:** Node.js 22, TypeScript strict mode, native HTTP server, Next.js 16, React 19, existing shadcn/Radix components, lucide-react, native Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-22-proxy-auditor-dashboard-design.md`

## Global Constraints

- Add `Safety Auditor` immediately after `Diagnostics` in the existing Workspace sidebar group.
- Support both single proxy and bulk `.txt` jobs.
- Never persist/log/respond with a raw proxy password; persisted/exported identities use `RedactedProxyInfo` only.
- Use existing dashboard Basic control-password authentication; no new auth system.
- Use polling, not WebSocket/SSE: 1.2 seconds while queued/running/cancelling and 15 seconds otherwise.
- Keep at most 50 persisted jobs and 500 persisted results per job.
- Upload ceiling is 5 MB; bulk input ceiling is 10,000 non-empty lines.
- Attempts range 1–10; timeout range 2,000–60,000 ms; network concurrency range 1–20.
- Browser audit defaults off; browser-enabled bulk concurrency is capped at 2.
- No auditor job may mutate 9Router pools.
- Null/unknown evidence must display `Unknown`, never false, zero, or safe.
- UI uses current shadcn/Radix vocabulary, 44 px targets, keyboard focus, WCAG AA, and reduced-motion support.
- Do not overwrite unrelated working-tree edits in current sidebar/layout files; adapt to the current `AppSidebar` implementation.

---

### Task 1: Shared Job Contracts and Persistent Background Job Manager

**Files:**
- Modify: `src/lib/types.ts`
- Create: `src/server/auditor-jobs.ts`
- Create: `tests/auditor-jobs.test.ts`

**Interfaces:**
- Consumes: `checkProxy(input, options)` and `ProxyAuditResult` from `src/auditor/index.ts`; `formatCsvRecords`/sanitization rules from auditor CLI without importing CLI process code.
- Produces:

```ts
type AuditorJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "done" | "error";
type AuditorJobMode = "single" | "bulk";

interface AuditorJobOptions {
  attempts: number;
  timeoutMs: number;
  concurrency: number;
  reputation: boolean;
  browser: boolean;
}

interface AuditorJobResult {
  index: number;
  result?: ProxyAuditResult;
  error?: string;
}

interface AuditorJob {
  id: string;
  mode: AuditorJobMode;
  status: AuditorJobStatus;
  sourceName: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  total: number;
  checked: number;
  passCount: number;
  warnCount: number;
  failCount: number;
  unknownCount: number;
  duplicateCount: number;
  browserAudit: boolean;
  attempts: number;
  timeoutMs: number;
  concurrency: number;
  results: AuditorJobResult[];
  resultsCapped: boolean;
  persistenceWarning: string;
  error: string;
}
```

- `createAuditorJobManager({ dataDir, auditProxy?, now?, idFactory? })`
- Manager methods:

```ts
createSingle(input: { proxy: string; options: AuditorJobOptions }): Promise<AuditorJob>
createBulk(input: { name: string; content: string; options: AuditorJobOptions }): Promise<AuditorJob>
getJob(id: string): AuditorJob | null
listHistory(limit?: number): AuditorJob[]
cancelJob(id: string): Promise<AuditorJob>
deleteHistory(id: string): Promise<boolean>
exportJob(id: string, format: "json" | "csv"): Promise<{ contentType: string; filename: string; body: Buffer }>
isKnownJob(id: string): boolean
```

- [ ] **Step 1: Write failing tests for validation, redaction, and persistence**

Create `tests/auditor-jobs.test.ts` with temporary directories and an injected deterministic `auditProxy` fake. Tests must cover:

```ts
test("single audit persists only redacted identity", async () => {
  const manager = createHarness();
  const job = await manager.createSingle({
    proxy: "socks5://alice:secret@example.com:1080",
    options: defaults,
  });
  await waitForTerminal(manager, job.id);
  const persisted = fs.readFileSync(historyPath, "utf8");
  assert.equal(persisted.includes("secret"), false);
  assert.match(persisted, /alice:\*\*\*\*\*\*\*\*/);
});

test("bulk validation deduplicates endpoints and isolates invalid lines", async () => {
  const manager = createHarness();
  const job = await manager.createBulk({
    name: "sample.txt",
    content: "http://a.example:80\nnot-a-proxy\nhttp://a.example:80",
    options: defaults,
  });
  await waitForTerminal(manager, job.id);
  const current = manager.getJob(job.id)!;
  assert.equal(current.total, 2);
  assert.equal(current.duplicateCount, 1);
  assert.equal(current.results.some((item) => item.error), true);
});
```

Also test 5 MB/10,000-line bounds, attempts/timeout/concurrency bounds, `.txt` validation, raw invalid-line non-disclosure, atomic history creation, 50-job retention, 500-result persistence cap, corrupt history recovery, and restart reconciliation of queued/running/cancelling jobs to terminal error.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
node --import tsx --test tests/auditor-jobs.test.ts
```

Expected: FAIL because shared job types and manager do not exist.

- [ ] **Step 3: Implement normalized request parsing and safe job snapshots**

Append shared job types to `src/lib/types.ts`. In `src/server/auditor-jobs.ts`:

- validate options with fixed clamps/rejections from Global Constraints;
- parse proxy inputs using auditor parser;
- deduplicate by `${protocol}://${host}:${port}` while retaining first occurrence order;
- represent invalid lines by generated index and generic `Invalid proxy input`; never retain raw line;
- create a response/persistence snapshot that recursively sanitizes credential-bearing fields and errors;
- use `crypto.randomUUID()` by default.

- [ ] **Step 4: Implement queue, concurrency, and cancellation**

Use a minimal worker cursor:

```ts
const workerCount = Math.min(job.browserAudit ? 2 : job.concurrency, pending.length || 1);
await Promise.all(Array.from({ length: workerCount }, async () => {
  while (!controller.signal.aborted && cursor < pending.length) {
    const item = pending[cursor++];
    const result = await auditProxy(item.proxy, {
      attempts: job.attempts,
      timeoutMs: job.timeoutMs,
      reputation: options.reputation,
      browser: options.browser,
      signal: controller.signal,
    });
    recordResult(job, item.index, result);
  }
}));
```

Requirements:

- `createSingle`/`createBulk` return queued job immediately and start execution without awaiting completion;
- cancellation stops scheduling, aborts active calls, waits for workers, and sets cancelled;
- one item error cannot fail the bulk job;
- current job counters derive from every result;
- progress snapshots publish after each completion;
- no job executes after deletion/restart reconciliation.

- [ ] **Step 5: Implement atomic persistence, exports, and retention**

- write `data/auditor-history.json` through temp + rename;
- throttle progress persistence and force final write;
- persist latest 50 jobs sorted newest first;
- persist latest 500 results/job and set `resultsCapped`;
- keep full results in memory only until redacted JSON/CSV artifacts are generated under `data/auditor-exports/<job-id>.*`;
- `exportJob` serves full terminal artifact when present, otherwise sanitized/capped or partial snapshot;
- CSV uses auditor CLI formatter and formula-injection protection;
- deleting history removes export artifacts after successful state write;
- persistence failures leave in-memory execution running and set `persistenceWarning`.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
node --import tsx --test tests/auditor-jobs.test.ts
```

Expected: all job-manager tests PASS, no raw credentials in temp data files.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/lib/types.ts src/server/auditor-jobs.ts tests/auditor-jobs.test.ts
git commit -m "feat(auditor-ui): add persistent background audit jobs"
```

---

### Task 2: Authenticated Auditor HTTP API and Client Helpers

**Files:**
- Modify: `src/server/server.ts`
- Create: `src/lib/auditor-api.ts`
- Create: `tests/auditor-api.test.ts`

**Interfaces:**
- Consumes manager methods from Task 1 and existing `authHeaders(password)` convention.
- Produces client helpers:

```ts
createAuditorJob(password, payload): Promise<AuditorJob>
fetchAuditorJob(password, id, signal?): Promise<AuditorJob>
fetchAuditorHistory(password, limit?, signal?): Promise<AuditorJob[]>
cancelAuditorJob(password, id): Promise<AuditorJob>
deleteAuditorHistory(password, id): Promise<void>
getAuditorExportUrl(id, format): string
```

- [ ] **Step 1: Write failing route and client-contract tests**

Create `tests/auditor-api.test.ts`. Extract or export the auditor route handler from `server.ts` only as much as required for deterministic handler tests; do not start Next.js.

Test:

- unauthenticated requests remain 401 through existing server auth layer;
- single and bulk POST return 202;
- malformed mode/options 400;
- oversized upload 413;
- unknown job/history 404;
- invalid cancel/delete lifecycle 409;
- history list limit clamps 1–50;
- JSON/CSV export status/content-type/content-disposition;
- partial running export includes partial label;
- client helpers URL-encode IDs, pass AbortSignal, and propagate safe `{ error }` text.

Example helper contract:

```ts
test("cancelAuditorJob posts to encoded job route", async () => {
  const request = recordFetch({ job: fixtureJob });
  await cancelAuditorJob("secret", "job/a");
  assert.equal(request.url, "/api/auditor/jobs/job%2Fa/cancel");
  assert.equal(request.init.method, "POST");
});
```

- [ ] **Step 2: Run tests to verify RED**

```bash
node --import tsx --test tests/auditor-api.test.ts
```

Expected: FAIL because routes/helpers do not exist.

- [ ] **Step 3: Wire the manager and safe body limit into server startup**

In `src/server/server.ts`:

```ts
const auditorJobs = createAuditorJobManager({ dataDir });
```

Change `readBody` to accept a maximum byte count and reject before buffering beyond the bound:

```ts
function readBody(request: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>>
```

For auditor creation use `5_100_000`; map its typed size error to 413. Preserve current behavior for all existing routes.

- [ ] **Step 4: Implement `/api/auditor/*` routing**

Add `handleAuditor(request, response, pathname)` with one dynamic path parser:

- `POST /api/auditor/jobs` → validate payload, call manager, return `{ job }`, 202;
- `GET /api/auditor/jobs/:id` → `{ job }`;
- `POST /api/auditor/jobs/:id/cancel` → `{ job }`;
- `GET /api/auditor/history?limit=N` → `{ jobs }`;
- `DELETE /api/auditor/history/:id` → 204;
- `GET /api/auditor/jobs/:id/export?format=json|csv` → binary/text body with content headers.

Use explicit error classes/status on the manager rather than message substring checks. Route dispatch must occur after existing Basic auth and before legacy routes.

- [ ] **Step 5: Implement typed browser helpers**

In `src/lib/auditor-api.ts`:

- reuse `authHeaders` from `src/lib/api.ts`;
- JSON helper parses the body once and maps 401 to `Wrong control password`;
- creation payload types distinguish single/bulk;
- export helper returns URL only; browser native download handles auth through same-origin session fetch helper or a `downloadAuditorExport` helper that fetches with Basic header and creates a Blob.

Do not store control password or proxy input in local/session storage beyond the existing AuthProvider password convention.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
node --import tsx --test tests/auditor-api.test.ts tests/api-contract.test.ts
```

Expected: auditor API tests PASS and existing API contracts stay green.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/server/server.ts src/lib/auditor-api.ts tests/auditor-api.test.ts
git commit -m "feat(auditor-ui): expose authenticated audit job API"
```

---

### Task 3: Sidebar Entry and Complete Auditor Operations Surface

**Files:**
- Modify: `src/components/app-sidebar.tsx`
- Create: `src/app/(dashboard)/auditor/page.tsx`
- Create: `src/components/auditor.css`
- Modify: `README.md`

**Interfaces:**
- Consumes Task 2 client helpers and shared `AuditorJob`/`ProxyAuditResult` types.
- Produces `/auditor` UI only; no core/server logic.

- [ ] **Step 1: Add sidebar navigation using current shadcn pattern**

In `src/components/app-sidebar.tsx`:

```ts
import { ShieldCheck } from "lucide-react";

const NAV_MAIN = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/proxies", label: "Proxies", icon: Globe },
  { href: "/diagnostics", label: "Diagnostics", icon: ScanSearch },
  { href: "/auditor", label: "Safety Auditor", icon: ShieldCheck },
  { href: "/help", label: "Help Center", icon: HelpCircle },
] as const;
```

Do not alter brand/header/system/footer sidebar behavior. Keep collapsed tooltip and active-route logic.

- [ ] **Step 2: Build the setup and history state machine**

Create `src/app/(dashboard)/auditor/page.tsx` as a client route using existing `useAuth`, shadcn components, and `sonner`.

State must cover:

```ts
type PageView = "current" | "history";
type AuditMode = "single" | "bulk";
type VerdictFilter = "all" | "PASS" | "WARN" | "FAIL" | "UNKNOWN";
type ResultSort = "completion" | "safety" | "latency" | "reputation" | "reliability";
```

Setup controls:

- Single/Bulk Tabs;
- labeled proxy input for single;
- labeled `.txt` dropzone/file trigger for bulk;
- attempts number 1–10;
- timeout number 2,000–60,000;
- concurrency number 1–20 in bulk;
- reputation toggle default on;
- browser toggle default off and browser concurrency note;
- disabled/loading primary `Run audit` state;
- safe inline validation without echoing raw credential-bearing input in errors.

Creation switches to Current view and selects returned job.

- [ ] **Step 3: Implement polling, progress, cancellation, and terminal states**

Use an abortable polling effect:

```ts
useEffect(() => {
  if (!password || !selectedJobId) return;
  const controller = new AbortController();
  const delay = activeStatus ? 1200 : 15000;
  void loadJob(controller.signal);
  const timer = window.setInterval(() => void loadJob(controller.signal), delay);
  return () => { controller.abort(); window.clearInterval(timer); };
}, [password, selectedJobId, activeStatus, loadJob]);
```

Render:

- compact source/options summary;
- progress value from checked/total;
- PASS/WARN/FAIL/UNKNOWN live counts;
- elapsed and rate only with sufficient completed samples;
- Cancel button for queued/running and `Cancelling…` disabled state;
- interrupted/error/persistence-warning banners;
- `New audit` terminal action.

Do not announce every poll; live region wraps state transitions/progress summary only.

- [ ] **Step 4: Implement results toolbar and responsive result rendering**

Derived data must filter/search/sort in `useMemo` without mutating job results.

Search fields: redacted host, exit IP, ASN, organization/ISP, country, and risk codes. Sort null values last. Verdict copy:

```ts
const VERDICT_COPY = {
  PASS: "Safe for measured conditions",
  WARN: "Review warnings",
  FAIL: "Rejected by safety policy",
  UNKNOWN: "Insufficient evidence",
};
```

Desktop: shadcn Table with specified columns. Mobile: stacked list rows via CSS breakpoint; no separate data model. Export buttons call Task 2 Blob downloader and revoke object URLs after download.

- [ ] **Step 5: Implement the evidence Sheet**

Use existing `Sheet`, `ScrollArea`, `Badge`, and semantic tokens. Render all ten approved sections from the selected `ProxyAuditResult`.

Rules:

- every nullable field uses `Unknown`;
- raw evidence uses sanitized result only;
- provider unavailable/error stays visible;
- browser audit shows `Not requested`, `Unavailable`, or measured evidence distinctly;
- risk factors show severity, code, message, and structured evidence;
- sheet title uses redacted proxy identity;
- desktop width is readable (`sm:max-w-xl`/`lg:max-w-2xl`), mobile full width.

- [ ] **Step 6: Implement Current/History workflow**

History tab:

- loads latest 50 jobs;
- newest first;
- shows source/mode, timestamp, duration, total/verdict counts, browser flag, status;
- actions: Open, Export JSON, Export CSV, Delete;
- delete uses accessible existing Dialog confirmation, disallows active jobs, returns focus;
- empty state has `Start an audit` action.

- [ ] **Step 7: Apply focused Operate-mode CSS**

Create `src/components/auditor.css` and import it only in the page.

- preserve dark control-room palette and 12 px surfaces;
- one border/elevation treatment, no nested cards or decorative gradients;
- 44 px minimum interactive targets;
- tabular numeric values;
- verdict tones pair icon + text;
- toolbar wraps cleanly;
- table-to-stacked-list under 768 px;
- evidence sheet and forms avoid horizontal overflow at 390 px;
- focus-visible/error/disabled/loading/selected/hover states;
- 150–250 ms state transitions;
- disable new transitions/animations under `prefers-reduced-motion`.

- [ ] **Step 8: Update documentation**

Add a concise dashboard section to README:

- open `/auditor` or sidebar `Safety Auditor`;
- Single/Bulk support;
- jobs persist redacted history;
- browser audit optional and costly;
- exports sanitized;
- page never mutates 9Router.

- [ ] **Step 9: Run compile and focused behavioral checks**

```bash
node --import tsx --test tests/auditor-jobs.test.ts tests/auditor-api.test.ts
npm run typecheck
npm run lint
npm run build
```

Expected: all focused tests pass; TypeScript/lint/build exit 0.

- [ ] **Step 10: Run bounded browser verification**

Start the real app against localhost-only auditor fixtures, never production 9Router/provider credentials.

One inspection round covers desktop 1440×900 and mobile 390×844:

1. Sidebar entry visible, active, collapsed tooltip works.
2. Create single job and bulk upload job.
3. Observe progress/counts, cancellation, terminal state.
4. Search/filter/sort results.
5. Open every evidence section and unknown/unavailable states.
6. Export sanitized JSON/CSV; verify no password.
7. Open/delete history with confirmation.
8. Verify keyboard focus, mobile sheets, 44 px targets, reduced motion, no horizontal overflow.

Fix all observed defects in one batch, then perform one confirmation pass only.

Run Impeccable detector once after final UI changes:

```bat
C:\Users\minhmice\.agents\skills\impeccable\scripts\impeccable.cmd detect --json src/components/app-sidebar.tsx "src/app/(dashboard)/auditor/page.tsx" src/components/auditor.css
```

- [ ] **Step 11: Commit Task 3**

```bash
git add src/components/app-sidebar.tsx src/app/'(dashboard)'/auditor/page.tsx src/components/auditor.css README.md
git commit -m "feat(auditor-ui): add dashboard safety audit workspace"
```

---

### Task 4: Whole-Feature Verification and Cleanup

**Files:**
- Modify only files required by verification findings.
- Delete throwaway fixture/export artifacts created during smoke verification.

- [ ] **Step 1: Verify repository state and call-site migration**

Confirm:

- no raw credentials in `data/auditor-history.json` or exports;
- no route/import aliases or duplicate sidebar implementation added;
- `/auditor` imports client HTTP helpers, not auditor core directly;
- server job manager imports only public `src/auditor/index.ts`;
- existing Diagnostics/Proxies behavior remains unchanged.

- [ ] **Step 2: Run full verification**

```bash
npm run typecheck
npm run lint
npm test
npm run test:auditor
npm run test:integration
npm run build
```

Expected: every command exits 0 with no new warnings from changed files.

- [ ] **Step 3: Run final security assertions**

Use a temporary single/bulk job containing `alice:secret-value` and assert:

```text
secret-value not present in API response
secret-value not present in data/auditor-history.json
secret-value not present in JSON export
secret-value not present in CSV export
secret-value not present in captured server logs
```

Delete temporary history/export artifacts afterward.

- [ ] **Step 4: Commit verification fixes only if needed**

```bash
git add <only files changed by verified fixes>
git commit -m "fix(auditor-ui): address integration verification findings"
```
