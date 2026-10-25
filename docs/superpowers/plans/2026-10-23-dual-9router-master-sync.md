# Dual 9Router Master Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile two independently writable 9Router instances, deduplicate and write back aggregate usage, and create recoverable encrypted backups every 48 hours without losing concurrent edits or activating a shared proxy twice.

**Architecture:** Keep the existing URL-isolated request/authentication client. Add one version-aware router adapter and a local sync metadata repository; compare normalized A/B snapshots against per-field verified baselines. Store source usage separately from replication receipts. Reconcile through the existing unified maintenance tick, with a durable lease only for dual-router writers and explicit per-operation verification.

**Tech Stack:** Existing TypeScript, Node.js >=22, Hono, better-sqlite3, Drizzle, Node crypto, Next.js, React, shadcn, Node test runner, existing Playwright/Axe.

**Spec:** `docs/superpowers/specs/2026-10-22-dual-9router-master-sync-design.md` (written spec approved in chat).

## Global Constraints

- Dual-master means eventual convergence, not byte-for-byte database copying or active-standby failover.
- Same-field conflicts require review; safe independent changes continue.
- Unsupported remote write/export guarantees are unmet acceptance criteria, not permission to silently narrow scope.
- Router sync and Antigravity rotation remain concurrent; no global maintenance mutex.
- Health/incremental work is due every 10 minutes inside existing maintenance; full reconciliation and backup are due every 48 hours.
- Background sync defaults on after authorized onboarding and may be disabled; manual runs remain independent of that toggle.
- Shared proxy instances MUST NOT run concurrently. Transfer requires confirmed old-owner deactivation; unknown/offline owner blocks activation.
- Rotation uses fresh Gemini session quota only: deactivate at <=20%, reserve candidates >20%, earliest reset first, active limit configurable (default 3). Do not use weekly, Claude, or GPT quota for rotation.
- Live proxy assignments stay put; automatic replacement is dead-proxy-only. Speed reassignment stays manual. Rank rename order is largest rank through rank 1.
- Roles remain Codex GPT 5.6, Sol, Astra, Luna, oc/big-pickle. Gemini/Claude providers remain available, excluded from roles.
- Per-router IDs are mappings, not cross-router identities. Preserve proxy credentials/protocol/port/meaningful path in identity.
- Usage aggregates retain account/provider/model/metric/unit/period/currency scope. Quota is not additive usage.
- Prefer absolute usage write-back with a proven concurrency boundary. Delta fallback requires durable idempotency/receipts; never blindly retry an uncertain mutation.
- Native usage and replicated totals remain distinguishable. Never ingest replication as new usage.
- No guessed remote mutation endpoint, undocumented remote database writes, or probing on live production counters.
- All reconstructive secrets and raw remote snapshots require authenticated encryption with recovery key outside Git. Auth cookies are excluded.
- Never copy active WAL files directly. Restore closes writers and obtains maintenance ownership before replacing files.
- Preserve unrelated edits/staged work. No force-push, amend, unexplained lock deletion, or automatic repository conflict resolution.
- Reuse installed dependencies. No plugin framework, generic CRDT library, extra listener, or separate maintenance timer.
- Every exported signature change requires language-server references before editing; search duplicate callers/contracts afterward.
- Tests exercise consumer behavior, boundaries, conflicts, and recovery. Run complete affected files, not selected expected-to-flip cases.
- Production API/UI code remains unchanged during planning. Implementation starts only after execution-mode selection.

## Evidence and execution gates

The deployed API's export/import and usage mutation semantics are unknown. Task 1 is required evidence collection, not a placeholder implementation. Record verified endpoint/method/payload/response/concurrency/receipt contracts before implementing a remote adapter branch. If no safe endpoint exists, report exactly what is missing, finish independent reachable work, and do not claim full parity/write-back complete. Changing 9Router itself requires a separate approved design; this plan does not authorize an invented endpoint or remote SQLite mutation.

Several units have distinct review boundaries: capability evidence, durable metadata, merge, usage, recovery, orchestration, and UI. Keep them as the task sequence below rather than ship a nominal full-sync feature with an unimplemented adapter. Task 1 may require returning to the design gate if verified remote semantics materially contradict this spec.

## Repository map and dependency order

Existing files inspected during planning:

- `src/server/nine-router-client.ts`: URL-local cookies/login and remote requests; extend this, do not duplicate authentication.
- `src/server/unified-sync-coordinator.ts`: concurrent router/rotation/fleet cycle.
- `src/server/server.ts`: scheduled maintenance, settings listener, currently invokes backup every 30 minutes and on settings changes.
- `src/server/api/app.ts`: mounts `/api/ninerouter`; mount new `/dual` routes before the legacy wildcard namespace.
- `src/db/common/migrate.ts`: domain union currently proxies/fleet/rotation; validates only the baseline migration. Do not pretend it already executes later journal entries.
- `src/db/common/maintenance-lease.ts`: existing application/maintenance data-directory ownership.
- `src/server/backup/backup-service.ts`, `git-sync.ts`, `src/server/api/routes/backup.ts`, `scripts/backup-sync.ts`: migrate every entry point; existing plaintext and live restore behavior cannot remain as a compatibility path.

