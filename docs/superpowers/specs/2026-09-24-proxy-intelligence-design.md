# Proxy Intelligence Design

**Date:** 2026-09-24

## Goal

Gộp quick diagnostics và deep safety auditing vào một Proxy Intelligence workflow, lưu proxy inventory và audit history trong SQLite, hỗ trợ server-side bulk filters, audit lại proxy đã lưu, detailed evidence, và export proxy hoạt động tốt từ Settings.

## Scope

In scope:

- Giữ `data/proxies.sqlite3` làm source of truth cho proxy inventory.
- Additive migration cho bảng `proxies`; không xóa hoặc reset dữ liệu cũ.
- Lưu credential plaintext trong SQLite theo quyết định của user; UI, API response, activity log và export mặc định redacted.
- Import `.txt` vào SQLite; file input chỉ là nguồn import, không phải runtime inventory.
- Gộp Diagnostics và Safety Auditor thành trang Proxy Intelligence.
- Giữ quick diagnose và deep safety audit là hai profile khác nhau trong cùng workflow.
- Lưu quick diagnosis mới nhất và từng deep-audit snapshot riêng.
- Audit lại từng proxy đã lưu và audit bulk theo filter trên SQLite.
- Server-side pagination/filtering.
- Detail view: identity, connectivity, exit identity, security, privacy, reputation, risks, evidence, history.
- Export proxy hoạt động tốt từ Settings.
- Redirect compatibility từ `/diagnostics` và `/auditor` về Proxy Intelligence.

Out of scope:

- Không thay đổi quick 9Router sync semantics.
- Không tự xóa proxy khỏi SQLite hoặc 9Router sau audit.
- Không thêm provider reputation mới.
- Không khẳng định `PASS` là an toàn tuyệt đối.
- Không import proxy mới từ 9Router chỉ để bulk audit; bulk action chỉ dùng proxy đã có trong SQLite.
- Không thêm credential encryption trong scope này.

## Terminology and states

Quick diagnose measures current operational connectivity. Deep safety audit measures security, privacy, reputation, reliability, and evidence.

Canonical lifecycle state:

- `working`: connection succeeds and no critical safety risk is present.
- `unstable`: connection works but measured reliability is below the configured threshold.
- `dead`: connection cannot be established or all operational attempts fail.
- `dangerous`: deep audit reports at least one critical security/privacy risk.
- `unknown`: evidence is insufficient to classify the proxy.
- `invalid`: source input cannot be parsed as a proxy.

Audit verdict remains `PASS | WARN | FAIL | UNKNOWN`. Diagnose status remains `working | dead | unknown`; diagnose never creates `dangerous`.

## Data model

Existing `proxies` rows remain intact. Add nullable columns with an idempotent migration:

```sql
ALTER TABLE proxies ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE proxies ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE proxies ADD COLUMN username TEXT;
ALTER TABLE proxies ADD COLUMN password TEXT;
ALTER TABLE proxies ADD COLUMN created_at INTEGER;
ALTER TABLE proxies ADD COLUMN updated_at INTEGER;
```

The migration must tolerate columns already existing. Existing rows receive `source = 'legacy'`, `lifecycle_state = 'unknown'`, and no synthetic audit.

Add tables:

```sql
CREATE TABLE proxy_diagnostics (
  id TEXT PRIMARY KEY,
  proxy_key TEXT NOT NULL REFERENCES proxies(proxy_key) ON DELETE CASCADE,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  error_code TEXT,
  error_message TEXT,
  checked_at INTEGER NOT NULL
);

CREATE TABLE proxy_audits (
  id TEXT PRIMARY KEY,
  proxy_key TEXT NOT NULL REFERENCES proxies(proxy_key) ON DELETE CASCADE,
  verdict TEXT NOT NULL,
  lifecycle_state TEXT NOT NULL,
  overall_score REAL,
  transport_score REAL,
  privacy_score REAL,
  reputation_score REAL,
  reliability_score REAL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT NOT NULL
);

CREATE TABLE proxy_audit_risks (
  id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL REFERENCES proxy_audits(id) ON DELETE CASCADE,
  risk_code TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  explanation TEXT NOT NULL
);

CREATE INDEX proxy_diagnostics_proxy_checked_idx ON proxy_diagnostics(proxy_key, checked_at DESC);
CREATE INDEX proxy_audits_proxy_finished_idx ON proxy_audits(proxy_key, finished_at DESC);
CREATE INDEX proxy_audits_verdict_idx ON proxy_audits(verdict, lifecycle_state);
CREATE INDEX proxies_lifecycle_idx ON proxies(lifecycle_state);
CREATE INDEX proxies_source_idx ON proxies(source);
```

