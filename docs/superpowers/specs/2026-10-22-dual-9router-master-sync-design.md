# Dual 9Router Master Synchronization Design

**Status:** Design approved in chat; written spec pending user review
**Date:** 2026-10-22
**Scope:** Bidirectional synchronization, usage write-back, 48-hour full backup, and parity control for two 9Router instances.

## Goal

Make two 9Router instances operate as dual masters without treating either instance as permanently authoritative. Both routers may receive independent changes. The system periodically reconciles their operational state, merges historical state, preserves unresolved conflicts for review, and maintains a recoverable backup in the private repository.

The design covers all state that can be read from the 9Router API and all relevant local state owned by `proxy-checker`. It does not assume that every readable remote field is writable.

## Existing context and constraints

- `proxy-checker` is a Node.js/TypeScript application with a custom server, Hono API routes, SQLite persistence, and a multi-target 9Router client.
- `src/server/nine-router-client.ts` already keeps authentication cookies isolated by normalized router URL and supports multiple configured URLs.
- `src/server/unified-sync-coordinator.ts` already coordinates router synchronization, Antigravity rotation, and fleet maintenance concurrently.
- Runtime SQLite databases use WAL mode. Live database files MUST NOT be copied directly while the process is running; snapshots use SQLite's consistent backup mechanism.
- Existing router/account decisions remain in force: account rotation is based on Gemini session quota, the threshold is 20%, active account count is configurable, and shared proxy instances MUST NOT run concurrently.
- The private Git repository is a backup destination, not a remote database transaction coordinator.

## Non-goals

- No forced byte-for-byte equality for router-specific listen addresses, local paths, process locks, session cookies, or host metadata.
- No direct undocumented writes into a 9Router SQLite database.
- No claim that usage is exact when the remote API provides no stable request/event identity.
- No automatic resolution of dangerous same-field conflicts.
- No requirement that both routers run the same account and proxy concurrently; shared proxy concurrency remains forbidden.
- This is eventual convergence, not instantaneous equality: edits made between polls can differ until reconciliation. HTTP reachability and equal record counts are not proof of parity or split brain.

## State classes

### Operational state

Operational state is reconciled toward equivalent meaning on both routers:

- proxy pools and their identity, name, type, proxy URL, rank, and active/dead state;
- account/connection identity, activation state, and account-to-proxy binding;
- model roles and provider-facing configuration exposed by the API;
- router settings that are writable through supported API endpoints;
- local proxy mappings and rotation configuration required to make the two remote states usable.

Remote IDs are router-local. Cross-router identity MUST use stable semantic keys, such as normalized proxy URL for pools and normalized account identity/email for accounts. A router-local ID is stored as a mapping, never used as the cross-router identity by itself.

Preserve protocol, port, credentials, and meaningful path components when normalizing proxy identities. Account identity includes provider and a stable provider subject where available; display name alone is never sufficient. Ambiguous identities require review. Router IDs are stable registrations, not URL strings; URL aliases to the same underlying instance MUST be detected before treating counters as independent sources.

Activation is an explicit runtime exception to parity. Shared configuration can match while only one router owns an active account-proxy binding. Transfer requires confirmed deactivation on the old owner before activation on the new owner. If the old owner is unreachable, block the transfer rather than assume it stopped. Without a remote fencing mechanism, independent manual activation outside proxy-checker cannot be strictly prevented; detect the violation and suspend controller activations until ownership is resolved.

Routine sync preserves live proxy assignments. It replaces only dead proxies; speed-based reassignment remains manual. Rank renaming runs from the largest rank down to rank 1. Rotation uses only fresh Gemini session quota, disables at <=20%, selects reserves above 20% by earliest reset, and preserves the configurable active limit (default 3). Model roles remain limited to Codex GPT 5.6, Sol, Astra, Luna, and oc/big-pickle; Gemini and Claude providers remain available but excluded from roles.

### Historical state

Historical state is merged, not overwritten:

- usage observations;
- quota observations;
- audit results;
- diagnostics and health observations;
- rotation history and synchronization events.

Historical records MUST carry their source router, observed time, entity identity, and an operation/event identity when the source provides one.

### Router-local state

The following remain local to each router or host:

- dashboard auth cookies and session tokens;
- listener address, local filesystem paths, process locks, and host identifiers;
- transient cache entries that cannot be safely merged.

