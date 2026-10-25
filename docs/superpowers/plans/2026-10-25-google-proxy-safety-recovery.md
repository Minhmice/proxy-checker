# Google Cloud Code Proxy Safety & Antigravity Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent credential exposure through untrusted Google proxy paths, verify router-local repairs truthfully, and recover a rejected Antigravity request before its response is handed to the client.

**Architecture:** A versioned 9Router source build owns TLS, upstream execution, binding revisions, and request retry. The existing proxy-checker backend owns audit persistence and a transactional ownership authority; both routers remain dual masters. Three dependent packages are independently reviewable: A — strict transport/observations; B — node-local audit/conditional binding/verified repair; C — request-scoped recovery and rollout. Console-log SSE stays diagnostic-only.

**Tech Stack:** Node.js >=22 for the controller; Node >= the pinned Next.js engine for source builds; JavaScript/ESM and Vitest in 9Router; TypeScript, Node test runner, Hono, Drizzle and better-sqlite3 in proxy-checker. Reuse native crypto, existing proxy transports, and database adapters; no new runtime dependency is planned.

**Spec:** `docs/superpowers/specs/2026-10-25-google-proxy-audit-and-inflight-rebind-design.md` — approved in chat. This plan replaces `2026-10-25-google-proxy-audit-and-inflight-rebind.md`.

## Global Constraints

- Do not bypass Google authorization, account restrictions, ToS enforcement, or certificate verification.
- Do not patch deployed compiled JavaScript directly; modify source and deploy a versioned 9Router build.
- Do not silently route configured-proxy requests direct.
- Do not retry a request after downstream response headers or any response bytes have been committed, even if those bytes contain only role, reasoning, or heartbeat data.
- At most one token-refresh retry and one proxy-rebind retry across the whole Antigravity request, including nested account/combo fallback.
- Generic quota 403 and empty quotas are not proof of proxy blocking, account ban, or quota exhaustion.
- All new Google probes run from the actual router egress node, retain TLS/hostname verification, send no OAuth credential, and use the configured proxy with no direct fallback.
- Audit results expire after five minutes. URL/credentials/CA/routing changes invalidate them immediately. Maximum four probes per router, five seconds per probe.
- Persist audit classifications in the existing database; do not add a text-file lifecycle or a separate maintenance scheduler.
- Pool IDs are router-local. Use canonical proxy identity for cross-node comparison, not a raw remote ID.
- At most two bound account placements per physical proxy and at most one active account placement across both masters. Count `(router, account)` placements, including matching email on different nodes.
- Preserve sync/rotation concurrency for unrelated state. Do not add a global sync mutex.
- Never transfer shared-proxy ownership on TTL expiry alone or when the previous owner cannot be fenced and drained.
- Tokens and proxy passwords remain inside 9Router. Sanitized controller results contain route identity, freshness, and outcome only.
- Manual repair remains independent of the automatic-sync toggle; background audit/repair use the existing unified maintenance cycle.
- Do not change quotas from unavailable to synthetic 0%/100%; retain last known readings with original timestamps and explicit stale state.
- Run full affected test files, not only named tests expected to change. Never re-pin a broken incidental implementation assertion to hide a behavior regression.

## Evidence, source and command lock

Source checkout acquired during planning:

```text
Controller root: C:/Users/minhmice/Documents/projects/proxy-checker
Router root:    C:/Users/minhmice/Documents/projects/9router-source
Router commit:  f39d8f07481ae8518e93175f0ecaaafa61573c6c
App/CLI version at that commit: 0.5.109
Observed deployed LAN version: 0.5.109
```

The checkout is detached and unmodified. Matching version strings do not prove that the running npm bundle was built from this revision. The first execution task must establish a reproducible source-to-artifact baseline before deployment.

Commands verified by reading actual package files:

| Working directory | Command | Meaning |
|---|---|---|
| proxy-checker | `node --import tsx --test tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts` | Full controller modules |
| proxy-checker | `npm test` / `npm run typecheck` / `npm run lint` | Existing controller checks |
| 9router-source | `npm run build` | `next build --webpack`, then existing postbuild |
| 9router-source | `npm --prefix tests test` | Vitest with `tests/vitest.config.js` aliases |
| 9router-source/tests | `npm test` | Vitest with `vitest.config.js` aliases |
| 9router-source | `npm run cli:pack` | Existing CLI build and npm pack |
| 9router-source | `npm start -- --port 20129` | Source custom server on isolated test port |

These commands were inspected, not executed during plan authoring. Do not run Node's test runner against Vitest modules; do not run `npm test -- --test-name-pattern=filename`, which filters test names rather than executing a full file.

## Repository conventions that constrain implementation

1. `src/db/common/migrate.ts` reads the domain's first baseline SQL, checks its recorded SHA256, and rejects unknown tables/columns. Editing the baseline alone breaks every existing stamped database; an isolated incremental file is currently ignored. Task 3 must add an explicit, narrowly scoped upgrade from the exact captured pre-change proxies baseline hash to the new domain hash. Preserve strict rejection of any other hash/schema; never erase migration history or silently re-stamp unknown data. Fresh baseline, Drizzle schema and snapshot metadata must agree. This is a feature-required migration, not a general migration-engine rewrite.
2. `src/server/dual-router/identity.ts::poolKey()` intentionally preserves credentials and query/path. **Do not reuse its raw return value in public audit/ownership DTOs or change its existing semantics.** Add a separate non-secret `proxyEndpointKey()` for physical endpoint ownership; keep existing pool identity internal for exact pool mapping. Credential changes have an opaque route revision.
3. 9Router's `src/lib/db/schema.js` requires `SCHEMA_VERSION` to increase on schema changes. Its versioned registry currently has migration `001-initial.js`; append a migration for binding metadata and update the declarative schema rather than modifying the historical migration.
4. `src/lib/db/repos/connectionsRepo.js::updateProviderConnection()` is the shared merge/transaction point. Credential refresh and bindings share JSON data. A stale `providerSpecificData` object must not overwrite fresh tokens or a newer proxy revision.
5. Existing 9Router `strictTls` exists in `proxyFetch.js`, but is not reliably propagated by usage/refresh. `fetchWithTimeout()` currently replaces the caller abort signal. Fix the real shared boundary, not a second fetch stack.
6. New probe endpoints must accept router-local IDs and fixed target identifiers, not arbitrary target URLs, shell commands, or proxy URLs from callers. Existing authenticated dashboard middleware remains required; no public-route exemptions.

## Dependencies and file ownership

1. Task 0 establishes source/build provenance.
2. Tasks 1–2 establish strict transport and structured observation DTOs.
3. Tasks 3–5 establish controller storage, node-local audit, persistent revisions and atomic ownership. Task 4's probe fixtures are independent; live revision-backed audit smoke waits for Task 5. Task 5 authority/CAS can proceed after Task 3 without probe dispatch.
4. Tasks 6–7 migrate all writers and replace unverified repair.
5. Tasks 8–9 integrate bounded request recovery and prove both-node rollout.

Task 2 uses route DTO fixtures until persistent revisions land in Task 5; no fake runtime revision is acceptable. A package is not deployment-ready until its live dependency contracts are verified.

