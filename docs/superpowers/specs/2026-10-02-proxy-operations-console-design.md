# Proxy Operations Console Design

**Date:** 2026-10-02  
**Status:** Design approved; implementation plan pending spec review  
**Scope:** `/proxies`, unified proxy APIs, SQLite read model, audit contract, audit jobs, authentication and export security

## Goal

Turn `/proxies` into one explainable Proxy Operations Console where an operator can identify current proxy health, distinguish routing state from audit verdict, run single or bulk audits, understand PASS/WARN/FAIL reasons, inspect evidence and regression history, import with preview, export safely, and recover visibility after a server restart.

## Product mode and visual direction

- **Mode:** Operate.
- **Visual authority:** Preserve the existing minhmiceProxy dark control-room system in `DESIGN.md`: deep navy surfaces, electric blue primary actions, violet secondary accent, semantic green/amber/red states, dense data-first tables, Inter/system typography, monospace proxy endpoints and metrics.
- **Interaction thesis:** one stable list context, row-local actions, a right-side inspector for evidence, and a persistent audit-job status surface. Do not replace the current workspace with a separate Intelligence route.
- **Component rule:** compose existing shadcn primitives and tokens. Use `Table`, `Checkbox`, `Badge`, `Sheet`, `Dialog`, `Tabs`, `Progress`, `DropdownMenu`, `ScrollArea`, `Alert`, `Button`, `Input`, `Select`/existing equivalent, and `Separator`. Do not add a UI dependency or hand-roll a parallel component system.

## Current facts and boundaries

- `src/app/(dashboard)/proxies/page.tsx` is currently a large client component handling list fetch, debounce, pagination, sync, import, export, add, single check, copy, and drawer state.
- `src/components/proxy-detail-drawer.tsx` currently shows connection summary, four basic metrics, single check, and ten-entry history.
- `src/server/proxy-intelligence-repository.ts` computes unified status from current proxy status and audit history. Backend enum remains `working | regressed | dead` for compatibility; presentation labels change to `Healthy | Regressed | Never verified`.
- `src/server/proxy-intelligence-db.ts` uses Node `DatabaseSync`, WAL, foreign keys, and `finished_at` for audit completion time. Existing `(proxy_key, finished_at DESC)` index already matches history access; do not add an index using nonexistent `checked_at`.
- `src/server/proxy-intelligence-jobs.ts` runs concurrent audits and persists audit results, but job metadata currently lives only in an in-memory `Map`.
- The auditor already measures exit IP, direct baseline, headers, TLS, content integrity, stability/rotation, reputation enrichment, and optional browser/WebRTC behavior. DNS leak detection, actual UDP forwarding, and timezone are not fully measured today.
- SSRF validation already checks multiple A/AAAA results, private/special ranges, target-IP pinning, and rejects redirects. Preserve these protections; do not weaken them or claim unsupported measurements.
- Reputation already has caching, provider rate limiting, and quota degradation. Unavailable enrichment must remain distinguishable from proxy failure.
- Sensitive API handlers currently rely on outer routing/auth behavior and client helpers pass a password-like value. Handler-level authorization and session semantics are required before exposing new bulk/export operations.

## Domain model

Keep three distinct concepts in every list/detail response:

```text
health        Healthy | Regressed | Never verified
poolTier      Active | Reserve | Unassigned
lastVerdict   PASS | WARN | FAIL | UNKNOWN
```

Backend storage may retain `working | regressed | dead`; frontend must not derive health from history. `dead` is presented as `Never verified` only when the backend confirms no successful historical verification. A stale last audit is an additional freshness signal, not a fourth health state.

## API contracts

### Unified proxy list

`GET /api/proxies/unified` accepts URL-backed filters:

```ts
type UnifiedProxyListQuery = {
  q?: string;
  health?: "all" | "working" | "regressed" | "dead";
  protocol?: "all" | "http" | "https" | "socks4" | "socks5";
  source?: string;
  auditAge?: "all" | "never" | "24h" | "7d" | "stale";
  sort?: "health" | "lastChecked" | "latency" | "endpoint";
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};
```

Response becomes:

```ts
interface UnifiedProxyResponse {
  items: UnifiedProxyListItem[];
  pagination: { page: number; pageSize: number; total: number };
  facets: {
    all: number;
    working: number;
    regressed: number;
    dead: number;
    protocols: Record<string, number>;
  };
  meta: { generatedAt: string };
}

interface UnifiedProxyListItem {
  proxyKey: string;
  host: string;
  port: number;
  protocol: "http" | "https" | "socks4" | "socks5";
  source: string | null;
  poolTier: "active" | "reserve" | null;
  health: "working" | "regressed" | "dead";
  everPassed: boolean;
  lastAudit: {
    id: string;
    verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN";
    checkedAt: string;
    exitIp?: string;
    country?: string;
    isp?: string;
    latencyMs?: number;
    overallSafety?: number;
    primaryReasonCode?: string;
  } | null;
}
```

The existing response may be adapted compatibly during migration, but all new UI code uses this semantic shape. Do not add four count requests; facets come from the same read model query.

### Audit detail

`GET /api/proxies/:proxyKey/audit-detail` returns:

```ts
interface ProxyAuditDetail {
  auditId: string;
  proxyKey: string;
  verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN";
  scores: {
    overallSafety: number | null;
    transportSecurity: number | null;
    privacy: number | null;
    reputation: number | null;
    reliability: number | null;
  };
  exit: {
    ip?: string;
    country?: string;
    region?: string;
    isp?: string;
    asn?: string;
    timezone?: string;
  };
  reasons: AuditReason[];
  probes: AuditProbe[];
  checkedAt: string;
  scoringVersion: string;
  provenance: AuditProvenance;
}

type AuditReason = {
  code:
    | "EXIT_NOT_VERIFIED"
    | "ORIGIN_IP_LEAK"
    | "DNS_LEAK"
    | "TLS_PIN_MISMATCH"
    | "CONTENT_MODIFIED"
    | "UNSTABLE_EXIT"
    | "HIGH_REPUTATION_RISK";
  severity: "info" | "warning" | "critical";
  probe: string;
  summary: string;
};

type AuditProbe = {
  name: string;
  status: "PASS" | "WARN" | "FAIL" | "UNSUPPORTED" | "SKIPPED" | "ERROR";
  durationMs?: number;
  summary: string;
  evidence?: unknown;
};

type AuditProvenance = {
  auditorVersion: string;
  scoringVersion: string;
  probeVersions: Record<string, string>;
  timeoutMs: number;
  baseline?: { id: string; ip?: string; capturedAt: string; networkFingerprint?: string };
  providers?: Array<{ name: string; checkedAt: string; cacheState: "fresh" | "stale" | "unavailable" }>;
  browser?: { engine: string; version?: string };
};
```

Reason codes are backend-owned semantic data. Frontend renders them and does not infer causes from prose, score thresholds, or raw JSON.

### Single audit

`POST /api/proxies/check` accepts `{ proxyKey }`, requires handler-level auth, executes the standard `checkProxy` pipeline, persists one audit snapshot plus typed risks and proxy snapshot fields in one short transaction, and returns the updated list item plus `ProxyAuditDetail`.

The row enters a non-verdict `checking` UI state while the request is pending. No optimistic PASS/WARN/FAIL is allowed.

### Bulk audit jobs

`POST /api/intelligence/jobs` accepts either selected `proxyKeys` or a canonical filter plus options. It returns a job ID and initial counters. The existing worker pool remains the execution engine.

`GET /api/intelligence/jobs/:id` returns persisted metadata and live runtime state. `POST /api/intelligence/jobs/:id/cancel` requests cancellation. After restart, persisted `queued`/`running` jobs become `interrupted`; the API must not silently return 404 for work the user previously started.