All reconstructive secrets, including provider credentials and account refresh tokens exposed by supported export APIs, MUST be backed up encrypted with a recovery key held outside Git. Raw snapshots must be screened before staging. Dashboard session cookies are neither backed up nor mirrored. Concurrent refresh-token changes are a credential conflict, not a last-write-wins field; do not copy stale tokens over a newer credential. Preserve blocked/read-only data in encrypted snapshots and report its restoration limits explicitly.

## Conflict and merge model

The recommended model is a hybrid event ledger plus deterministic operational-state merge.

### Change metadata

Every locally observed or generated change SHOULD have:

```ts
interface SyncChange {
  operationId: string;
  routerId: string;
  entityType: string;
  entityKey: string;
  field?: string;
  value: unknown;
  revision: number;
  observedAt: string;
  deleted: boolean;
}
```

`operationId` is the idempotency key. `revision` is monotonic per router and entity stream. `observedAt` is evidence metadata, not the sole conflict authority.

When routers do not expose revisions, proxy-checker assigns observation revisions locally; these do not imply a causal order for edits on remote routers. Use three-way comparisons against normalized, per-field verified baselines. On first enrollment, union independently identifiable additions, retain divergent shared fields as conflicts, and infer no deletions. Later deletions require a complete authoritative listing plus a baseline showing previous presence; deletion versus concurrent edit requires review. Persist tombstones until both routers have acknowledged them. Before applying a write, reread its target and compare the expected value/revision; a mismatch invalidates that operation's plan. Without conditional writes or a maintenance window, a concurrent remote edit can still race this check; report that capability limit rather than promise atomic convergence.

### Merge rules

1. Only router A changed a field since the last successful checkpoint: apply A's change to B.
2. Only router B changed a field: apply B's change to A.
3. Both changed different fields of the same entity: merge fields independently.
4. Both changed the same field to the same value: mark converged and record both operations.
5. Both changed the same field to different values: retain a conflict record and do not apply either value automatically. Independent entities and fields continue syncing.
6. Deletion is a first-class change. A deleted entity MUST NOT be recreated from a stale snapshot without an explicit resolution.
7. Account activation and account-to-proxy binding are safety-sensitive. A conflict in either field is manual-review by default.
8. Fresh authoritative Gemini session quota at or below 20% triggers the existing deactivation policy across managed routers; stale or missing quota is not evidence of either exhaustion or recovery. Quota observations MUST NOT be added as usage or written back as provider entitlement.

This design deliberately chooses manual review for same-field conflicts. Last-write-wins is not used because clock skew and concurrent changes can silently discard a valid operator action.

## Usage ledger and write-back

The local usage ledger is the source of truth for the aggregated report and for any supported remote write-back.

### Ledger requirements

The ledger stores immutable source usage events or normalized counter deltas with source router ID, provider/account identity, model, metric/unit, period, source counter generation, source cursor, event ID, amount, observation time, provenance, and accuracy. Write-back receipts are separate from source usage.

- For an immutable request/event stream, use stable event identity plus documented source namespace. Cross-router deduplication is allowed only when an ID represents the same event globally; two independent requests with coincidentally equal router-local IDs remain distinct. Retries count according to the upstream metric's semantics, not a guessed timestamp fingerprint.
- For cumulative counters, persist the last raw source counter and ingest only its attributable increment in the same generation/period. Repeated snapshots contribute zero. A reset or decrease opens a new generation only when supported by reset evidence; otherwise quarantine it for review.
- Never use observation time buckets as deduplication keys for cumulative snapshots. Fingerprints without stable event identity are only heuristic and cannot support claims of exactness.
- Track native source usage separately from replicated totals. A written-back aggregate MUST NOT become fresh source usage. If the API cannot distinguish them or provide a safe observation boundary, disable automated counter ingestion/write-back for that scope and report the limitation.
- Initial enrollment with already replicated, overlapping, or unknown history requires a reviewed opening balance; do not blindly add both historical totals.
- Aggregate only compatible metric/unit/period scopes. Requests, input tokens, output tokens, and monetary amounts remain distinct; monetary amounts retain currency and source pricing semantics. Any uncertain component makes its displayed aggregate approximate or incomplete.

### Write-back strategy

Use absolute checkpoint first and delta fallback:

1. Verify supported endpoints and their counter semantics using read-only capability inspection first. Do not guess write endpoints or probe them by changing live data. API writability and counter provenance are currently unverified prerequisites, not existing implementation claims.
2. Prefer an absolute checkpoint scoped by account/provider/model/metric/unit/period and ledger revision. Persist write intent before transmission and a receipt after verified application. Absolute writes require a conditional revision/cursor, an atomic server-side import, or an operator-approved quiescent window so native usage arriving during the write is not lost. Repeating the same absolute value is not by itself safe when native counters continue increasing.
3. Fallback to delta only when the endpoint durably deduplicates operation IDs or offers equivalent provable application receipts. Persist intent first and reuse exactly the same operation ID and amount after a verified rejection or safe retry. Different endpoints are not interchangeable after an ambiguous result: resolve the original write before switching strategies.
4. A timeout after transmission becomes `unknown`. Query an operation receipt or an authoritative boundary before retrying. Reading a changing total alone cannot prove whether a delta was applied. If it cannot be resolved, block that scope for manual review; never blindly increment again.
5. Write independently to both routers, recording target revision, source boundary, outcome, and verification for each. One success does not imply cluster convergence. Do not overwrite higher native usage without first collecting and reconciling the new source events.
6. If no safe supported write endpoint exists, preserve data locally and report `write-back-unsupported` or `write-back-blocked`. This is a missing prerequisite for the requested write-back feature, not an acceptable claim that full synchronization is complete. No undocumented remote-file writes are permitted.

## Synchronization schedule

The 48-hour run is a full reconciliation and backup boundary, not the only synchronization mechanism.

- **Configuration event:** controller-side edits enqueue incremental work. Remote edits are found by polling unless the verified API supplies a change feed; do not assume remote webhooks exist.
- **Health and incremental reconciliation:** run when due every 10 minutes within the existing unified maintenance tick. Router sync and Antigravity rotation remain concurrent; no separate health/maintenance timer or global mutex serializes them. Use operation preconditions and entity ownership to handle overlapping changes.
- **Full reconciliation every 48 hours:** capture encrypted pre-change snapshots, audit all readable state, merge history, apply safe operations, perform supported usage write-back, reread state, and back up results. Enable this policy explicitly during onboarding; manual runs remain available independently of the background toggle.
- **Due-state persistence:** store next scheduled full-run time independently of success time. Startup performs one catch-up run when overdue, not a burst of missed runs. Failed operations retain their progress and retry on a later unified tick under bounded backoff, without advancing the verified success marker.
- **Manual run:** audit is read-only. Apply uses the same coordinator and persisted policy as scheduled runs. Conflict resolutions and restores are separate guarded actions.

A persisted lease prevents overlapping full/incremental dual-router writers, not unrelated router/rotation jobs. Store acknowledgements per field and operation: successful independent changes advance their baselines even when another entity is conflicted. A full-cluster verified marker advances only when all required comparable scopes are verified; conflicts, unsupported capabilities, unknown writes, and ownership exceptions are reported distinctly. A valid partial backup is still created after a failed run and must not be labeled a converged snapshot.

## Architecture

Introduce a dual-router synchronization service behind existing client and coordinator boundaries.

### Router adapter

The adapter isolates URL-specific authentication and verified API capabilities. Extend existing client helpers rather than create a second authentication/request implementation. Required operations are:

- Read capabilities: report each resource's read/export, create/update/delete/import, pagination, conditional-write, history identity, and usage write-back guarantees, along with router version and evidence. Absence or uncertainty is explicit.
- Read state: return normalized resources, router-local IDs, observation boundaries, revision/cursor where available, completeness of each listing, and per-resource failures. A failed or incomplete page is not an empty authoritative resource list.
- Apply planned changes: accept an operation ID, semantic entity key, target-local ID, expected value/revision, and desired change; return applied, rejected, conflicted, unsupported, or unknown per operation. History mirrors retain original provenance rather than mint new source events.
- Read usage and receipts: return native event/counter boundaries and previously applied write identities where supported.
- Write absolute/delta usage: accept a fully scoped ledger checkpoint or amount with operation identity and concurrency boundary, using the safety rules above; return independently verifiable receipts.

Maintain a capability matrix for every requested state class before planning its write path. Supported reads do not imply supported writes. Missing export/import for history, credentials, or settings remains a named blocker to full parity, while reachable work continues. Existing API responses may expose only the Antigravity subset; account/provider inventory must explicitly cover every provider returned by the deployed router, not silently narrow to Antigravity.