Tasks 3 and 4 may run concurrently after the shared DTO contract is fixed. One integration owner handles `server.ts`, client, rotator and cross-repo API contracts. Do not overlap source edits to those files. Agents skip mid-flight checks; the integration owner runs each task's red/green/full-module gates after integration. No implementation starts as part of this planning request.

---

## Task 0: Reproducible source/build baseline and capability contract

**Files:** inspect both root `package.json` files, router `tests/package.json`, `tests/vitest.config.js`, `cli/package.json`, `cli/scripts/build-cli.js`; update this plan's evidence section only if source differs.

**Consumes:** pinned checkout above, fixed SSH targets from `src/server/server-interactive-updater.ts`.
**Produces:** exact source revision/build artifact identity and baseline exit codes; not a new production deployment.

- [ ] Inspect both roots for user changes and read applicable repository rules. Create implementation branches/worktrees using the existing worktree skill; preserve the user's unrelated working changes. Do not clone the checkout again if it exists.
- [ ] Verify package metadata and provenance:

```bash
# In router source
node --version
node -p "require('./package.json').version"
node -p "require('./cli/package.json').version"
git rev-parse HEAD
```

- [ ] Through existing SSH2 host configuration, read installed package metadata and build identity without printing credentials. Do not copy the researched hardcoded password into a command. If no deployed source revision can be proven, build/test a new explicitly versioned source artifact from the pinned revision and treat its deployment as an upgrade, not an identical rebuild.
- [ ] Install source dependencies once in isolated roots (`npm install` at router root, `npm --prefix tests install`, `npm --prefix cli install`); retain resulting locks for reproducibility. No forced dependency upgrades. Run baseline:

```bash
npm --prefix tests test
npm run build
```

- [ ] Record baseline failures without rerunning them merely to confirm. If collection/build cannot run, finish non-runtime mapping but stop source mutation/deployment until the prerequisite is resolved. Never replace the unavailable source with compiled chunk edits.
- [ ] Add a versioned feature capability response in Task 5; until it exists, controller returns `unsupported`, not success from guessed API behavior. Source/test/build baseline is a prerequisite to enabling repair, not permission to modify production now.

---

# Package A — strict source transport and observations

## Task 1: Strict Antigravity transport, every credential path

**Router existing files:**
- `open-sse/utils/proxyFetch.js` — `fetchWithTlsFallback`, proxy/direct resolution, relay/no-proxy/DNS-bypass branches.
- `open-sse/executors/base.js`, `open-sse/executors/antigravity.js` — generation dispatch and refresh arguments.
- `open-sse/services/usage/shared.js`, `open-sse/services/tokenRefresh.js`, `open-sse/services/projectId.js` — timeout, OAuth and discovery propagation.
- `src/lib/network/connectionProxy.js` — intended pool remains explicit when missing/inactive.
- `src/app/api/usage/[connectionId]/route.js`, `src/sse/services/tokenRefresh.js`, `src/sse/services/backgroundTokenRefresh.js` — usage/background auth entry points.
- `src/lib/oauth/services/antigravity.js` — initial OAuth path.
**Router new file:** `open-sse/services/antigravitySafety.js` — provider-specific options and sanitized error classification, consumed by later tasks.
**Tests:** extend `tests/unit/strict-proxy-enforcement.test.js`; create `tests/unit/antigravity-strict-transport.test.js`.

**Contract** (ESM/JSDoc in router, wire vocabulary stable):

```ts
type SafetyErrorCode = 'TLS_UNTRUSTED' | 'PROXY_UNREACHABLE' |
  'PROXY_REQUIRED' | 'PROXY_REJECTED' | 'REDIRECT_NOT_ALLOWED' | 'PROXY_UNSUPPORTED';
interface RouteFailure {
  code: SafetyErrorCode;
  phase: 'tls_handshake' | 'proxy_connect' | 'before_submit' | 'unknown';
  requestSubmitted: boolean | null;
  poolId: string | null;
  poolRevision: number | null;
}
// Existing proxyAwareFetch(url, requestOptions, proxyOptions) remains the API.
// Strict Antigravity callers set strictTls on requestOptions and strictProxy
// plus intended proxyPoolId on proxyOptions. Other provider defaults unchanged.
```

- [ ] Write failing transport tests using local HTTPS/CONNECT fixtures with a test CA and untrusted self-signed certificate. Count observed HTTP requests at upstream/proxy/direct servers rather than testing copied options.

```js
import { describe, it, expect } from 'vitest';
import { proxyAwareFetch } from '../../open-sse/utils/proxyFetch.js';

it('refuses a configured pool with no resolved transport', async () => {
  await expect(proxyAwareFetch(
    'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    { method: 'POST', body: '{}', strictTls: true },
    { proxyPoolId: 'missing', connectionProxyEnabled: true, strictProxy: true },
  )).rejects.toMatchObject({ code: 'PROXY_REQUIRED' });
});
```

Additional full-fixture cases: wrong hostname and untrusted CA send zero HTTP requests with bearer header; failed CONNECT sends zero direct HTTP requests; disabled/missing pool cannot use environment proxy or legacy fallback; configured no-proxy wildcard cannot bypass strict Google policy; disallowed redirect is not followed; no credential appears in returned error. SOCKS must use a real installed transport path or fail `PROXY_UNSUPPORTED`, never reinterpret SOCKS as an HTTP proxy. Relay paths must either demonstrate strict remote forwarding or fail unsupported, not silently claim pass.

- [ ] Run full new/existing files red:

```bash
(cd ../9router-source/tests && npm test -- unit/antigravity-strict-transport.test.js unit/strict-proxy-enforcement.test.js)
```

- [ ] Implement provider-scoped strict options before any refresh/discovery/generation call. Use existing `options.strictTls`; do not add a second synonymous TLS flag. In strict mode classify certificate failure before any insecure retry. Preserve `proxyPoolId` even if resolution fails. With intended proxy present, forbid direct and `NO_PROXY`/environment substitutions. Compose caller cancellation using `AbortSignal.any([callerSignal, timeoutSignal])` rather than overwriting it. Restrict redirects to fixed configured Google endpoints and never forward Authorization to another origin.

```js
// In the existing timeout helper, retaining non-Antigravity behavior:
const signals = [controller.signal];
if (opts.signal) signals.push(opts.signal);
const requestOptions = { ...opts, signal: AbortSignal.any(signals) };
// In strict certificate error branch:
if (options.strictTls === true && isTlsCertError(error)) {
  const denied = new Error('Google route TLS verification failed');
  denied.code = 'TLS_UNTRUSTED';
  denied.phase = 'tls_handshake';
  denied.requestSubmitted = false;
  throw denied;
}
```

A `TypeError: fetch failed` alone does not prove `requestSubmitted:false`; classify ambiguous disconnect as unknown and non-retryable. Close dispatchers/response bodies on rejected attempts through existing lifecycle APIs. Pool change invalidates secure dispatcher cache entries for that revision.

- [ ] Grep every Antigravity OAuth, quota, project discovery and generation callsite for bypassed options; use LSP references before changing exported signatures. Run both full files green and full upstream suite. Inspect actual local-fixture server counts for TLS failure/direct leakage.
- [ ] Commit only Task 1 source and tests: `fix(antigravity): enforce strict credential transport`.