Job shape:

```ts
interface AuditJob {
  id: string;
  state: "queued" | "running" | "completed" | "cancelled" | "failed" | "interrupted";
  total: number;
  completed: number;
  passed: number;
  warned: number;
  failed: number;
  cancelled: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  options: { concurrency: number; timeoutMs: number; attempts: number; browser: boolean; reputation: boolean };
  error?: string;
}
```

### Import and export

Import adds a preview step. Client preview is display-only; server reparses with the canonical parser and reports `totalLines`, `valid`, `duplicates`, and `invalid` before commit. Import response retains inserted/updated/invalid/duplicates counts and includes a stable set of imported keys for optional follow-up audit.

Export uses a shadcn dialog:

- Scope: current filters or selected keys.
- Format: `txt` or `csv`.
- Credentials: unchecked by default.
- Enabling credentials shows explicit plaintext-secret warning and requires confirmation.

Backend independently authorizes credential export, never logs plaintext credentials, and records an audit event without secret values.

## Authentication and security

- Keep middleware/outer route rejection as an early defense, but require auth inside `handleProxiesUnified`, `handleIntelligence`, and export handlers before parsing sensitive request bodies or executing operations.
- Remove password/token query authentication for new flows. Preserve only a controlled compatibility path long enough to migrate existing clients, with no new callers.
- Prefer a server-validated session cookie: `HttpOnly`, `SameSite=Lax` or `Strict` according to the existing login flow, and `Secure` when served over HTTPS. Client API helpers no longer accept or send raw password on every request.
- Do not expose credentials in list, detail, history, error, activity, or audit logs.
- Preserve SSRF A/AAAA validation, special-range blocking, DNS pinning, and redirect rejection. If redirect support is introduced, validate each destination before following it.
- Unsupported measurements are not failures. Represent unsupported, skipped, provider-unavailable, and transport-error states explicitly.

## Database/read model

Add idempotent migrations to `proxies`:

```sql
last_verdict TEXT;
last_checked_at INTEGER;
last_latency_ms INTEGER;
last_exit_ip TEXT;
last_failure_code TEXT;
ever_passed INTEGER NOT NULL DEFAULT 0;
```

Add:

```sql
CREATE TABLE IF NOT EXISTS audit_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  total INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  warned INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0,
  options_json TEXT
);
```

Use the existing `proxy_audits(proxy_key, finished_at DESC)` index for history. Add protocol/health and source/health indexes only after `EXPLAIN QUERY PLAN` confirms the unified list uses them. Keep `DatabaseSync` operations short; no large scan, import parse, forced checkpoint, or VACUUM on the request thread.

Every audit completion writes:

```text
BEGIN IMMEDIATE
INSERT proxy_audits
INSERT proxy_audit_risks
UPDATE proxies snapshot + lifecycle fields
UPDATE audit_jobs counters/state
COMMIT
```

The job runner may continue network concurrency, but each DB transaction remains per-result and bounded.

## UX structure

Refactor the large page into focused components under `src/components/proxies/` or the existing route-local convention:

- `proxy-summary.tsx`: facets and freshness/sync summary.
- `proxy-toolbar.tsx`: URL-backed search, filters, sort, import/sync/audit/export actions.
- `proxy-table.tsx`: accessible table, status/pool/verdict separation, row actions.
- `proxy-selection-bar.tsx`: selected count, page selection, matching-result selection, bulk actions.
- `proxy-import-dialog.tsx`: file upload, preview, invalid-line view, import and audit CTA.
- `proxy-export-dialog.tsx`: scope, format, credential confirmation.
- `audit-job-indicator.tsx`: running/completed/interrupted jobs with progress and cancel.
- `proxy-detail-drawer.tsx`: inspector surface using Tabs for Overview, Evidence, History, Diagnostics.