### State and ledger repository

Store checkpoints, normalized identity mappings, sync operations, conflicts, usage records, write-back receipts, and run summaries in a dedicated local persistence boundary. Existing domain databases remain owners of their existing data. The sync metadata schema MUST support idempotency and resume after process restart.

One proxy-checker controller owns local fleet/proxy/rotation databases. They are backed up completely, not injected into remote 9Router schemas. Sync metadata is persisted alongside existing data via versioned migrations; do not add a second copy of the fleet inventory. Retain baseline values, tombstones, pending operations, run leases, conflict decisions, counter generations/cursors, ledger revisions, encrypted snapshot references, and per-target receipts. No purge is introduced in this feature.

### Reconciliation coordinator

The coordinator:

1. acquires a single full-reconciliation lease;
2. reads both routers concurrently with isolated adapters;
3. loads the previous verified checkpoint;
4. computes operational diffs and historical ledger merges;
5. separates safe operations from conflicts and unsupported writes;
6. applies safe operations to each router with bounded concurrency;
7. performs usage write-back and records per-router receipts;
8. rereads changed entities and verifies parity;
9. writes the new verified checkpoint only after verification;
10. snapshots local databases and sync metadata, records the run's completeness, and prepares the private Git backup.

Capture both remote pre-change snapshots and local recovery state before any remote mutation. Two remote reads are not a globally atomic snapshot: record each resource's boundary/time. If prerequisites change during apply or verification, replan those operations rather than overwriting the concurrent edit. Bootstrap, incremental, full, manual, and resumed operations share the same rules.

Read the two routers concurrently. Writes on each router follow verified API limits and resource dependencies, such as pool-before-account-binding. Do not introduce a generic multi-implementation plugin system: one version-aware 9Router adapter boundary suffices. Do not claim remote API transactions provide two-phase commit or guaranteed rollback.

## Failure handling and safety

- **One router offline:** preserve the last known state; do not interpret missing data as deletion. Apply no destructive operation based only on a partial read.
- **Authentication failure:** isolate the affected URL, reauthenticate only that URL, and retry within a bounded limit. Never reuse cookies across URLs.
- **Rate limit/5xx:** bounded backoff applies to reads and to writes with proven safe retry semantics. A write-side error after possible application is uncertain, not permission to blindly replay a non-idempotent mutation.
- **Timeout after remote write:** mark operation uncertain and verify using the operation's documented semantics. Entity reads can verify idempotent desired-state updates; usage deltas require receipts or an authoritative boundary, not a total-counter comparison alone.
- **Split brain:** if both routers are reachable but disagree on safety-sensitive state, pause only conflicting operations, emit a drift report, and continue unrelated safe operations.
- **Unexpected quota drop:** follow the existing 20% account deactivation policy; never reactivate solely because the other router has stale higher quota.
- **Partial apply:** report per-operation results. Do not claim transaction-wide success. The next run reconciles remaining operations.
- **Backup failure:** do not advance the backup checkpoint. Keep local operation receipts and alert through existing activity logging.
- **Restore:** stop or quiesce writers before replacing active database files, remove stale WAL/SHM sidecars, validate schema and checksums, then restart/reload. Router restore requires explicit operator confirmation.

## API and UI boundary

Expose read-only parity and run status first:

- `GET /api/ninerouter/dual/status`
- `GET /api/ninerouter/dual/conflicts`
- `POST /api/ninerouter/dual/audit` with `dryRun` semantics
- `POST /api/ninerouter/dual/reconcile` with explicit apply mode
- `POST /api/ninerouter/dual/usage/write-back` for an explicit, auditable run
- Conflict review returns base/A/B values with secrets redacted. A resolution chooses A, B, deletion, or an operator-entered value, records operator identity and the expected conflict revision, and rejects stale decisions before generating normal audited operations.

The UI shows each router separately, parity summary, last verified checkpoint, pending conflicts, unsupported capabilities, usage ledger accuracy, and per-router write-back receipts. It MUST NOT present an approximate usage total as exact.

Manual destructive actions, conflict resolution, usage write-back, and restore require explicit confirmation and visible operation IDs. Scheduled safe reconciliation/write-back is authorized once by the persisted onboarding policy; it does not prompt every 48 hours. Conflicts and ambiguous usage writes still require review. Secrets stay out of status responses, logs, diffs, and previews. All controls use existing dashboard authentication, request validation, and shadcn components.