`result_json` stores the full redacted `ProxyAuditResult` snapshot. The typed risk table supports filtering without parsing JSON. Evidence remains inside the redacted snapshot unless a later requirement proves a separate queryable evidence table necessary.

## Import and identity

Every accepted `.txt` line is parsed before insert. Canonical identity is protocol + host + port + username; password updates the stored credential for the same identity only when the imported line supplies one. Malformed lines are not inserted as proxies and remain import-invalid counts.

Existing `proxy_key` values remain stable. New identity keys use the existing project key convention where possible; migration must not rewrite existing keys.

## API and jobs

Add a server-side Proxy Intelligence repository with typed methods:

```ts
listProxies(filter: ProxyInventoryFilter): Promise<ProxyInventoryPage>;
getProxy(proxyKey: string): Promise<ProxyInventoryDetail | null>;
importProxies(input: ProxyImportInput): Promise<ProxyImportSummary>;
createDiagnoseJob(input: ProxySelectionJobInput): Promise<ProxyIntelligenceJob>;
createAuditJob(input: ProxySelectionJobInput): Promise<ProxyIntelligenceJob>;
getJob(id: string): Promise<ProxyIntelligenceJob | null>;
cancelJob(id: string): Promise<ProxyIntelligenceJob>;
exportWorkingProxies(filter: WorkingExportFilter): Promise<ExportResult>;
```

Bulk selection accepts either explicit `proxyKeys` or a validated filter snapshot. Both resolve against SQLite at job creation; credentials never reach the browser job payload.

All job items are isolated: one proxy failure becomes an item result and cannot reject the whole worker pool. Audit snapshots are immutable. Latest summary columns on `proxies` are updated transactionally after each item.

Legacy auditor endpoints may remain during migration, but the unified page must use Proxy Intelligence endpoints. Legacy `/diagnostics` and `/auditor` pages redirect to the unified route.

## Bulk filters

Filters are evaluated in SQLite and support:

- text search over endpoint/host/port
- source
- protocol
- lifecycle state
- latest verdict
- country/ASN/ISP from latest audit snapshot
- minimum reliability
- maximum latency
- audit age (`never`, `stale`, `within 24h`, `within 7d`)
- critical-risk presence

Responses are paginated and return total count plus current page. Browser must never load the full inventory for table rendering.

## Export policy

Settings exposes `Export working proxies`. Default strict policy:

- latest audit verdict is `PASS`
- reliability score is at least 90
- no critical risk
- latest audit is no older than 24 hours
- proxy exists in SQLite

Export supports TXT and CSV. TXT output is an artifact only. Credentials are redacted by default; full credential export requires an explicit confirmation flag and remains protected by the authenticated endpoint.

## UI

The unified page uses existing shadcn primitives and has:

- server-side search/filter controls
- paginated table with selection
- row state, verdict, score, latency, reliability, country/ASN, last diagnose, last audit
- row/detail `Audit again`
- bulk `Quick diagnose selected`, `Safety audit selected`, and `Safety audit filtered`
- progress and cancel state
- detail drawer tabs: Overview, Connectivity, Security, Privacy, Reputation, Risks, History
- redacted credentials

No custom one-off UI primitive is introduced when an existing shadcn component covers the need.

## Error and stability rules

- SQLite initialization/migration runs before API handling and is idempotent.
- Database writes use transactions for each audit result and risk set.
- Export reads a consistent snapshot.
- Job cancellation marks remaining work cancelled and preserves completed snapshots.
- Interrupted jobs are marked interrupted on next startup.
- Error responses redact credentials, authorization headers, cookies, API keys, and passwords.
- Process-level crash diagnosis must retain fatal stack output; item-level network errors are not process-fatal.

## Verification

Required checks:

- migration against a copy of the existing SQLite database and an empty database
- import deduplication and malformed-line handling
- quick diagnosis persistence
- immutable deep-audit snapshots and risk rows
- server-side filter combinations and pagination
- single and bulk audit selection
- cancellation and per-item failure isolation
- redaction in API, logs, and exports
- strict working export policy
- unified page rendering and compatibility redirects
- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run test:integration`
- `npm run build`