## Task 2: Fresh, structured account quota observations

**Router files:**
- `open-sse/services/usage/google.js` — preserve upstream status/reason instead of only display text.
- `open-sse/services/usage/antigravity-weekly.js` — route-scoped cache and explicit verification bypass.
- `open-sse/services/usage.js`, `src/app/api/usage/[connectionId]/route.js` — propagate verification options.
- `src/sse/services/antigravityQuota.js` — retain existing 409/429 model circuit behavior; do not overwrite valid cache with error.
- `open-sse/services/antigravitySafety.js` — shared status classifier/allowlist.
**New router test:** `tests/unit/antigravity-quota-observation.test.js`.
**Existing tests:** `tests/unit/antigravity-quota-routing.test.js`, `tests/unit/antigravity-weekly-quota.test.js`.

**Wire contract** (defined here, mirrored as controller DTO in Task 3; no cross-repo import):

```ts
type QuotaStatus = 'known' | 'unknown' | 'auth_expired' |
  'account_forbidden' | 'transport_failed';
interface ObservationMeta {
  accountId: string;
  poolId: string | null;
  bindingRevision: number;
  poolRevision: number | null;
  endpoint: string;
  observedAt: number;
  fresh: boolean;
  httpStatus: number | null;
  reasonCode: string | null;
  transportError: RouteFailure | null;
}
interface QuotaEnvelope {
  observation: ObservationMeta & { status: QuotaStatus };
  quotas: Record<string, { remainingPercentage: number; resetAt: string | null }>;
  message: string | null;
  error: string | null;
  stale: boolean;
}
```

- [ ] Write red behavior tests for generic 403, explicit permission denial, 401, malformed/empty quota, missing Gemini session, valid 0%, and a route change during verification. Do not require a fixed model list or incidental wording.

```js
import { expect, it } from 'vitest';
import { classifyQuotaObservation } from '../../open-sse/services/antigravitySafety.js';
it('keeps generic quota denial separate from account ban or exhaustion', () => {
  const result = classifyQuotaObservation(
    {message:'Forbidden', quotas:{}},
    {httpStatus:403, endpoint:'quota', tlsVerified:true},
  );
  expect(result.status).toBe('unknown');
  expect(result.httpStatus).toBe(403);
});
```

Task 2 adds `classifyQuotaObservation(raw, meta)` to `antigravitySafety.js`; it returns status, HTTP status, sanitized reason and freshness, not an invented numeric quota. Extend the existing real `refreshAntigravityQuota` mock fixture to assert its prior valid numeric reading survives a soft denial; do not insert a mock echo test.

- [ ] Run full modules red:

```bash
(cd ../9router-source/tests && npm test -- unit/antigravity-quota-observation.test.js unit/antigravity-quota-routing.test.js unit/antigravity-weekly-quota.test.js)
```

- [ ] Add optional `observation` metadata to ordinary usage responses; preserve existing provider response fields/callers. Verification is a new explicit service operation invoked by Task 5 endpoint, not the ordinary GET `force=1` alone. It forces subscription/model/summary requests on a captured route revision, bypasses their caches, returns freshness per result, and refuses success if the binding changes before completion.
- [ ] Add route scope to cache keys: router instance, account, project, pool ID/revision, binding revision. Keep tokens internal; don't publish token-based cache keys. `force` must reach the summary helper; failure cannot be replaced by a stale reading in a verification response.
- [ ] Generic endpoint 403 with only `Forbidden` is status unknown + HTTP 403. Only structured upstream permission/eligibility reason plus validated TLS permits `account_forbidden`. This label records that operation's denial, not a ban verdict. Preserve sanitized bounded provider `reasonCode`, never raw error body/token dump. `quotas:{}` without valid readings is unknown. Missing `gemini_session` stays unknown for session-based rotation, even if model/weekly readings exist; do not substitute weekly or another family.
- [ ] Use existing RAM/DB quota caches for last-known display with observed timestamp/stale marker; preserve 409/429 logic and actual future reset. Do not mark account exhausted based on metadata failure. Run full affected modules green and exercise local HTTP handler with fixture upstream (fresh verification rejects cache-only success).
- [ ] Commit: `fix(antigravity): preserve quota observation provenance`.

---

# Package B — backend audit, conditional mutation and repair

## Task 3: Persist scoped audit and expose unknown quota honestly

**Controller new files:** `src/server/antigravity-observation.ts`, `tests/antigravity-observation.test.ts`.
**Controller existing files:**
- `src/db/proxies/schema.ts`, `src/db/migrations/proxies/0000_baseline.sql`, `src/db/migrations/proxies/meta/_journal.json`, `src/db/migrations/proxies/meta/0000_snapshot.json`.
- `src/server/proxy-intelligence-db.ts`, `src/server/proxy-intelligence-repository.ts`.
- `src/server/antigravity-rotator.ts`, `src/lib/types.ts`, `src/components/antigravity-quota-widget.tsx` and other LSP-discovered quota numeric consumers only.
**Tests:** existing `tests/drizzle-migration-regression.test.ts`, `tests/proxy-intelligence-migration-regression.test.ts`, `tests/antigravity-rotator.test.ts`, `tests/antigravity-rotation-history.test.ts`, `tests/antigravity-quota-ux.test.ts`.

Also modify `src/db/common/migrate.ts` and `tests/drizzle-migration-regression.test.ts` for the explicit known-baseline upgrade. Before changing either baseline, capture its current content hash in the new upgrade registry; do not guess or reuse a generic wildcard hash. `tests/db-preflight.test.ts` and `tests/db-clients.test.ts` must cover pre-upgrade stamped databases on reopen.

**Types:**

```ts
export type GoogleTransportStatus = 'unknown' | 'tls_untrusted' |
  'proxy_unreachable' | 'google_endpoint_reachable' |
  'google_endpoint_denied' | 'passed';
export type AntigravityQuotaStatus = 'known' | 'unknown' |
  'auth_expired' | 'account_forbidden' | 'transport_failed';
export interface TransportObservation {
  routerUrl: string; proxyPoolId: string; endpoint: string;
  poolRevision: number; status: GoogleTransportStatus;
  httpStatus: number | null; errorCode: string | null;
  checkedAt: number; expiresAt: number;
}
export interface QuotaObservation {
  routerUrl: string; accountId: string; proxyPoolId: string | null;
  bindingRevision: number; poolRevision: number | null;
  status: AntigravityQuotaStatus; sessionPercentage: number | null;
  observedAt: number; fresh: boolean; stale: boolean;
  httpStatus: number | null; message: string | null; error: string | null;
}
export function classifyQuotaResponse(
  raw: Record<string, unknown>,
  route: {routerUrl: string; accountId: string; proxyPoolId: string | null;
    bindingRevision: number; poolRevision: number | null},
): QuotaObservation;
```