New files, exact ownership:

| Unit | Files | Depends on |
| --- | --- | --- |
| Contract and metadata | `src/server/dual-router/types.ts`, `repository.ts`; `src/db/sync/schema.ts`, `client.ts`; `src/db/migrations/sync/0000_baseline.sql`, `meta/_journal.json`, `meta/0000_snapshot.json` | Capability evidence |
| Router adapter/identity | `src/server/dual-router/identity.ts`, `adapter.ts`; extend existing client | Contracts |
| Three-way planning | `src/server/dual-router/merge.ts` | Normalized types |
| Usage | `src/server/dual-router/usage.ts` | Repository, adapter |
| Recovery | `src/server/backup/crypto-envelope.ts`; replace unsafe paths in existing backup/CLI | Contracts, repository |
| Orchestration | `src/server/dual-router/coordinator.ts`, `scheduler.ts` | Merge, usage, recovery |
| Controls | `src/server/api/routes/dual-router.ts`, `src/components/settings/dual-router-controls.tsx`; modify settings page, public API/types | Coordinator |

The sync database is `APP_DATA_DIR/router-sync.sqlite3`, a fourth **metadata** domain, not a duplicate inventory. Existing three databases retain their data ownership. Extend domain registration/preflight/backup enumeration to include this file; do not edit historical baseline checksums for existing domains. Use existing versioned migration conventions for the new domain; if later sync migrations are required, implement journal sequencing with upgrade tests before generating them.

## Shared contracts

Task 2 defines these types in `src/server/dual-router/types.ts`. Later tasks import them; they do not invent competing shapes.

```ts
export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
export type Resource = "pool" | "account" | "settings" | "role" | "history";
export type Outcome = "applied" | "rejected" | "conflicted" | "unsupported" | "unknown";
export type RunStatus = "verified" | "partial" | "conflicted" | "blocked" | "busy";
export type Accuracy = "exact" | "approximate" | "incomplete";
export interface Entity {
  key: string;
  resource: Resource;
  localId: string;
  fields: Record<string, Value>;
  revision: string | null;
}
export interface ScopeSnapshot {
  complete: boolean;
  entities: Entity[];
  cursor: string | null;
  observedAt: number;
  error: string | null;
}
export interface Snapshot {
  routerId: string;
  scopes: Record<Resource, ScopeSnapshot>;
}
export interface Baseline {
  resource: Resource;
  key: string;
  field: string;
  value: Value;
  deleted: boolean;
  revision: number;
}
export interface Operation {
  id: string;
  routerId: string;
  resource: Resource;
  key: string;
  field: string | null;
  kind: "create" | "update" | "delete";
  expected: Value;
  expectedRevision: string | null;
  desired: Value;
  dependsOn: string[];
}
export interface Conflict {
  id: string;
  resource: Resource;
  key: string;
  field: string | null;
  revision: number;
  reason: "divergent" | "delete-edit" | "identity" | "ownership" | "credential";
  base: Value;
  a: Value;
  b: Value;
}
export interface MergePlan {
  operations: Operation[];
  conflicts: Conflict[];
  incompleteScopes: Resource[];
}
export interface Capability {
  resource: Resource | "usage";
  read: boolean;
  export: boolean;
  write: boolean;
  conditional: boolean;
  evidence: string;
}
export interface UsageScope {
  accountKey: string;
  provider: string;
  model: string;
  metric: string;
  unit: string;
  currency: string | null;
  periodStart: string;
  periodEnd: string;
}
export interface UsageEvent {
  id: string;
  namespace: string;
  sourceRouterId: string;
  scope: UsageScope;
  amount: string;
  accuracy: Accuracy;
  provenance: "native" | "replicated";
  generation: string;
  cursor: string;
  observedAt: number;
}
export interface UsageWrite {
  operationId: string;
  routerId: string;
  scope: UsageScope;
  ledgerRevision: number;
  strategy: "absolute" | "delta";
  amount: string;
  expectedBoundary: string;
}
export interface Receipt {
  operationId: string;
  outcome: Outcome;
  boundary: string | null;
  evidence: string | null;
}
export interface RunRequest {
  mode: "audit" | "incremental" | "full";
  trigger: "manual" | "scheduled" | "change";
  now: number;
}
export interface RunReport {
  id: string;
  status: RunStatus;
  operations: Array<{ id: string; outcome: Outcome }>;
  conflicts: Conflict[];
  unmetCapabilities: string[];
  verifiedAt: number | null;
}
export interface SyncPolicy {
  enabled: boolean;
  usageWriteBackAuthorized: boolean;
  nextIncrementalAt: number;
  nextFullAt: number;
}
```

