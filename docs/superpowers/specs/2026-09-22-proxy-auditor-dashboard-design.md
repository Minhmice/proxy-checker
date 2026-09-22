# Proxy Safety Auditor Dashboard Design

## Summary

Add a `Safety Auditor` entry to the authenticated dashboard sidebar and create `/auditor`, a production operations surface over the standalone `checkProxy()` API. The page supports single-proxy and bulk-file audits, background execution, cancellation, server-side history, search/filter/sort, JSON/CSV export, and an evidence drawer. Browser/WebRTC auditing is optional per job and disabled by default.

This surface evaluates measurable safety and network quality. It does not describe proxies as undetectable, clean, anti-fraud safe, or suitable for bypassing controls.

## Goals

- Make the standalone auditor accessible from the dashboard without coupling core code to Next.js or 9Router.
- Support single proxy input and bounded bulk `.txt` audit jobs.
- Keep long audits alive across page reloads and expose honest progress/cancellation states.
- Persist redacted results and job summaries server-side for operational review.
- Present component scores, raw evidence status, risks, and recommendations without false certainty.
- Export sanitized JSON and CSV.
- Remain usable on desktop, tablet, and mobile with keyboard and reduced-motion support.

## Non-goals

- No automatic promotion, activation, deletion, or rename in 9Router.
- No storage of proxy passwords in job/history files, UI state, logs, errors, export, or activity feed.
- No WebSocket/SSE transport; use existing polling convention.
- No provider-key editing on this page; environment/server configuration owns provider credentials.
- No browser audit by default and no browser fingerprint modification.
- No unlimited history or unlimited evidence retention.

## Navigation

Add `Safety Auditor` immediately after `Diagnostics` in the sidebar Workspace group:

```ts
{ href: "/auditor", label: "Safety Auditor", icon: ShieldCheck }
```

Reuse the current shadcn sidebar item, tooltip, active state, collapsed icon rail, mobile sheet, focus ring, and 44 px target behavior. Do not add another navigation component.

## Route and Component Boundary

Create:

```text
src/app/(dashboard)/auditor/page.tsx
src/components/auditor.css
src/lib/auditor-api.ts
src/server/auditor-jobs.ts
```

The page and client helpers consume HTTP contracts only. The server job manager is the only dashboard layer importing `checkProxy()` from `src/auditor/index.ts`. Auditor core never imports dashboard/server/9Router code.

## Job Model

```ts
type AuditorJobStatus = "queued" | "running" | "cancelling" | "cancelled" | "done" | "error";
type AuditorJobMode = "single" | "bulk";

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
  browserAudit: boolean;
  attempts: number;
  timeoutMs: number;
  concurrency: number;
  results: AuditorJobResult[];
  error: string;
}
```

`AuditorJobResult` stores `ProxyAuditResult` with redacted proxy identity only. Raw input credentials exist only in memory while the job executes and are discarded afterward.

## Persistence

Persist to `data/auditor-history.json` with temp-file-plus-rename atomic writes.

Retention:

- latest 50 jobs;
- latest 500 result records per job in persisted history;
- current running jobs retain all in-memory results needed for immediate export;
- completed export is generated before in-memory full results are released;
- UI labels capped history as latest evidence when a job exceeded 500 results.

A corrupt history file is treated as empty and reported in the server log without crashing the app. On restart, persisted `queued`, `running`, or `cancelling` jobs become `error` with `Interrupted by server restart`; the app never displays a ghost-running job.

## Credentials and Redaction

Request bodies may contain raw proxy credentials for execution. Before any persistence/logging/response:

- parse through auditor parser;
- retain only `RedactedProxyInfo`;
- sanitize thrown errors;
- never echo invalid raw input;
- never include raw upload lines in invalid-line errors;
- exports use already-redacted job results.

No password is written to `data/auditor-history.json` or browser storage.

## API Contracts

All routes use existing dashboard Basic control-password authentication.

### Create job

`POST /api/auditor/jobs`

Single request:

```json
{
  "mode": "single",
  "proxy": "socks5://user:password@example.com:1080",
  "options": {
    "attempts": 5,
    "timeoutMs": 15000,
    "reputation": true,
    "browser": false
  }
}
```

Bulk request:

```json
{
  "mode": "bulk",
  "name": "proxies.txt",
  "content": "one proxy per line",
  "options": {
    "attempts": 5,
    "timeoutMs": 15000,
    "concurrency": 5,
    "reputation": true,
    "browser": false
  }
}
```

Validation:

- non-empty input;
- `.txt` filename for uploaded files;
- 5 MB upload ceiling;
- at most 10,000 non-empty lines;
- attempts 1–10;
- timeout 2,000–60,000 ms;
- network concurrency 1–20;
- browser bulk concurrency is always capped at 2;
- duplicate normalized proxy endpoints are audited once and counted as duplicates in response metadata;
- invalid lines become sanitized per-result errors rather than failing the whole bulk job.

Response: HTTP 202 `{ job }`.

### Read job

`GET /api/auditor/jobs/:id`

Returns current job, progress, and persisted/capped results. Unknown ID: 404.

### Cancel job

`POST /api/auditor/jobs/:id/cancel`

- queued job becomes cancelled immediately;
- running job enters cancelling, aborts active audits through `AbortController`, stops scheduling new work, waits for active checks to settle, then becomes cancelled;
- done/error/cancelled returns 409.

### History

- `GET /api/auditor/history?limit=50`
- `DELETE /api/auditor/history/:id`

Delete running/cancelling job: 409. Completed deletion requires explicit UI confirmation.

### Export

- `GET /api/auditor/jobs/:id/export?format=json`
- `GET /api/auditor/jobs/:id/export?format=csv`

Running jobs may export a clearly labeled partial snapshot. JSON and CSV use current CLI formatter/redaction rules. CSV keeps formula-injection protection and requested audit columns.

## Execution and Concurrency

The job manager owns one in-memory queue. It calls public `checkProxy()` for each normalized input.

- default bulk network concurrency 5;
- max network concurrency 20;
- single audit concurrency 1;
- browser-enabled work uses a separate semaphore capped at 2;
- a cancelled job passes a shared abort signal to active checks;
- provider/browser unavailable evidence does not crash the job;
- an individual proxy error becomes one `UNKNOWN` or `FAIL` result based on core evidence; other inputs continue;
- progress/state is published after each completed item and persisted with a short throttle plus final forced write.

Do not reimplement auditor scoring, transports, provider calls, browser logic, or redaction in the job manager.

## Page Information Architecture

### Header

- Title: `Proxy Safety Auditor`
- Description: `Measure transport security, privacy, reputation, and reliability before a proxy is trusted.`
- Secondary action: `New audit` when viewing a result/history job.

### Setup surface

One operational surface, not nested cards.

Mode control: `Single | Bulk`.

Single fields:

- Proxy URL/object-compatible string input;
- timeout;
- attempts.

Bulk fields:

- accessible drag/drop `.txt` upload;
- selected filename and unique line count;
- concurrency;
- timeout;
- attempts.

Shared toggles:

- `Reputation providers` default on;
- `Include browser leak audit` default off, with concise cost note;
- browser bulk concurrency note `Limited to 2 browsers`.

Primary action: `Run audit`.

### Running state

After creation, setup collapses into a progress strip:

- source/mode;
- checked/total and percentage;
- PASS/WARN/FAIL/UNKNOWN counts;
- elapsed and average rate;
- cancelling/cancelled status;
- `Cancel audit` destructive secondary button.

Poll every 1.2 seconds while queued/running/cancelling, then every 15 seconds when viewing a terminal job/history list. Abort stale client requests during navigation/unmount.

### Summary

Show real counts only:

- PASS;
- WARN;
- FAIL;
- UNKNOWN;
- Completed.

Pair color with text/icon. UNKNOWN is neutral/incomplete, never green.

### Results toolbar

- Search redacted proxy host, exit IP, ASN, ISP, country, risk code;
- verdict filter `All / PASS / WARN / FAIL / UNKNOWN`;
- sort by safety score, latency, reputation, reliability, or completion order;
- `Export JSON` and `Export CSV`;
- active filter count and clear action.

### Results table

Dense desktop columns:

- Proxy;
- Verdict;
- Overall + component scores;
- Exit IP / network;
- TLS / privacy evidence;
- reliability;
- action.

Null/unknown measurements display `Unknown`, not zero, false, or dash when ambiguity matters.

### Evidence drawer