- [ ] Add red test using actual classifier/planner, not duplicated implementation:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuotaResponse } from '../src/server/antigravity-observation.js';
test('quota-only denial does not fabricate zero remaining quota', () => {
  const result = classifyQuotaResponse({
    message: 'Antigravity quota API access forbidden. Chat may still work.', quotas: {},
  }, {routerUrl:'http://router-a', accountId:'a', proxyPoolId:'pa',
    bindingRevision:1, poolRevision:1});
  assert.equal(result.status, 'unknown');
  assert.equal(result.sessionPercentage, null);
});
```

Also assert current active account survives quota-unknown while a known 20% account deactivates; real 0% remains known; invalid reset dates sort last deterministically. Snapshot aggregate includes known-count/unknown-count and never implies unknown accounts are exhausted. UI displays unavailable/stale, not fabricated percentages; reuse existing shadcn surfaces, no styling redesign.

- [ ] Run full classifier/rotator files red using controller Node command. Remove prior tests that assert fabricated quota on 403; replace with consumer-visible preservation/eligibility outcomes, not implementation property snapshots.
- [ ] Add table through the existing baseline/schema convention:

First implement the bounded migration transition: within the existing immediate transaction, accept only the captured old hash and matching old schema for that domain; add feature tables/indexes, validate retained data, then advance the known migration record to the new baseline hash with an auditable version entry. Already-current databases are idempotent; any unknown hash still fails and rolls back. Test proxies now and sync in Task 5 using real pre-change SQL fixtures plus migration rows. No database deletion, checksum bypass, or production hash editing.

```sql
CREATE TABLE IF NOT EXISTS google_transport_observations (
  router_url TEXT NOT NULL,
  proxy_pool_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  pool_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  error_code TEXT,
  checked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (router_url, proxy_pool_id, endpoint, pool_revision)
);
CREATE INDEX IF NOT EXISTS idx_google_transport_expiry
  ON google_transport_observations(expires_at);
```

Repository API: `recordGoogleTransportObservation(row: TransportObservation): void` and `getGoogleTransportObservations(routerUrl: string, poolId: string, poolRevision: number): TransportObservation[]`. Reject old observation overwrites using `checked_at` ordering. Reads for eligibility require current revision and `expiresAt > now`; observation persistence survives restart, deletion/pool revision invalidates it. Retain bounded history only through existing audit/history mechanisms, no new telemetry subsystem.
- [ ] Replace duplicated message checks in parser/planner/repair with structured statuses. Do not make merge's field classifier an auth-error classifier. Preserve stale numeric reading separately from fresh rotation eligibility. Migration must work with real better-sqlite3 and the existing fallback DB test adapter; fresh/open/reopen/legacy DB retain existing proxy and assignment rows.
- [ ] Run full controller files green:

```bash
node --import tsx --test tests/antigravity-observation.test.ts tests/antigravity-rotator.test.ts tests/antigravity-rotation-history.test.ts tests/drizzle-migration-regression.test.ts tests/proxy-intelligence-migration-regression.test.ts
```

- [ ] If UI display changed, open actual dashboard and verify unavailable/stale/known values and keyboard access; no visual claim from unit tests alone. Commit: `fix(quota): keep unknown observations explicit`.

## Task 4: Real node-local transport audit, existing unified workflow

**Router new files:** `src/lib/network/googleTransportAudit.js`, `src/app/api/proxy-pools/[id]/google-audit/route.js`.
**Router existing:** `open-sse/services/antigravitySafety.js`, `src/lib/db/repos/proxyPoolsRepo.js`, `open-sse/providers/registry/antigravity.js`.
**Controller new:** `src/proxyfleet/google-code-audit.ts`, `tests/google-code-audit.test.ts`.
**Controller existing:** `src/server/nine-router-client.ts`, `src/server/server.ts`, `src/server/unified-sync-coordinator.ts`, `src/server/proxy-check-handler.ts`, `src/proxyfleet/endpoint-audit.ts` (generic ipify audit stays intact), `src/server/pool-ranker.ts`.
**Router new test:** `tests/unit/google-transport-audit.test.js`.

**API, new authenticated contract:**

```text
POST /api/proxy-pools/:id/google-audit
body: {expectedPoolRevision: number}
200: {poolId, poolRevision, observations: TransportObservation[], complete: boolean}
409: {code:'ROUTE_CHANGED'}
```

Router observations omit `routerUrl`; the controller stamps its known target URL rather than trusting request input. No arbitrary target, token, proxy URL, or method input. Resolve pool/credential locally. Probe target set comes from current provider registry: discovery/quota/generation Cloud Code origins plus OAuth `https://oauth2.googleapis.com/token`. Only fixed non-mutating unauthenticated probe operations are sent; body `{}` and no Authorization for Cloud Code. OAuth receives an invalid empty token form without refresh/client secrets, used only to establish TLS/reachability; 400/401 with verified TLS is reachable, not authorization success. Do not send generation prompts during transport preflight.

- [ ] Add failing actual probe fixtures: 401 on valid TLS is reachable; 204 on unrelated host does not satisfy target set; self-signed/wrong hostname fails; configured proxy timeout yields zero direct calls; unauthenticated 403 remains denied/unknown; redirects fail; caller abort stops probe; changed revision cannot persist old pass. Use exact route-host allowlist and closed loopback fixtures in tests.
- [ ] Run complete router/controller new files red. Implement `auditGooglePool(poolId, expectedPoolRevision, {signal})` using Task 1 transport on the actual node. Enforce five seconds per request, four in-flight probes per router in-process, bounded response reads and redaction. `passed` is only aggregate success for all required origin checks; ordinary valid-TLS 401/400 means reachability, not quota success. HTTP 403 on unauthenticated probe is not globally banned; require safe account-specific verification before choosing a denied/unknown candidate.

```js
// Probe has no account token or caller-provided URL.
const response = await proxyAwareFetch(target.url, {
  method: 'POST', body: target.body, strictTls: true,
  redirect: 'manual', signal,
  headers: {'Content-Type': target.contentType},
}, { ...resolvedProxy, proxyPoolId: pool.id, strictProxy: true });
```

- [ ] Add controller client `auditRouterGooglePool(poolId: string, expectedPoolRevision: number, overrides: NineRouterRequestOverrides): Promise<TransportObservation[]>`. It calls the node endpoint using existing per-node auth and records sanitized observations. Never run curl on the controller and call it a remote-node audit.
- [ ] Schedule audit work inside the existing unified maintenance cycle. Manual proxy checks invoke the same audit coordinator. Do not add an audit side-loop or let frontend decide eligibility. Pool sync/rotator still run concurrently; an account lacking current evidence waits/uses its confirmed safe binding rather than a partially completed audit snapshot.
- [ ] Run full new and existing modules:

```bash
# router root
(cd ../9router-source/tests && npm test -- unit/google-transport-audit.test.js unit/strict-proxy-enforcement.test.js)
# controller root
node --import tsx --test tests/google-code-audit.test.ts tests/proxy-check-history.test.ts tests/unified-sync-coordinator.test.ts tests/sync-lifecycle.test.ts tests/pool-ranker.test.ts
```

Exercise the actual new HTTP endpoint with fixture upstream and verify persisted DB status. Generic proxy health must remain usable for other providers when Google evidence is denied. Commit source/controller changes separately with coordinated contract version.

## Task 5: Router atomic revisions and controller ownership/drain protocol