These contracts are internal. Preserve real secret values only in encrypted storage, never public conflict payloads. Decimal strings avoid truncating large counters/currency through JSON numbers; validate finite, nonnegative decimal amounts and aggregate compatible units with exact scaled arithmetic. Do not round provider totals silently.

## Task 1: Prove remote capability and define endpoint bindings

**Files:** Create `docs/superpowers/capability-reports/2026-10-23-dual-9router-capability-report.md`; inspect existing client and deployed 9Router docs/source.

**Deliverable:** Resource-by-resource evidence for both registered instances, including whether configured URLs are aliases for one underlying instance.

- [ ] Inventory existing client functions and all readable provider/account/settings/history scopes. Do not narrow the inventory to Antigravity because existing helpers cover only that subset.
- [ ] Read version/API/source evidence; query only documented read endpoints with existing credentials. Keep secrets and raw response payloads out of tracked reports.
- [ ] For each resource, record this exact table shape:

```text
routerId | version | resource | method/path | read/export/import/write |
pagination/completeness | conditional boundary | event identity namespace |
absolute usage semantics | delta dedupe/receipt semantics | evidence | blocker
```

- [ ] Distinguish native usage from imported aggregates; verify reset/generation semantics, globally shared event IDs versus router-local IDs, and whether absolute writes preserve requests arriving concurrently.
- [ ] Classify missing evidence as unknown, proven absence as unsupported. Never run a speculative mutation against live data. Use a disposable instance only for documented write contracts.
- [ ] Before Task 3 concrete endpoint work, append verified request/response examples and response error behavior to the report. Unknown paths are not implemented with guessed calls.
- [ ] Commit only this report. Stop remote write work if prerequisites are unavailable; report them without marking the whole feature done.

## Task 2: Persist metadata, dedupe, and ownership

**Files:** Create types/repository/new sync DB files from map; modify `src/db/common/migrate.ts`, startup/shutdown registration in `src/server/server.ts`, `scripts/db-preflight.ts`, `scripts/db-verify.ts`, and tests that enumerate domain files.

**Interfaces:**

```ts
// Repository factory returns an actual SQLite-backed service, not an in-memory fallback.
openSyncRepository(filePath: string): SyncRepository;
// SyncRepository owns typed transactions using existing Drizzle patterns:
// appendUsage(event: UsageEvent): boolean
// listUsage(scope: UsageScope): UsageEvent[]
// saveBaseline(baseline: Baseline): void
// listBaselines(): Baseline[]
// enqueue(operation: Operation): void
// pendingOperations(): Operation[]
// saveConflict(conflict: Conflict): void
// resolveConflict(id: string, expectedRevision: number, value: Value): boolean
// prepareWrite(write: UsageWrite): void
// recordReceipt(receipt: Receipt): void
// acquireLease(owner: string, now: number, ttl: number): number | null
// renewLease(owner: string, epoch: number, now: number, ttl: number): boolean
// releaseLease(owner: string, epoch: number): void
// getPolicy(): SyncPolicy
// savePolicy(policy: SyncPolicy): void
// finishRun(report: RunReport): void
// lastVerifiedRun(): RunReport | null
// close(): void
```

`SyncRepository` is the exported inferred factory return type. Define the full listed methods in `repository.ts`; use the shared types above. Lease epoch fences stale controller writes after takeover. Router activation ownership is stored by canonical proxy identity, not router-local pool ID. Durably enqueue operations and write intents before network I/O.

- [ ] Write `tests/dual-router-repository.test.ts` with temporary directories and close/reopen behavior. Use this consumer test pattern:

```ts
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-sync-"));
const file = path.join(dir, "router-sync.sqlite3");
const event: UsageEvent = {
  id: "request-1", namespace: "provider-global", sourceRouterId: "A",
  scope: { accountKey: "ag:subject-1", provider: "antigravity", model: "gemini",
    metric: "requests", unit: "count", currency: null,
    periodStart: "2026-10-01", periodEnd: "2026-11-01" },
  amount: "1", accuracy: "exact", provenance: "native", generation: "1",
  cursor: "request-1", observedAt: 1,
};
let repo = openSyncRepository(file);
assert.equal(repo.appendUsage(event), true);
repo.close();
repo = openSyncRepository(file);
assert.equal(repo.appendUsage(event), false);
assert.deepEqual(repo.listUsage(event.scope), [event]);
repo.close();
fs.rmSync(dir, { recursive: true, force: true });
```