Selecting a row opens a right-side sheet using existing shadcn Sheet/ScrollArea components. It does not cover primary actions on desktop and becomes full-screen on mobile.

Sections:

1. Overview and redacted identity;
2. Connectivity timings;
3. Exit-IP observations and consistency;
4. TLS certificate/protocol/cipher/ALPN evidence;
5. DNS/header/content-integrity evidence;
6. Network classification and evidence source;
7. Reputation provider statuses and sanitized raw evidence;
8. Stability/rotation distributions;
9. Risk factors and recommendations;
10. Browser audit evidence or explicit unavailable/untested state.

Provider `unavailable` and `error` states are visible; absent evidence is never hidden as success.

## History Surface

Top-level page tabs: `Current | History`.

History rows show:

- source/mode;
- created/completed time;
- duration;
- total and verdict counts;
- browser-audit flag;
- terminal state;
- reopen/export/delete actions.

The newest terminal or active job opens by default. Empty history explains how to start the first audit.

## Responsive Behavior

Desktop ≥1280 px:

- normal dashboard sidebar/right rail;
- results table fills main area;
- evidence sheet from right at readable width.

Tablet 768–1279 px:

- hide lower-priority table columns;
- evidence sheet overlays content;
- toolbar wraps without horizontal clipping.

Mobile <768 px:

- setup fields stack;
- results become stacked list rows with verdict, proxy, overall score, exit IP, latency, and action;
- filters/export move into a Sheet;
- evidence is full-screen Sheet;
- 44 px minimum controls, native file input visually hidden behind labeled trigger;
- no horizontal overflow.

## Accessibility and Motion

- WCAG AA contrast;
- form labels and descriptions linked with `htmlFor`/`aria-describedby`;
- progress uses `role=status` and polite live updates without announcing every poll;
- errors use `role=alert`;
- dialogs/sheets trap focus and restore it on close;
- table/list controls keyboard accessible;
- status always icon + text;
- 150–250 ms state transitions only;
- all new motion disabled under `prefers-reduced-motion`.

## Copy

Use defensive operations language:

- PASS: `Safe for measured conditions`;
- WARN: `Review warnings`;
- FAIL: `Rejected by safety policy`;
- UNKNOWN: `Insufficient evidence`.

Never use `undetectable`, `clean proxy`, `stealth`, `bypass`, `anti-fraud safe`, or equivalent language.

## Error Handling

- Auth: 401 existing control-password behavior.
- Invalid request: 400 with safe actionable message.
- Busy/invalid lifecycle transition: 409.
- Unknown job: 404.
- Upload too large: 413.
- Browser/provider optional infrastructure unavailable: result evidence, not whole-job 500.
- Persistence failure: job continues in memory, server logs error, UI shows history persistence warning.
- Server restart interruption: terminal error state, never ghost running.

## Testing

### Job manager

- single and bulk job creation;
- bounded network/browser concurrency;
- cancellation stops scheduling and aborts active work;
- restart reconciliation;
- atomic persistence and retention caps;
- invalid-line isolation and credential non-persistence;
- provider/browser unavailable does not crash job;
- export redaction and CSV formula safety.

### API

- auth and request validation;
- status codes 202/400/404/409/413;
- progress snapshots;
- cancel idempotency/conflicts;
- history delete protection;
- JSON/CSV response headers and partial export labels.

### UI

- Single/Bulk mode switching;
- input/upload validation;
- polling and cancellation;
- search/filter/sort;
- empty/loading/error/interrupted states;
- drawer sections and unknown evidence;
- keyboard/focus/live-region behavior;
- desktop/mobile layout and no horizontal overflow.

### Runtime verification

Use localhost auditor fixtures only. Do not connect smoke tests to production 9Router or real provider credentials. Verify desktop and mobile in one browser pass, fix defects in one batch, then perform one confirmation pass.

## Files Expected to Change

```text
src/components/app-sidebar.tsx
src/app/(dashboard)/auditor/page.tsx
src/components/auditor.css
src/lib/auditor-api.ts
src/server/auditor-jobs.ts
src/server/server.ts
src/lib/types.ts
package.json
README.md
tests/auditor-jobs.test.ts
tests/auditor-api.test.ts
```

Use existing shadcn Sidebar, Button, Input, Progress, Sheet, ScrollArea, Table, Tabs, Badge, and toast components. Do not introduce another UI library or production dependency.