**Router existing:** `src/lib/db/schema.js`, `src/lib/db/migrations/index.js`, `src/lib/db/repos/connectionsRepo.js`, `src/lib/db/repos/proxyPoolsRepo.js`, `src/lib/db/index.js`, `src/lib/localDb.js`, `src/app/api/providers/[id]/route.js`, `src/app/api/proxy-pools/[id]/route.js`, `src/dashboardGuard.js`, `src/lib/auth/dashboardSession.js`, `src/lib/auth/trustedPeer.js`.
**Router new:** `src/lib/db/migrations/002-antigravity-binding.js`, `src/lib/network/antigravityBinding.js`, `src/app/api/antigravity/safety-capabilities/route.js`, `src/app/api/providers/[id]/binding/route.js`, `src/app/api/providers/[id]/route-drain/route.js`, `src/app/api/providers/[id]/quota-verification/route.js`, `tests/unit/antigravity-binding.test.js`.
**Controller existing:** `src/db/sync/schema.ts`, `src/db/migrations/sync/0000_baseline.sql`, `src/db/migrations/sync/meta/_journal.json`, `src/server/dual-router/repository.ts`, `src/server/nine-router-client.ts`, `src/server/api/routes/antigravity.ts`, `src/server/api/types.ts`, `src/server/app-config.ts`.
**Controller new:** `src/server/antigravity-ownership.ts`, `tests/proxy-ownership.test.ts`, `tests/router-local-rebind.test.ts`.

**Contracts** (new APIs, not existing assumed capabilities):

```ts
interface RouterBindingRevision {
  routerUrl: string; accountId: string; poolId: string | null;
  revision: number; isActive: boolean;
}
interface ProxyOwnershipGrant {
  proxyEndpointKey: string; routerId: string; accountId: string;
  operationId: string; epoch: number; bindingRevision: number;
  expiresAt: number; signature: string;
}
interface BindingUpdate {
  operationId: string; expectedRevision: number;
  expectedPoolId: string | null; desiredPoolId: string | null;
  expectedIsActive: boolean; desiredIsActive: boolean;
  expectedPoolRevision: number | null;
  grant: ProxyOwnershipGrant | null;
}
type ConditionalUpdateResult =
  | {status:'applied'; binding:RouterBindingRevision}
  | {status:'conflict'|'unsupported'|'no_capacity'; reason:string};
```

API:

```text
GET  /api/antigravity/safety-capabilities
     {protocolVersion:1, strictTls:true, conditionalBinding:true, nodeLocalAudit:true}
GET  /api/providers/:id/binding
     RouterBindingRevision without credentials
PUT  /api/providers/:id/binding
     BindingUpdate -> ConditionalUpdateResult; conflict = HTTP 409
POST /api/providers/:id/route-drain
     {operationId, expectedRevision, epoch} -> {drained:true, epoch, revision}
POST /api/providers/:id/quota-verification
     {expectedRevision, expectedPoolId, expectedPoolRevision} -> fresh QuotaEnvelope
```

All operations authenticated using management channel; quota verification uses only stored account credential, not a caller token. Bind/drain requests have bounded JSON validation, local account/provider/pool existence checks, idempotent operation-ID matching, and reject deleted/inactive pools for activation. Return only safe fields. Grant verification uses Node crypto Ed25519: controller private key in protected config, router pinned public key plus explicit router identity. No unsigned externally supplied ownership grant and no secrets in query strings.

Register all new capability/audit/binding/drain/verification endpoints in `src/dashboardGuard.js`'s `ALWAYS_PROTECTED` handling: require a verified management session or CLI token even if `requireLogin:false`. A caller-supplied trusted-peer header alone is not authentication. Tests cover unauthenticated requests, spoofed peer header, disabled login setting, malformed JSON, foreign local IDs and mismatched signed grant. Keep management traffic on the existing authenticated private transport; never send controller credentials over public plaintext HTTP.

Controller adds authenticated `POST /api/antigravity/ownership/reserve`, `/renew`, and `/release` in its existing Antigravity Hono route. Requests contain validated router/account/endpoint/revision/operation IDs; only the pre-registered router identity may renew its owner record, and renew never transfers owner. Responses return signed grants or HTTP 409 conflict; unsupported/missing configuration is HTTP 503, not fail-open. Reuse existing authenticated management connections with header credentials, not public exemptions/query-string credentials. The router's pinned authority URL cannot be request-controlled. Canonicalize the signed payload to a fixed ordered field list, encode UTF-8, sign with `crypto.sign(null, payload, key)` and base64url; `crypto.verify` checks exact tuple, expiry, and persisted epoch. Grant refresh is bounded by original request deadline and must finish before dispatch.

**Ownership algorithm, chosen for partition safety:**

Use one `proxy_ownership` authority table in controller `router-sync.sqlite3`, plus `proxy_bindings` placements. Columns include endpoint key, owner router/account, operation ID, monotonically increasing epoch, state `reserved|active|draining|blocked`, expiry, and binding revision. One primary-key row per physical endpoint, unique placement `(router_id,account_id)`. Capacity checks and reservation run through a synchronous `client.raw.transaction(work).immediate()` call. No network calls inside SQLite transactions.

1. Reserve target if there is no conflicting owner and no more than two bound placements; epoch never decreases. Include inactive standby bindings in capacity count.
2. Issue a signed five-minute grant tied to router/account/binding revision/epoch. Router validates it before each dispatch. Existing owner may renew on normal request/maintenance path; no independent timer.
3. The router stops dispatching when grant expires. Expiry alone does **not** release authority ownership. A second router cannot take over until the old one acknowledges a drain at that epoch.
4. Transfer: mark old owner draining in a short DB transaction; authenticated old-router call freezes new dispatch for epoch and waits for its tracked upstream attempts to finish/cancel. New requests on that old epoch are refused before upstream. Router persists frozen epoch; restart cannot resurrect it.
5. Only a valid drained acknowledgement permits the authority to atomically replace ownership and issue the next epoch. Delayed old acknowledgements cannot release a new epoch. If old router/controller is unreachable, retain blocked/draining ownership, no automated takeover.
6. Active rebind reserves target ownership before CAS, then drains/releases old route after in-flight attempts finish. It may briefly hold both endpoint grants for the same account; never grants either endpoint to a different active owner. Failure retains a durable pending record until the next unified cycle reconciles it; do not silently leak or TTL-reclaim ownership.
7. Controller restart loads authority records and freezes unresolved operations until router reconciliation. Duplicate `operationId` with identical payload returns original result; different payload conflicts. Crash tests cover before reservation, after reservation, after CAS and before verification.

- [ ] Write failing tests with real isolated SQLite and two simulated routers; barriers force simultaneous reserve/CAS. Assert one active owner, stale CAS no mutation, capacity <=2, unknown capability no unconditional PUT, replayed drain cannot release newer epoch, expiry/partition never grants another owner. Run full files red.
- [ ] Add router binding/pool integer revisions using its migration registry and bump `SCHEMA_VERSION`. Update revision only when relevant binding/active state or pool URL/credential/CA/routing changes; credential refresh must merge atomically without changing/overwriting binding. Store high-water epoch/draining state using router DB adapter, not a process Map alone. Local adapter transactions must be synchronous; never await network in transaction callbacks.