- [ ] Run the entire file before implementation; missing module is the initial red state, not a successful test.
- [ ] Create normalized tables for routers, ID mappings, baselines/tombstones, pending operations, conflict decisions, usage events and counter cursors, write intents/receipts, run/policy state, leases/ownership. Uniqueness: `(namespace,eventId)` for events, `(routerId,operationId)` for target operations. Include scope/generation in counter uniqueness.
- [ ] Persist source ingestion and cursor advancement in one transaction. Reject duplicate event ID with different content as an integrity conflict, not an ignored retry. Persist actual sensitive baseline/recovery values encrypted; redaction is only for presentation, not a lossy substitute for recovery data.
- [ ] Add tests for lease expiry/takeover, stale-owner fencing, stale conflict revision, operation reopen/resume, failed migration preserving data, and non-verified reports not advancing `lastVerifiedRun()`.
- [ ] Run full repository and affected DB test files. Add `sync` to baseline registration without changing existing-domain baseline hashes. No new migration engine unrelated to sync needs.
- [ ] Commit only task-owned changes after smoke opening/reopening the real SQLite repository.

## Task 3: Canonical identity and the actual per-target adapter

**Files:** Create `identity.ts`, `adapter.ts`; modify `src/server/nine-router-client.ts`; tests `tests/dual-router-identity.test.ts`, `tests/dual-router-adapter.test.ts`, existing `tests/ninerouter-multi-target.test.ts`.

**Interfaces:**

```ts
poolKey(proxyUrl: string): string;
accountKey(provider: string, subject: string | null, email: string | null): string;
// Throws on identity ambiguity rather than treating a display name as identity.
createRouterAdapter(input: { routerId: string; url: string }): RouterAdapter;
// RouterAdapter = inferred factory return type with methods:
// capabilities(): Promise<Capability[]>
// readState(): Promise<Snapshot>
// apply(operation: Operation): Promise<Receipt>
// readUsage(): Promise<UsageEvent[]>
// writeUsage(write: UsageWrite): Promise<Receipt>
// readReceipt(operationId: string): Promise<Receipt | null>
```

- [ ] Write identity behavior tests, including non-equivalent proxies:

```ts
assert.notEqual(poolKey("http://u:one@host.test:8080"), poolKey("http://u:two@host.test:8080"));
assert.notEqual(poolKey("socks5://host.test:8080"), poolKey("http://host.test:8080"));
assert.notEqual(poolKey("http://host.test:8080/a"), poolKey("http://host.test:8080/b"));
assert.equal(accountKey("antigravity", "subject-1", "a@test.invalid"),
  accountKey("antigravity", "subject-1", "renamed@test.invalid"));
assert.throws(() => accountKey("antigravity", null, null), /identity/i);
```

- [ ] Run complete files red, then implement normalization with URL parsing and provider-specific email semantics. Do not lowercase credentials/path or assume all providers normalize email identically.
- [ ] Use language-server references before extending exported client helpers. Add explicit target overrides consistently for pool/account/settings/history methods needed by the verified capability report; migrate every caller, no alternate auth/request implementation.
- [ ] Implement adapter reads using verified endpoints and pagination. Distinguish unsupported read, failed page, authoritative empty list, and stable completed snapshot. Stable registrations survive URL changes; detect duplicate backing instances before independent counter ingestion.
- [ ] Implement only verified writes. Before mutation compare expected value/revision; use documented conditional updates when available. Resource ordering follows operation dependencies, not arbitrary global serialization.
- [ ] Add failure tests: A credentials never sent to B, one login per URL under concurrent refresh, incomplete page never treated as delete, unsupported write makes no network mutation, timeout after possible mutation returns unknown. Exercise all available providers, not only Antigravity.
- [ ] Run full adapter/identity/multi-target files and disposable API smoke for proven write branches. Commit.

## Task 4: Three-way merge, tombstones, and activation safety

**Files:** Create `src/server/dual-router/merge.ts`, `tests/dual-router-merge.test.ts`.

**Interface:**

```ts
planMerge(input: { a: Snapshot; b: Snapshot; baselines: Baseline[] }): MergePlan;
```

The planner is pure. Coordinator assigns stable operation IDs from run/entity/field/expected/desired state and persists them; replanning does not mint a new idempotency key for an already transmitted mutation.

- [ ] Write red tests for one-sided edit and same-field divergence:

```ts
const scope = (value: string): ScopeSnapshot => ({ complete: true,
  entities: [{ key: "pool-1", resource: "pool", localId: "local-1",
    fields: { name: value }, revision: null }], cursor: null, observedAt: 1, error: null });
const empty = (): ScopeSnapshot => ({ complete: true, entities: [], cursor: null, observedAt: 1, error: null });
const snapshot = (id: string, value: string): Snapshot => ({ routerId: id,
  scopes: { pool: scope(value), account: empty(), settings: empty(), role: empty(), history: empty() } });
const base: Baseline[] = [{ resource: "pool", key: "pool-1", field: "name",
  value: "old", deleted: false, revision: 1 }];
const one = planMerge({ a: snapshot("A", "new"), b: snapshot("B", "old"), baselines: base });
assert.deepEqual(one.operations.map(o => [o.routerId, o.field, o.desired]), [["B", "name", "new"]]);
assert.deepEqual(one.conflicts, []);
const both = planMerge({ a: snapshot("A", "left"), b: snapshot("B", "right"), baselines: base });
assert.equal(both.operations.length, 0);
assert.equal(both.conflicts[0].reason, "divergent");
```