## Backup contents

Each full run preserves encrypted pre-change recovery material and a timestamped result backup, including incomplete/conflicted runs with explicit status:

- consistent snapshots of all local SQLite databases;
- local app settings and recoverable credentials, encrypted with an external recovery key;
- dual-router state snapshots from supported APIs, encrypted before any Git staging;
- usage ledger and write-back receipts;
- sync metadata, verified checkpoint, conflict records, capability report, and manifest checksums;
- no live WAL/SHM files and no auth cookies.

Git push failure leaves the local commit pending and visible. The backup process MUST distinguish `snapshot_created`, `committed_local`, and `pushed_remote`.

Use authenticated encryption from the installed runtime, with a random nonce and versioned envelope; never store recovery keys beside ciphertext or in Git. Without the configured recovery key, block secret-bearing backup and remote mutation rather than silently omit credentials. Publish a snapshot only after all included files and its manifest are written and checked. Verify file hashes/schema/foreign-key integrity and key availability before restoring anything; close writers and data leases, not just delete sidecars underneath live connections. Keep a pre-restore recovery copy and do not return success for a partially restored set.

Git automation must isolate only intended backup paths and preserve unrelated staged work. Use repository-wide coordination compatible with other Git users; an in-process mutex alone does not protect another process. Do not delete an unexplained index lock, force-push, auto-resolve repository conflicts, or amend user commits. Pending remote pushes must be retried even if the newest snapshot has no data changes. A dedicated backup worktree/index strategy may be chosen in the implementation plan without changing these boundaries.

## Verification requirements

Permanent tests MUST cover behavior rather than implementation details:

1. one-sided changes converge on the other router;
2. different-field changes merge without loss;
3. same-field divergent changes remain conflicts while independent changes apply;
4. deletion is not resurrected from a stale snapshot;
5. repeated reconciliation is idempotent;
6. one router outage does not cause destructive deletes;
7. timeout after write rereads before retrying;
8. absolute usage write-back is idempotent;
9. delta fallback does not increment twice after retry/unknown result;
10. usage from write-back is not re-ingested as a new source event;
11. approximate usage is visibly marked and not reported as exact;
12. account quota at or below 20% deactivates safely across routers;
13. shared proxy instances are never activated concurrently;
14. full-run lease prevents overlapping jobs;
15. SQLite snapshots restore without stale WAL/SHM interference;
16. backup checkpoint advances only after parity verification.

Integration proof must exercise ingestion, incremental/full scheduling, persistence across process restart, unknown write recovery, encrypted backup, and isolated restore using two disposable router instances or verified deployed APIs on explicitly disposable data. Deterministic doubles support failure injection but do not prove deployed 9Router capability. Never mutate live usage/configuration merely to test a hypothesis. If real API write/import evidence is unavailable, report that prerequisite and do not claim complete end-to-end parity. Run full affected test files (including sibling cases), search duplicate call sites for changed contracts, and keep implementation outside this feature unchanged.

## Acceptance criteria

The implementation is ready only when:

- both routers can accept independent safe changes and converge deterministically;
- unresolved same-field conflicts are visible and never silently overwritten;
- usage is deduplicated, aggregated locally, and written back with absolute-first/delta-fallback semantics where the API supports it;
- unsupported remote write capabilities are reported rather than faked;
- a 48-hour full run creates a verified, restorable backup;
- partial failures resume without duplicate operations or destructive inference;
- operational parity, historical merge state, and usage accuracy are separately visible in API and UI.
- First enrollment, source-counter resets, overlapping opening balances, pagination failures, stale conflict decisions, concurrent writes during usage write-back, Git push retry without fresh changes, recovery-key loss, and restart after partial apply are verified boundary cases.
- Missing remote write/export guarantees are surfaced as unmet acceptance criteria, not silently downgraded scope.

## Written-spec approval gate

This document records the architecture approved in chat. No runtime implementation is authorized by its creation. After user review and approval of this written spec, invoke writing-plans for an implementation plan. The plan must start by verifying deployed 9Router capabilities; it must stop and surface any unreachable prerequisite rather than invent a remote write API. No requirement is removed merely because that prerequisite is absent.