```sql
-- Conceptual CAS inside existing router transaction/repo, not a controller GET+PUT:
UPDATE providerConnections SET data = ?, isActive = ?, updatedAt = ?
WHERE id = ? AND json_extract(data, '$.bindingRevision') = ?;
```

Use the adapter-supported compare/transaction pattern if JSON SQL is unavailable; capability is unsupported unless atomicity is proven on the active adapter. Merge fresh row JSON inside the transaction and verify expected pool/active/revision. Unrelated name/token metadata must be preserved.
- [ ] Add `reserveProxyOwnership(input: BindingUpdate & {routerId:string; accountId:string; proxyEndpointKey:string}): Promise<ProxyOwnershipGrant | {conflict:true}>` and `releaseProxyOwnership(grant: ProxyOwnershipGrant, drainedEpoch: number): Promise<boolean>` to controller ownership service. Persist placements/grants via existing sync DB repository; do not log private keys/signatures.
- [ ] Implement signed grant verification/router drain and quota verification APIs with capability response. Rejected generic legacy binding writers must not bypass grant/CAS via direct DB upserts. Do not set `testStatus:'active'` on repair; existing repo behavior clears all model locks on that flag.
- [ ] Run full new files, `tests/dual-router-repository.test.ts`, `tests/drizzle-migration-regression.test.ts` and upstream binding/DB migration suites. Exercise actual API conflict/unsupported responses using HTTP fixture servers. Commit router/controller schema and service changes separately.

Ownership schema must be added through Task 3's explicit known sync-baseline upgrade, preserving usage events/receipts/conflicts/baselines. Include signing-key configuration in secret-safe backup/restore handling, but never expose controller private key in public settings or automatically push it to Git. Restart with missing/rotated key blocks grant issuance until both routers are deliberately reprovisioned; do not reset authority epochs or silently trust another key.

## Task 6: Migrate every binding and activation writer; preserve two-master semantics

**Controller files:** `src/server/dual-router/identity.ts`, `src/server/dual-router/adapter.ts`, `src/server/dual-router/merge.ts`, `src/server/dual-router/coordinator.ts`, `src/server/dual-router/types.ts`, `src/server/antigravity-rotator.ts`, `src/server/server.ts`, `src/server/api/routes/ninerouter.ts`, `src/server/nine-router-client.ts`.
**Router files:** Task 5 connection/pool repositories and provider create/update/import paths discovered via references; direct account toggle/bind UI consumers of changed API contract.
**Tests:** `tests/dual-router-identity.test.ts`, `tests/dual-router-adapter.test.ts`, `tests/dual-router-merge.test.ts`, `tests/dual-router-coordinator.test.ts`, `tests/repro-proxy-splitbrain.test.ts`, `tests/unified-sync-coordinator.test.ts`, `tests/ninerouter-node-proxy.test.ts`.

- [ ] Write red regressions: primary/secondary different pool IDs for same endpoint, peer unavailable, activation-before-deactivation dependency, two active accounts/fewer proxies, matching account email active on both masters, and concurrently changing candidate pool revision. Both manual bind and speed operation must conflict/refuse rather than overallocate.

```ts
// Extend existing actual planner fixtures, not source-text tests.
const plan = computeRotationPlan([
  {id:'bad',isActive:true,sessionPercentage:80,weeklyPercentage:80,
    resetAt:null,proxyPoolId:'unsafe',quotaAvailable:true},
], []);
assert.deepEqual(plan.proxyReassignments, {});
// Execution path must block unsafe dispatch; no direct or same-pool fallback.
```

- [ ] Add `proxyEndpointKey(proxyUrl: string): string` separate from `poolKey`: lowercase protocol/host, resolve standard port, strip credential/path/query, conservatively treat same endpoint as one physical proxy. Cross-router mapping still resolves exact existing pool semantics internally; never serialize raw credential-bearing `poolKey`. Distinct credentials may share one physical endpoint, so capacity uses endpoint key. Opaque pool revision detects credential/routing change without credential hashes in public DTOs.
- [ ] Router-local snapshot exposes canonical desired pool reference. Before applying a merge on B, look up B's local pool ID. Missing/ambiguous local pool is conflict/unsupported, not permission to insert A's ID or dispatch direct. Controller DB stores canonical bindings; router API receives only target-local ID.
- [ ] Add `proxyPoolId` to actual merge coupling; topologically apply prerequisite deactivation/unbind/drain before activate. If prerequisite pending/failed, dependent operation cannot apply. Migrate rotation, manual `PUT /api/ninerouter/nodes/:nodeId/connections/:connectionId/bind-pool`, speed optimization, pool delete/unbind, backup/import and dual-sync binding/active state mutations to Task 5's conditional contract. New controller client is `updateConnectionConditional(accountId:string, update:BindingUpdate, overrides:NineRouterRequestOverrides): Promise<ConditionalUpdateResult>`; plain `updateConnection` remains only for unrelated metadata.
- [ ] For activation policy keep Gemini **session** threshold <=20%, reserve >20%, earliest valid reset first, default/configured active limit. Keep weekly data display-only. Unknown/stale session cannot activate a reserve, but quota-only failure does not deactivate running chat. Unsafe route is blocked independently. Remove modulo speed assignment when fewer eligible proxies than active placements; return explicit unmet capacity. No global sync/rotation mutex.
- [ ] Grep every `proxyPoolId`, `providerSpecificData`, `isActive`, `updateProviderConnection`, `updateConnection`, and model-lock clearing writer in both repositories; include all discovered callers rather than stopping at listed files. LSP references before signature changes. Update affected UI request/response contracts without restyling tables/sidebar.
- [ ] Run **all full files listed above**, upstream conditional-binding/creation/import tests and controller API modules, then actual two-router HTTP fixture smoke. Commit: `fix(router): migrate all proxy ownership writers`.

## Task 7: Verified repair, safe rollback and old-path removal

**Controller new:** `src/server/antigravity-repair.ts`, `tests/antigravity-repair.test.ts`.
**Controller existing:** `src/server/antigravity-rotator.ts`, `src/server/server.ts`, `src/server/api/routes/antigravity.ts`, `src/server/unified-sync-coordinator.ts`, `src/server/api/types.ts`, `src/lib/types.ts`, `src/lib/api.ts` and discovered repair callers.
**Router:** Task 5 APIs and Task 2 quota verification.

**Contract:**

```ts
export interface RepairRequest {
  routerId: string; accountId: string; operationId: string;
  expectedBinding: RouterBindingRevision;
  cause: 'unsafe_transport' | 'verified_proxy_denial' | 'manual_quota_diagnostic';
  signal: AbortSignal;
}
export type RepairResult =
  | {status:'repaired'; binding:RouterBindingRevision; verifiedAt:number;
      observation:QuotaObservation}
  | {status:'no_candidate'|'conflict'|'verification_failed'|'unsupported'|
      'not_applicable'|'aborted'; reason:string; binding:RouterBindingRevision};
export function repairAntigravityRoute(request: RepairRequest): Promise<RepairResult>;
```