- [ ] Implement field decisions explicitly:

```text
A == B: converge; record acknowledged baseline.
A == base, B != base: apply B to A.
B == base, A != base: apply A to B.
A != base, B != base, A != B: conflict; neither wins automatically.
No baseline: union identifiable additions; disagreeing shared fields conflict; infer no deletion.
Missing entity + complete listing + prior presence: deletion candidate.
Deletion + other-side edit: conflict, keep tombstone.
Incomplete resource: no deletion or destructive operation inferred from it.
```

- [ ] Add tests for different-field merge, unchanged rerun, tombstone replay, credential conflict, changed expected state, ambiguous account keys, partial pagination, and a valid conflict not blocking another entity.
- [ ] Integrate activation rules: account/proxy ownership operations are coupled dependencies. Deactivate old owner, verify inactive, then activate new owner. Block on offline/unknown old owner; skip controller activation when out-of-band duplicate activity is observed. Do not treat an allowed owner/non-owner active mismatch as unresolved configuration drift.
- [ ] Preserve existing policy: dead-proxy-only replacement, Gemini session quota threshold, earliest-reset reserve preference, model-role allowlist, reverse-rank renames. Safety deactivation takes precedence over a conflicting activation request; do not refresh stale quota by copying a newer timestamp onto old data.
- [ ] Run complete merge and existing rotation/unified-sync test modules covering these policies. Commit.

## Task 5: Usage ingestion, exact aggregation, and safe write-back

**Files:** Create `src/server/dual-router/usage.ts`, `tests/dual-router-usage.test.ts`; use repository/adapter contracts.

**Interfaces:**

```ts
aggregateUsage(events: UsageEvent[]): { amount: string; accuracy: Accuracy };
chooseWriteStrategy(input: { absoluteSafe: boolean; deltaIdempotent: boolean }): "absolute" | "delta" | null;
// Mixed scopes are rejected before aggregation, not silently combined.
createUsageService(input: { repository: SyncRepository; adapters: RouterAdapter[] }): UsageService;
// UsageService = inferred return type:
// ingest(): Promise<{ inserted: number; blockedScopes: string[] }>
// writeBack(writes: UsageWrite[]): Promise<Receipt[]>
// resolveUnknown(operationId: string): Promise<Receipt>
```

- [ ] Write red tests for dedupe, precision, and strategy selection:

```ts
assert.equal(chooseWriteStrategy({ absoluteSafe: true, deltaIdempotent: true }), "absolute");
assert.equal(chooseWriteStrategy({ absoluteSafe: false, deltaIdempotent: true }), "delta");
assert.equal(chooseWriteStrategy({ absoluteSafe: false, deltaIdempotent: false }), null);
const scope = { accountKey: "ag:subject-1", provider: "antigravity", model: "gemini",
  metric: "requests", unit: "count", currency: null,
  periodStart: "2026-10-01", periodEnd: "2026-11-01" };
const source = (id: string, amount: string, provenance: "native" | "replicated" = "native"): UsageEvent => ({
  id, namespace: "provider-global", sourceRouterId: "A", scope, amount,
  accuracy: "exact", provenance, generation: "1", cursor: id, observedAt: 1,
});
assert.equal(aggregateUsage([source("large", "9007199254740993"), source("extra", "1")]).amount, "9007199254740994");
assert.equal(aggregateUsage([source("replicated", "1", "replicated")]).amount, "0");
```

- [ ] Implement namespaced event dedupe and provenance exclusion. Router-local coincident IDs remain separate; provider-global event IDs dedupe across routers. Duplicate ID with changed contents is an integrity conflict. Overlapping first-import history needs a reviewed opening balance.
- [ ] For cumulative counters, store source cursor/generation/last raw amount transactionally with each delta. Repeated snapshot adds zero. Proven reset starts new generation; unexplained decreases block that scope. Never repeatedly sum current totals or use observation time buckets as proof of uniqueness.
- [ ] Implement scaled integer aggregation from decimal strings, reject invalid/negative non-correction inputs and mixed scopes. Preserve incomplete/approximate labels. Counter correction handling requires documented source semantics, not silent subtraction.
- [ ] Persist UsageWrite intent before sending. Require proven absolute boundary/CAS/import or approved quiescent window. Delta requires durable receipt/dedupe. Never choose another strategy while a transmitted write is unknown.
- [ ] Persist per-router receipts independently. Query the documented receipt/boundary after timeout. A changing total does not prove whether a delta applied. Unknown without proof remains blocked; no blind retry.
- [ ] Add tests for source reset, stale checkpoint, concurrent native request during absolute write, delta timeout after commit, crash before receipt save, same operation replay, reflected write-back not re-ingested, currency/period mismatch, and no endpoint leaving an explicit unmet capability.
- [ ] Run the entire usage module plus repository tests. Smoke supported usage writes on a disposable API only; mocks cannot prove deployed idempotency. Commit.