The route/page owns data orchestration and URL synchronization; components receive typed props and callbacks. Preserve the existing auth/dashboard shell and shadcn `SidebarProvider`/`SidebarInset` layout.

### Main list

- Summary labels: `All`, `Healthy`, `Regressed`, `Never verified`; pair icon and text with color.
- Toolbar filters persist in URL and survive refresh/back/forward.
- Table shows endpoint/protocol, health, exit/ISP, privacy score, latency, last checked, pool tier and actions. Keep dense rows and monospace endpoint/metric text.
- Single check updates only the targeted row and drawer; do not blank or reload the full table.
- Bulk audit uses the job endpoint, not browser loops of single checks.
- Empty, stale, error, and unconfigured states provide a concrete next action.

### Inspector drawer

The sheet is modal when it overlays/inerts the table. Radix/shadcn Sheet must own focus trap, Escape close, and focus return. Icon-only controls have explicit labels.

Top priority order:

1. Protocol, endpoint, verdict, checked time, exit IP/location/ISP/ASN, latency.
2. Five score cards with nullable/unsupported display.
3. `Why this is PASS/WARN/FAIL` reason list.
4. Probe cards showing status and summary; unsupported is neutral, not red.
5. Regressed panel with last known good, first failure, and changed measurements when available.
6. History rows with verdict, latency, exit, location and reason summary.

Do not show a positive UDP badge unless the backend actually measures it. Current protocol inference must be displayed as `Not measured`/`Unsupported` until a real UDP capability probe exists.

## Audit behavior

- Keep `checkProxy` as the standard unified measurement pipeline.
- Add explicit probe result status and reason mapping without fabricating DNS, UDP, timezone, geo, or fingerprint data.
- Preserve browser isolation. Current implementation launches an isolated browser per audit; if performance work later shares a browser process, each proxy still gets an isolated non-persistent context and closes it after use.
- Keep reputation cache keyed by exit IP. Fresh cache is reused; changed exit IP triggers enrichment; quota/unavailable returns stale/unavailable evidence and does not automatically FAIL the proxy.
- Add provenance to each result so score/rule/provider changes remain explainable.
- Baseline references must identify the baseline capture used by the audit.

## Testing and acceptance

Permanent tests must cover behavior, not wiring:

- Handler-level auth denies direct sensitive API requests without a valid session.
- Query auth is not accepted by new client flows; credentials do not appear in URL/log output.
- Unified response facets, URL filters, status semantics, pool tier, stale state and pagination remain consistent.
- Snapshot migration is idempotent and preserves existing inventory/audit data.
- Audit completion persists audit, risks, proxy snapshot and job counters atomically enough that no completed job lacks its result.
- Restart marks queued/running jobs interrupted and exposes them to the job tray.
- Reason codes and explicit probe statuses survive sanitization and renderable detail response.
- Unsupported DNS/UDP/browser capabilities do not become false failures.
- Reputation cache reuse, exit-IP change, stale data and provider quota exhaustion have distinct outcomes.
- SSRF tests retain A/AAAA/special-range/pinning/redirect protections.
- Single audit patches one row; bulk audit reports progress and cancellation.
- Import preview reports valid/duplicate/invalid before DB mutation; follow-up audit uses returned keys.
- Export credentials are off by default, require explicit confirmation, and never leak into logs.
- Browser smoke test covers URL-persistent filters, table status labels, row-local check, bulk job progress, import preview, export warning, drawer tabs, keyboard close/focus return, and interrupted job state.

## Non-goals

- No rewrite of the auditor transport engine.
- No PostgreSQL migration.
- No cursor pagination before profiling demonstrates offset pagination is a bottleneck.
- No new proxy lifecycle state for unsupported capabilities.
- No frontend inference of audit verdicts, health, reason codes, geo, timezone, DNS leak, UDP support or reputation status.
- No automatic credential export.
- No separate `/intelligence` product surface.