- [ ] Write behavioral tests red: empty quota does not initiate repair; same pool never success; PUT-only success insufficient; cached/changed-revision verification insufficient; 0% fresh valid quota means repaired route but exhausted account; no candidate leaves safe state unchanged; failed verify rollback cannot overwrite a concurrent newer binding. Missing session still leaves session unknown, not fabricated 100%.

```ts
// Using existing isolated router fixtures and real repair service.
assert.equal(result.status, 'verification_failed');
assert.equal(await fixture.currentBindingRevision(), newerRevision);
assert.equal(fixture.activeOwnersFor(endpointKey), 1);
```

- [ ] Implement candidate selection from correct router's active, current-revision, safe audit records. Automatic repair requires actual unsafe route/verified proxy denial. Generic quota 403 alone cannot cause automatic mass rotation; a manual `manual_quota_diagnostic` may perform one controlled comparison on an inactive account after strict preflight, retains uncertainty, and never globally bans a proxy. Empty quota alone is `not_applicable`.
- [ ] Freeze/drain relevant account route, reserve candidate, conditional bind, read back, then invoke forced fresh quota verification. Keep one candidate attempt per operation. Reject canceled/deadline-expired work before each mutation/dispatch; after an already-applied mutation record its known state for reconciliation instead of claiming nothing happened.
- [ ] Verification success requires actual valid quota fields and correct route/revisions/fresh timestamp; no generic `quotas` truthiness/non-empty-only success. If caller requests session validation, valid finite Gemini session is required; other valid model observations can be returned as partial, never session proof.
- [ ] On failure, restore only prior **safe** route using expected installed revision. If superseded, leave newer state. If old route unsafe/no rollback, preserve unresolved state and strict dispatch block; report no success. Do not toggle `isActive`, clear genuine quota/model locks, delete accounts, or report ban. Release only ownership belonging to completed/rolled-back operation with drain acknowledgement.
- [ ] Replace `autoRepairForbidden()` and `POST /api/antigravity/auto-repair-forbidden` with `repairAntigravityRoute()` and authenticated `POST /api/antigravity/repair-route`. Migrate every caller/test; no deprecated alias or second implementation. Batch user/manual operation composes per-account repair, reports per-account results and verified count only. Keep status/usage APIs' fresh/stale indicators consistent.
- [ ] Run full repair, rotator, rotation-history, Hono contract and unified-sync files. Launch controller with isolated data and fixture routers; exercise actual authenticated repair endpoint and observe state/result. Commit: `fix(antigravity): verify repairs before reporting success`.

Runtime progress gate: first prove strict route comparison, then conditional binding, then uncached quota proof. If only generation recovery is verified, expose that observation separately; the quota repair operation remains unresolved. Manual diagnostic comparison on quota-only 403 is opt-in for that account, not a new automatic proxy reordering routine.

---

# Package C — bounded in-flight recovery and rollout

## Task 8: Retry inside 9Router before response handoff, never from logs

**Router new:** `open-sse/services/antigravityRecovery.js`, `tests/unit/antigravity-precommit-retry.test.js`.
**Router existing:** `src/sse/handlers/chat.js`, `open-sse/handlers/chatCore.js`, `open-sse/executors/base.js`, `open-sse/executors/antigravity.js`, `open-sse/services/combo.js`, `open-sse/services/emptyFailover.js`, `open-sse/utils/streamHandler.js`, `open-sse/handlers/chatCore/streamingHandler.js`, actual `/api/v1/chat/completions`, `/messages`, `/responses` routes.
**Controller:** ownership/audit services from Tasks 4–7; no new watcher service.

**Attempt context:**

```ts
interface AntigravityAttemptContext {
  remainingRefreshRetries: 0 | 1;
  remainingRebindRetries: 0 | 1;
  committed: boolean;
  signal: AbortSignal;
  deadlineAt: number;
}
```

At HTTP entry allocate one context; nested combo/account/executor calls share it. Public headers/body cannot reset budget. Commitment latch becomes irrevocably true **before returning/handing off a successful streaming Response** to Next/HTTP writer. This conservative boundary is earlier than headers on the wire and avoids pretending `chatCore` owns the raw socket. No retries after response handoff even if only role/heartbeat/reasoning is sent. Existing pre-handoff buffered empty-response behavior is not a license to restart a committed stream; do not broaden unrelated provider behavior.

- [ ] Add red integration tests using actual handler plus loopback fixture upstream: first pre-submit strict TLS rejection then safe response yields one rebind retry; generic validated Google 403 yields no rebind; explicit auth expiry refreshes once; ambiguous post-submit socket close never silently retries; token refresh and rebind budgets do not reset in combo/account fallback; aborted client/deadline produces zero later dispatches.

```js
import { expect, it } from 'vitest';
import { canRetryRoute } from '../../open-sse/services/antigravityRecovery.js';
it('refuses replay after a response was handed off', () => {
  const context = {remainingRefreshRetries:1, remainingRebindRetries:1,
    committed:true, signal:new AbortController().signal, deadlineAt:Date.now()+5000};
  expect(canRetryRoute(context, {
    code:'TLS_UNTRUSTED', phase:'tls_handshake', requestSubmitted:false,
    poolId:'p', poolRevision:1,
  })).toBe(false);
});
```

Also test post-header stream error at actual HTTP surface (role/heartbeat/content frames); count generations upstream remains one and client receives protocol-appropriate terminal error, not a fresh completion. Do not verify source strings.
- [ ] Run full new/related files red with Vitest. Add callback injection at application handler, not a hardcoded controller import into generic open-sse core. The in-process router recovery service uses fixed verified candidate snapshots and valid signed ownership grants; if fresh/available authority is missing, fail safely or use existing eligible-account fallback, not a network-dependent infinite wait.
- [ ] Route failure is eligible only when typed and provably before request submission or an explicit verified proxy rejection. Generic 401 performs refresh once through strict route; generic 403 does not. Existing Antigravity generic 502 network retry in `base.js` must not evade this safety check; disable ambiguous automatic replay for this provider while preserving other providers' semantics.
- [ ] Reserve alternate ownership and CAS via the same router binding service as background repair. For in-flight route recovery, safe transport plus the explicit rejected request permits a bounded retry even if quota visibility is unavailable; do not label the background quota repair `repaired` until its own fresh quota verification succeeds. Keep route/generation success and quota verification distinct.
- [ ] Recreate upstream body/stream/headers from semantic request and current credentials, preserving tool history/signatures/session metadata; do not pass already wrapped `translatedBody` through transforms twice. Cancel/close prior attempt, link original abort signal, decrement shared budget before asynchronous dispatch. Never clear unrelated account/model locks. Return after second route failure; existing account fallback stays bounded by the original exclusion set and same shared context.

```js
export function canRetryRoute(ctx, failure) {
  if (ctx.committed || ctx.signal.aborted || Date.now() >= ctx.deadlineAt) return false;
  if (ctx.remainingRebindRetries === 0) return false;
  return failure?.requestSubmitted === false &&
    ['TLS_UNTRUSTED','PROXY_UNREACHABLE','PROXY_REQUIRED','PROXY_REJECTED'].includes(failure.code);
}
// PROXY_REJECTED is allowed only for an explicit proxy-origin CONNECT refusal
// before submitting the Google request, never generic origin HTTP 403 text.
```

- [ ] Complete files green:

```bash
(cd ../9router-source/tests && npm test -- unit/antigravity-precommit-retry.test.js unit/antigravity-retry-hook.test.js unit/antigravity-stream-options.test.js unit/antigravity-cache.test.js unit/antigravity-quota-routing.test.js)
(cd ../9router-source/tests && npm test)
```

Run actual source server against fixture upstream; exercise `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, stream/non-stream and cancellation. Close servers/readers; remove throwaway smoke scaffolding. Commit: `feat(antigravity): bound safe precommit route recovery`.

## Task 9: Cross-repo verification, staged rollout and safe rollback

**New operational doc:** `docs/superpowers/capability-reports/2026-10-25-antigravity-safety-rollout.md` (created during execution from measured results, not prefilled success).
**Existing docs:** update approved spec status and project product notes after smoke proof. Keep superseded old watcher plan visibly retired.
**Runtime:** fixed SSH targets only; LAN canary then VPN peer gate. Not dynamic inventory, not standby failover.

- [ ] **Consistency gate:** grep the two repositories for every `strictTls`, `strictProxy`, `refreshCredentials`, `fetchAvailableModels`, `retrieveUserQuotaSummary`, `proxyPoolId`, binding/active writer, `autoRepairForbidden`, insecure retry, and direct fallback. Classify each result as migrated provider path, unchanged unrelated provider path, or removed obsolete code. Use semantic references for changed exports. Do not globally replace other providers.
- [ ] **Scope gate:** no UI redesign, new provider roles, residential-only policy, provider impersonation, general workflow engine, account deletion, blanket 403 ban, or automatic secret revocation. Keep changed UI limited to honest unknown/stale display. Old generic network behavior of other providers intentionally unchanged.
- [ ] **Verification gate:** controller `npm test`, `npm run typecheck`, `npm run lint`; source full Vitest and `npm run build`, then `npm run cli:pack`. Capture full results/exit codes and baseline delta. Packaging includes native-runtime dependencies; verify on target Linux arm64/Node v24 baseline rather than assuming a Windows artifact is portable. Assign a unique build version/commit identity to the patched artifact, do not publish over upstream `0.5.109`.
- [ ] **Actual runtime proof:** isolated data roots, fixture account and HTTP/TLS proxies exercise self-signed failure, direct-fallback trap, genuine quota denied, fresh route verification, stale CAS, proxy ownership partition/restart/drain, and pre/post-handoff stream behavior. Tests alone are not deployment proof. Never replay user's real long tool request to provoke failure.
- [ ] **Before deployment:** record service identity, startup arguments, package path, protected config and data paths on both nodes. Save app artifact plus consistent SQLite snapshots, binding revisions, pool records, ownership epochs and signing public keys. Controller snapshot uses `createBackupSnapshot({dataDir, backupDir})` with a private directory; **do not invoke `npm run backup:sync` automatically**, because it pushes to Git. Router DB backup uses its existing backup service with writers drained, not raw live WAL file copies.
- [ ] **Safety canary:** deploy transport/observation build first, automatic rebind disabled. Block/quarantine only unsafe Antigravity dispatch, not globally delete proxies used by unrelated providers. Verify strict configured route cannot leak direct, no insecure dispatcher use, sanitized errors. Do not attach real OAuth token to any untrusted fixture/proxy. Previously observed certificate interception warrants a separate operator credential review; no automatic token rotation in this plan.
- [ ] **Ownership adoption gate:** reconcile both master bindings/active owners into authority. Existing collisions are explicit conflicts, not silently transferred. Verify source capability/protocol version and pinned grant key on each node, then enable conditional writer enforcement. Drain old revisions before issuing grants. If VPN remains unreachable, no cross-master shared-proxy activation/transfer; record rollout partial, not done.
- [ ] **LAN canary:** one explicitly selected inactive/test account, record old revision, audit required hosts from LAN, reserve, conditional rebind, read-after-write, fresh quota verification, then a minimal authorized generation smoke on verified TLS. Do not infer chat success from quota or vice versa. Existing already-safe account bindings must remain unchanged.
- [ ] **VPN and dual-master canary:** restore reachability using existing verified configuration, deploy the same source contract, repeat node-local tests. Exercise concurrent target selection and controller/peer loss with isolated account placements. Prove max two placements/one active physical owner and no foreign pool ID, no TTL takeover. Follow the established router upgrade UI procedure where the updater requires it (show UI, send Enter, hide UI); never treat unreachable node as update success.
- [ ] **Enable C:** only after A/B dual-node gates pass, enable bounded in-flight recovery on those nodes. Observe actual request attempt counts and commitment/cancellation outcomes. Record remaining blocked accounts as structured failures; never fabricate all accounts healthy.
- [ ] **Rollback:** first disable automatic repair/new ownership transfers, freeze signed grant issuance, drain live attempts and retain ownership tombstones/high-water epochs. Roll back application artifact only while keeping strict transport enforced, or stop affected provider dispatch if the old artifact lacks that guarantee. Do not restore an old authority DB over newer epochs while either router can still dispatch. Database restoration requires both writers stopped, protected snapshot consistency, re-established keys/revisions and renewed grants before restart. Never roll back into insecure TLS/direct fallback just to recover availability.
- [ ] **Abort rollout on:** unsafe credential forwarding, direct fallback, post-handoff replay, false repaired result, wrong-node ID, duplicate active owner, unsigned/expired grant acceptance or stale CAS overwrite. Record exact failing invariant and rollback outcome. Do not claim success for unavailable node.
- [ ] After measured smoke, update operational doc with source commit, artifact checksum, controller migration version, tested command results, LAN/VPN results, isolated-account outcomes, rollback artifact and any unresolved prerequisite. Commit only scoped source/docs/tests.

## Acceptance mapping / plan self-review

| Spec contract | Delivering tasks | Required observable evidence |
|---|---|---|
| Strict OAuth/discovery/quota/generation | 1–2 | Local TLS/proxy fixtures observe no unsafe/direct HTTP request |
| Precise states; no fabricated quota | 2–3 | Actual parser/planner/API/UI show unknown/stale separately |
| Fresh per-node/revision audit | 3–4 | Node-local endpoint + persisted expiring DB rows |
| Verified router-local binding | 5–7 | CAS conflict, read-back and uncached quota route metadata |
| Max 2 bound, 1 active shared endpoint | 5–6 | Transactional races, drain/restart/partition proof |
| No stale overwrite or unsafe rollback | 5–7 | Newer revision and ownership epoch survive failure |
| Bounded precommit retry/cancellation | 8 | Actual upstream attempt counts, shared nested budget |
| No retry after any downstream handoff | 8 | HTTP stream remains one generation after role/heartbeat/error |
| Single unified workflow; manual independent | 4, 7 | Existing toggle/maintenance regression modules |
| Cross-repo rollout/rollback | 0, 9 | Versioned artifacts, full checks, actual LAN+VPN canaries |

Self-review at handoff: source/test command packages distinguished; new APIs explicitly marked new; classifier/observation/revision types defined before consumers; schema conventions mapped to actual files; all binding writers required; source/build provenance prerequisite explicit; old insecure/watcher plan not executable. Execution checks stay unchecked because this request produces a plan, not implementation.