## Task 6: Encrypted backup and offline-only restore cutover

**Files:** Create `src/server/backup/crypto-envelope.ts`; modify `backup-service.ts`, `git-sync.ts`, `src/server/api/routes/backup.ts`, `scripts/backup-sync.ts`, `src/server/server.ts`, current backup tests; add `tests/dual-router-backup.test.ts`.

**Interfaces:**

```ts
sealSnapshot(plaintext: Uint8Array, key: Uint8Array): Uint8Array;
openSnapshot(envelope: Uint8Array, key: Uint8Array): Uint8Array;
// AES-256-GCM, exactly 32-byte recovery key, versioned header, random 12-byte nonce,
// authenticated manifest/header, 16-byte tag. Invalid version/key/tag fails closed.
createRecoveryBackup(input: { runId: string; status: RunStatus; snapshots: Snapshot[] }): Promise<string>;
// returns manifest location after atomic publication; never plaintext secret material.
restoreRecoveryBackup(input: { manifestPath: string; confirmed: boolean }): Promise<void>;
// CLI/offline maintenance owner only, never replace active live DB files from HTTP.
```

- [ ] Write red roundtrip/tamper tests:

```ts
const key = crypto.randomBytes(32);
const secret = Buffer.from("credential-bearing snapshot");
const first = sealSnapshot(secret, key);
const second = sealSnapshot(secret, key);
assert.deepEqual(Buffer.from(openSnapshot(first, key)), secret);
assert.notDeepEqual(first, second);
const damaged = Uint8Array.from(first);
damaged[damaged.length - 1] ^= 1;
assert.throws(() => openSnapshot(damaged, key));
assert.throws(() => openSnapshot(first, crypto.randomBytes(32)));
```

- [ ] Implement versioned AES-GCM envelope with key loaded outside Git through a runtime secret. Missing key blocks secret-bearing snapshots and managed reconciliation mutation; it must not disable existing urgent safety deactivation. Screen raw payloads/cookies before inclusion, and encrypt whole DB snapshots because they can contain proxy credentials.
- [ ] Build recovery sets containing four local DBs, settings, both router snapshots, baselines/tombstones/conflicts, ledger/cursors/intents/receipts, capabilities and manifests. Consistent SQLite backup API produces snapshots; coordinate only the short local capture boundary, not a global router/rotation mutex.
- [ ] Publish through a temporary recovery directory, verified hashes/schema/foreign keys and atomic rename. Pre-change recovery exists before remote apply; incomplete runs still publish recoverable sets labeled partial/conflicted.
- [ ] Migrate every HTTP/CLI/scheduler caller to the encrypted contract. HTTP restore returns a maintenance-required response with operator instructions instead of touching live writers. CLI requires confirmation, owns the existing maintenance lease, validates the entire set before mutation, keeps pre-restore copy, removes WAL/SHM only after writers are closed, and recovers coherently if swapping a multi-file set fails.
- [ ] Remove obsolete 30-minute automatic backup and settings-change direct Git pushes; enqueue changes through unified sync instead. Keep manual backup callable independently. No plaintext compatibility alias/fallback survives. Existing plaintext backup artifacts are user data: do not delete/rewrite Git history; report exposure and request approval for any historical purge.
- [ ] Implement safe backup Git publication using a dedicated backup worktree/branch in the same private repo, with only encrypted backup paths committed. Preserve main worktree/index/staged changes. Ref updates/pushes use normal Git locking and non-force behavior; branch divergence or unexplained locks are visible blockers, not auto-merged. Retry pending pushes even when no new snapshot exists. No second backup repository.
- [ ] Add full backup tests: wrong/missing key, no cookie inclusion, valid WAL snapshot while writers exist, refuse live restore, recovery after interrupted multi-file restore, unrelated staged work preserved, pending push after offline failure, partial backup status. Update old restore test instead of retaining an unsafe behavior expectation.
- [ ] Run complete backup modules and CLI smoke using temporary directories/disposable local Git remote; never production restore or push as a test. Commit.

## Task 7: Reconciliation lifecycle, scheduling, onboarding, and conflict decisions

**Files:** Create `coordinator.ts`, `scheduler.ts`; modify existing unified coordinator, `app-config.ts`, server startup/shutdown; tests `tests/dual-router-coordinator.test.ts`, `tests/dual-router-scheduler.test.ts`, current settings/unified-sync modules.

**Interfaces:**

```ts
createDualRouterCoordinator(input: {
  repository: SyncRepository;
  adapters: RouterAdapter[];
}): DualRouterCoordinator;
// DualRouterCoordinator = inferred return type:
// run(request: RunRequest): Promise<RunReport>
// resolve(input: { id: string; revision: number; value: Value; actor: string }): Promise<RunReport>
// status(): Promise<RunReport | null>
createDualRouterScheduler(input: {
  repository: SyncRepository;
  coordinator: DualRouterCoordinator;
}): { tick(now: number): Promise<RunReport | null> };
```

- [ ] Write coordinator behavior tests before implementation. Dry-run makes zero remote writes; one-sided safe edit converges and persists baseline; same-field conflict leaves independent work runnable; blocked resource prevents full verified marker but not per-field acknowledgements.
- [ ] Implement this sequence with persisted lease epochs and `try/finally` release:

```text
claim dual-writer lease; read capability/state concurrently; load per-field baselines;
validate reads/identity; prepare plan; for audit return redacted plan without source-state mutation;
persist recovery snapshot; enqueue operations/intents; recheck each precondition;
apply dependency-ready operations; verify changed entities/receipts;
advance acknowledged field baselines, retaining unresolved tombstones/conflicts;
record partial/verified report; publish result recovery set; record Git stage/push separately.
```

- [ ] Persist/onboard two stable router registrations and policy authorization through existing settings validation/public-secret separation. Default enabled once onboarding and recovery key succeed. Store next due times separately from last verified run. Account refresh secrets remain encrypted; dashboard cookies stay per URL and ephemeral.
- [ ] Scheduler computes full due before incremental due; once overdue on startup, run one catch-up. Advance due time after attempting a scheduled slot, maintain retry state/backoff separately, and never label the failed attempt a verified checkpoint. Manual `run()` ignores only background enable toggle, not safety/capability/key checks.
- [ ] Integrate scheduler as due work within existing Promise-based unified tick. Do not add another `setInterval`, serialize router sync with rotation, or keep old backup triggers. Shared entity ownership/preconditions handle overlapping remote changes; dual-writer lease does not stop existing rotation job.
- [ ] Conflict resolution requires expected conflict revision plus authenticated actor. Reject stale decisions; chosen value becomes a normal audited operation, not direct bypass. Independent conflicts continue. Recovery of one router is reconciliation, not primary/standby URL promotion.
- [ ] Add tests for restart/catch-up, disabled auto/manual still works, simultaneous manual/full runs, expired lease owner, offline target not deleting resources, supported post-write unknown resume, conflict stale decision, safety ownership exception versus real drift, missing recovery key, per-field baseline advance without global success.
- [ ] Run full coordinator/scheduler/settings/unified-sync files and smoke actual service with two disposable targets and persisted SQLite. Commit.

## Task 8: Authenticated controls, actual UI proof, and end-to-end delivery

**Files:** Create `src/server/api/routes/dual-router.ts`, `src/components/settings/dual-router-controls.tsx`; modify `src/server/api/app.ts`, `api/types.ts`, `src/server/server.ts`, `src/lib/api.ts`, `src/lib/types.ts`, settings page, `README.md`; add `tests/dual-router-api.test.ts`, `tests/dual-router-integration.test.ts`.

**Public routes:**

```text
GET  /api/ninerouter/dual/status
GET  /api/ninerouter/dual/conflicts
POST /api/ninerouter/dual/audit                  read-only
POST /api/ninerouter/dual/reconcile              confirmed apply
POST /api/ninerouter/dual/conflicts/:id/resolve  revision + chosen value + confirmation
POST /api/ninerouter/dual/usage/write-back       scoped confirmed write, tracked operation IDs
```

- [ ] Mount the new subnamespace before existing `/api/ninerouter` wildcard dispatch. Reuse existing Hono auth/error/body-limit handling; validate enum/scope/amounts/router registration and reject caller-supplied arbitrary URLs. Set actor from auth context, never trust a body-supplied operator identity.
- [ ] Define redacted public DTOs in existing `src/lib/types.ts`: per-router capability/read completeness/health, comparable parity, ownership exceptions, conflict base/A/B/revision, ledger accuracy, per-router write receipts, last verified checkpoint, schedule enable/due state, recovery/Git state. Internal secret-bearing `Entity`/`Snapshot` types never serialize directly.
- [ ] Add client methods in existing `src/lib/api.ts` for the listed routes using current auth/error conventions and AbortSignal lifecycle. Test consumer-visible failures such as unauthorized mutation and stale resolution, not function forwarding.
- [ ] Write API regression tests proving dry-run cannot mutate, auth is required, secret conflicts are redacted, arbitrary URL input is rejected, unknown write outcome remains visible, and partial success does not become `ok: true` cluster convergence.
- [ ] Use one shadcn settings component for side-by-side status, capability blockers, parity versus owner activity, 48-hour due state, toggle/manual controls, audited conflict review, usage units/accuracy, operation IDs and push status. No custom component primitive, no Master/Standby labels, no false green status before data loads. Delegate frontend generation only to project-approved 3.8 Flash Auto if using a generator.
- [ ] Enabling scheduled safe write-back is one-time persisted operator authorization; destructive resolution and restores still prompt. Manual write-back confirmation identifies scope and exact/approximate total. Unknown results disable retry until resolved.
- [ ] Exercise actual authenticated settings surface in browser: both cards, keyboard dialog navigation, audit, conflict decision, offline router, partial/approximate usage, pending remote push. Capture visual proof; close the tab. Existing Axe/browser suite runs only as affected by the changes, no new source-text/default-wiring UI tests.
- [ ] Integration test uses disposable routers/local Git remote and temporary DBs. Start from divergent edits; audit, apply, restart, resume unknown operation, append new native usage after write-back, run again, and restore encrypted snapshot offline. Assert no lost edit, no usage loop, no stale deletion resurrection, and preservation of unrelated staged files. Real API write/import capability must be separately exercised on disposable real instances; doubles prove failure handling only.
- [ ] Run all complete affected files plus typecheck. During execution these are verification commands, not evidence already obtained:

```bash
node --import tsx --test tests/dual-router-identity.test.ts tests/dual-router-adapter.test.ts tests/dual-router-repository.test.ts tests/dual-router-merge.test.ts tests/dual-router-usage.test.ts tests/dual-router-backup.test.ts tests/dual-router-coordinator.test.ts tests/dual-router-scheduler.test.ts tests/dual-router-api.test.ts tests/dual-router-integration.test.ts
node --import tsx --test tests/backup-service.test.ts tests/hono-api-contract.test.ts tests/ninerouter-multi-target.test.ts tests/app-config.test.ts tests/unified-sync-coordinator.test.ts tests/db-clients.test.ts tests/drizzle-migration-regression.test.ts tests/db-maintenance-lease.test.ts
npm run typecheck
npm run test
```

- [ ] Before completion run consistency searches for changed client overrides, DB domain enumeration, scheduler triggers, backup/restore CLI/API consumers, and public type copies. Use language-server references for exported symbols; grep complements this for routes/strings/duplicate copies. Inspect minimal issue diff, retain unrelated user changes, and report exact unrelated failures without weakening tests.
- [ ] Document operator onboarding/key custody, capability prerequisites, native versus replicated usage, unknown outcomes, proxy ownership, 10-minute/48-hour schedule, disabling auto versus manual behavior, encrypted backup branch, and offline restore. Update existing docs only; remove obsolete plaintext/live restore guidance.
- [ ] Commit only task-owned reviewed changes. Do not claim exact parity/write-back if capability prerequisites remain unmet, or visual/runtime proof if only mocks/tests ran.

## Dependency and acceptance coverage

| Spec requirement | Task and verification |
| --- | --- |
| Full inventory, capability limits, router alias detection | 1 and 3: evidence and full adapter tests |
| Stable IDs, baseline/tombstone/pending persistence | 2 and 4: reopen, incomplete read, conflict/deletion tests |
| Config/pools/accounts/roles and history import | 1, 3, 4, 7: capability-bound imports; native provenance retained |
| Shared-proxy exclusion and existing rotation policy | 4 and 7: ownership and existing policy modules |
| All local DB/settings recovery | 2 and 6: fourth-domain enumeration and isolated restore |
| Usage dedupe, units, opening balance, reset, reflected totals | 2 and 5: precision/counter/event tests |
| Absolute-first/delta-fallback write-back both targets | 1, 3, 5: verified API semantics, unknown outcome tests |
| 10-minute incremental and 48-hour full cycle | 7: catch-up, toggle, lease, manual independence |
| Encryption, restore, pending push, unrelated index safety | 6: crypto/restore/disposable Git scenarios |
| Authenticated controls, conflict review, honest status | 8: API regression, actual browser proof |
| Complete files, caller consistency, minimal scope | 8: full modules, references/search, final scope audit |

## Planning self-review and handoff

- Coverage checked against the approved spec's state classes, merge rules, write-back guarantees, scheduling, failure handling, recovery, controls, and acceptance criteria.
- No remote endpoint is invented; real endpoint contracts are an evidence gate in Task 1. Unsupported capability blocks its acceptance criterion, not all independent research/work.
- Repository types are defined before their consumers. Shared Operation/Receipt/RunRequest shapes are used consistently; factory-inferred service types avoid a second competing interface.
- Backup precedes coordinator mutation; unsafe old backup callers are migrated together, not preserved as an alias.
- Every implementation unit has full behavioral tests and runtime proof obligations. The commands above are planned, not executed during documentation work.
- Every task ends with a focused commit after verification. Never stage entire `src`, `docs`, or unrelated user work indiscriminately.

Execution options after this plan is handed over: **Subagent-Driven** (fresh worker per meaningful task, review between dependent tasks) or **Inline Execution** (same session using executing-plans). Task 1 starts only when execution is selected. No runtime code was changed by writing this plan.
