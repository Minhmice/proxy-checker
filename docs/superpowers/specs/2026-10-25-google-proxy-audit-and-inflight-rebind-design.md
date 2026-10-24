# Google Cloud Code Proxy Safety and Antigravity Recovery Design

**Status:** Design approved in chat; implementation not started.

## Goal

Prevent unsafe Google Cloud Code traffic, avoid false `Antigravity quota API access forbidden` classifications, and recover from a confirmed pre-stream proxy failure without replaying a request after its response has been committed to the client.

## Evidence boundary

Observed on the LAN 9Router node running `0.5.109`:

- The proxy `128.199.202.122:1080` successfully reached `www.google.com/generate_204` but failed strict TLS verification for `daily-cloudcode-pa.googleapis.com`. Three other tested proxies failed strict Cloud Code TLS verification; their Google 204 behavior was not checked in that comparison.
- One tested proxy reached `daily-cloudcode-pa.googleapis.com` with valid TLS and received HTTP 401 without credentials.
- The deployed 9Router usage route sets `strictProxy: false`, so usage/refresh may fall back to direct transport when a configured proxy fails.
- The deployed transport can retry certificate failures with an insecure dispatcher.
- Upstream quota code maps quota-endpoint HTTP 403 to `{ message, quotas: {} }`; that message alone does not prove that generation, the account, or the proxy is forbidden.
- Upstream fallback and retry occur inside request handling before stream commitment. Console-log SSE is a read-only diagnostic stream and has no request body, request socket, or replay command.

These observations support the design below. They do not prove that every historical HTTP 403 was caused by a proxy.

## Non-goals

- Do not bypass Google authorization, account restrictions, ToS enforcement, or certificate verification.
- Do not infer account bans from an empty quota response.
- Do not silently route configured-proxy requests direct.
- Do not retry a request after downstream response headers or any response bytes have been committed, even if those bytes contain only role, reasoning, or heartbeat data.
- Do not patch deployed compiled JavaScript directly; modify source and deploy a versioned 9Router build.
- Do not redesign unrelated provider routing or UI.

## Architecture

```text
9Router source
  request handler
    strict TLS + strict proxy policy
    classify upstream response
    pre-commit retry/rebind at most once
    fallback account before stream commitment
    no replay after commitment

proxy-checker
  node-local strict transport probe
  account-specific verification
  per-node/per-proxy/per-endpoint health records
  router-local pool mapping
  compare-and-set rebind
```

### Ownership

**9Router owns request semantics and atomic binding enforcement.** It owns credentials, upstream response metadata, cancellation, and the downstream commitment boundary. A retry is permitted only after explicit upstream rejection or a confirmed failure before submitting the request; no retry is justified solely by an ambiguous disconnect and zero client bytes.

**proxy-checker owns policy and background repair orchestration.** It schedules node-local audits, stores their outcomes in its database, and invokes authenticated router-local conditional binding operations. In-flight handling uses the same policy contract within 9Router; it must not depend on console-log correlation or an external HTTP round trip succeeding. A missing controller, expired health snapshot, or unavailable candidate yields the existing safe error/account fallback path rather than bypassing policy.

## 1. Error state model

### Transport state

```ts
type GoogleTransportStatus =
  | "unknown"
  | "tls_untrusted"
  | "proxy_unreachable"
  | "google_endpoint_reachable"
  | "google_endpoint_denied"
  | "passed";
```

Transport records are scoped by:

```ts
{
  routerUrl: string;
  proxyPoolId: string;
  endpoint: string;
  checkedAt: number;
  status: GoogleTransportStatus;
  expiresAt: number;
  poolRevision: string;
  httpStatus: number | null;
  errorCode: string | null;
}
```

A transport probe MUST:

- use the exact Cloud Code host used by the request path;
- preserve TLS and hostname verification;
- never use `rejectUnauthorized: false`;
- never fall back direct;
- never send an OAuth token;
- redact proxy credentials from persisted errors and logs.
- audit results expire after five minutes; a changed pool URL, credentials, CA configuration, or routing policy invalidates them immediately;
- perform probes from the actual 9Router egress node, through the backend audit workflow; no browser-side audit or independent maintenance timer;
- bound each transport probe to five seconds and at most four concurrent probes per router;
- store classifications in the existing database, not only a pool-state JSON file;
- never follow a redirect or send credentials to a host outside the explicit configured Google endpoint allowlist.

Interpretation:

| Result | Meaning | Automatic action |
|---|---|---|
| TLS certificate error | Proxy path is unsafe/untrusted | Exclude from Antigravity assignment |
| Timeout/reset/connect failure | Proxy transport degraded or unknown | Do not assign until a later successful probe |
| HTTP 401 without token | Cloud Code endpoint reachable | Eligible for account-specific verification |
| HTTP 403 without token | Endpoint reachable but denied | Do not blacklist by itself; retain evidence |
| HTTP 2xx | Endpoint reachable | Eligible for account-specific verification |

### Account quota state

```ts
type AntigravityQuotaStatus =
  | "known"
  | "unknown"
  | "auth_expired"
  | "account_forbidden"
  | "transport_failed";
```

Rules:

- `quotas: {}` without an explicit message is `unknown`, not forbidden.
- A quota endpoint HTTP 403 is a denied quota observation for that account/proxy/endpoint attempt. Generic 403 or the current display message yields `unknown` with HTTP status 403; reserve `account_forbidden` for a verified, structured account/permission denial. Neither result is evidence of an account ban or a global proxy ban.
- `usage.message`, `usage.error`, HTTP status, and endpoint must be retained separately.
- Valid 0% quota plus a future reset time is `known` and exhausted, not a proxy failure.
- A transport exception is `transport_failed`; it must not be converted into quota exhaustion.
- Preserve the last valid quota reading with its original observation timestamp and stale marker when a soft 401/403/empty response arrives; never present that cached reading as a fresh verification. Quota-unavailable accounts are not assigned synthetic 0% or 100%. Preserve an already-running account when only quota visibility fails, while independently enforcing transport safety.

## 2. Preflight design

### Stage A: strict transport probe

For each router-local pool, run a bounded probe to:

```text
https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels
```

The probe sends no credentials. It records status and TLS/transport outcome. It is not a quota check and does not assert account eligibility.
Probe OAuth and all configured Cloud Code hosts used by discovery, quota, and generation, including `oauth2.googleapis.com`, before sending credentials through a new path. The displayed daily quota URL is one target, not permission to substitute a different provider's endpoint. A valid-TLS unauthenticated HTTP response demonstrates reachability only. `passed` means strict transport checks passed for the required target set; account authorization remains separate.

A generic Google 204 endpoint MAY remain as a secondary internet-connectivity signal, but it MUST NOT determine Antigravity eligibility.

### Stage B: account-specific verification

After transport status is `google_endpoint_reachable` or `passed`, quota verification may use the account token through the exact router-local proxy. The verification must identify:

```ts
{
  accountId: string;
  routerUrl: string;
  proxyPoolId: string | null;
  quotaStatus: AntigravityQuotaStatus;
  quotaKeys: string[];
  message: string | null;
  error: string | null;
  checkedAt: number;
}
```

A proxy is eligible for new Antigravity assignment only when strict transport is healthy. Account-specific 403 evidence may trigger a bounded repair attempt but cannot alone prove that the proxy is globally blocked.
Account verification must force a new upstream fetch through the exact candidate, bypassing account/quota-summary caches for that verification only. Cache keys/invalidation must account for node, proxy binding revision, and project; existing token/project-only cache hits cannot prove the new route. Keep tokens inside 9Router, omit them from controller responses, and return observation time, route identity, freshness, and structured endpoint outcome instead of credential material.

## 3. TLS and proxy policy

The 9Router source transport used for OAuth, quota, and generation MUST support strict mode:

- no insecure certificate retry;
- no direct fallback when a connection proxy is configured;
- explicit CA configuration only when the CA is administratively trusted;
- structured error code for `TLS_UNTRUSTED`, `PROXY_UNREACHABLE`, and `PROXY_REQUIRED`.

`strictProxy` must be true for the Antigravity request path where a connection pool is configured. Usage and token refresh must not silently leave the configured proxy. A configured proxy failure is observable and repairable; it is not permission to expose the real source address.

## 4. In-flight recovery boundary

Recovery belongs in the 9Router request handler, not the console watcher.

```text
select account and router-local proxy
  ↓
execute upstream request
  ↓
if non-stream error before commitment:
  401 → refresh once, retry same request
  403 → classify; optionally rebind and retry once
  409/429 → quota cache/reset handling
  other → return structured error
  ↓
if HTTP 200 stream:
  inspect only existing pre-commit gate
  ↓
downstream headers or first response bytes committed
  ↓
never replay or change account for this request
```

### Retry invariants

- The end-to-end request has one shared budget: at most one proxy-rebind retry and one token-refresh retry across account/combo fallback, not a fresh budget at each nested layer. Existing non-Antigravity retry behavior stays unchanged.
- Refresh once for explicit authentication expiry; do not blindly refresh on generic HTTP 403, TLS failure, or a permission denial.
- Rebind retry requires a structured, route-attributed failure: explicit transport rejection before request submission or verified proxy-level denial. Generic Google account 403 and ambiguous post-submission disconnects are not eligible. A TLS failure may be retried only through a separately verified safe candidate, never by relaxing verification.
- Candidate proxy MUST have a fresh strict transport pass for the actual router, current pool revision, and required endpoint set.
- Candidate binding MUST be router-local and atomically reserve active-proxy ownership before use.
- Rebuild the attempt-specific body, headers, and upstream stream while preserving semantic session/tool history and linking cancellation to the original abort signal; never replay a consumed stream body or detach client cancellation.
- Cancel/close the rejected attempt before reuse. Abort or request-deadline expiry cancels verification, rebind work, and retry; no delayed background retry of the original request.
- After downstream commitment, close/report the failed stream according to the existing protocol; do not append a second generation or silently replay.
- A console-log watcher may emit telemetry or schedule background repair, but it cannot retry the original request.

## 5. Rebind and multi-router identity

Pool IDs are local to a 9Router instance. They MUST NOT cross router boundaries.

Canonical identity for comparison:

```ts
{
  routerUrl: string;
  localPoolId: string;
  canonicalProxyKey: string;
}
```

`canonicalProxyKey` uses the existing canonical pool identity convention, derived from normalized protocol/host/port without publishing credentials. Credential/routing/CA changes carry a separate opaque pool revision to invalidate health. Identity is for comparison; pool IDs and credentials remain router-local. For shared physical proxy exclusivity across dual masters, use canonical identity, not coincident pool IDs. When peer ownership cannot be verified, do not grant new active ownership of a shared proxy.

Rebind sequence:

1. Read account and its current binding from the target router.
2. Read candidate pools from the same target router.
3. Exclude candidates with unsafe/degraded transport state.
4. Exclude the original failed candidate, over-capacity pools, and any proxy with a different active owner, including an owner on the other master.
5. Atomically compare the expected old binding and revision, reserve candidate active-proxy ownership, and write the new binding on the target router. A read followed by an unconditional PUT is not compare-and-set.
6. Read account back from the same router.
7. Run account-specific verification through the new binding.
8. Report `repaired` only if steps 6 and 7 pass.

If no clean router-local candidate exists, leave the binding unchanged and return an explicit `no_candidate` result. Never reassign the old failed pool as a fallback.
If account verification fails after a successful binding change, return `verification_failed`, not `repaired`. Restore the prior safe binding only with a conditional update proving the operation still owns the installed revision; never overwrite a newer change or restore an unsafe route. If no safe restoration is possible, keep an explicit unresolved failure and prevent unsafe dispatch. Background quota repair changes neither `isActive` nor unrelated account metadata. Rebinding does not reset valid quota exhaustion or blindly clear model locks; only route-caused failure state attributable to this operation may be cleared after verification.

## 6. Concurrency

Mutations are serialized per `(routerUrl, accountId)`, not by a global mutex. Pool sync, rotation, speed optimization, and repair may continue independently for unrelated accounts.

Each mutation carries:

```ts
{
  operationId: string;
  routerUrl: string;
  accountId: string;
  expectedPoolId: string | null;
  desiredPoolId: string | null;
}
```

A stale expected binding causes the operation to stop and re-read state. It must not overwrite a newer binding.

The assignment policy is at most two bound accounts per proxy and at most one active account per shared proxy, across both masters. Candidate ownership must be reserved atomically by proxy identity in addition to the per-account mutation guard; separate account locks alone do not prevent two repairs choosing the same free proxy. Preserve router sync and rotation concurrency for unrelated state. Missing/deleted pools never imply permission to dispatch direct; reservations are released on failure and expire safely after process loss.

Cross-master exclusivity requires one authoritative atomic ownership record per shared canonical proxy, not two independent local locks or a read of peer state followed by a write. Reuse the existing controller database for the ownership authority; request handling consumes a valid ownership grant for its node, account, and binding revision. If a grant expires, the router must stop dispatching and finish or cancel dependent upstream work before releasing or reassigning ownership; expiry alone cannot permit a second owner while the old router may still dispatch. During controller or peer partitions, do not transfer ownership or activate a new shared-proxy owner without authoritative confirmation. The implementation plan must specify the transactional reservation and release protocol before enabling cross-master recovery.

All mutation paths in this feature use router-side atomic expected-revision checks. Controller-local locks protect only that process and are not a substitute for router-side enforcement or shared-proxy ownership. An absent revision/capability on an old router is `unsupported`; do not emulate atomicity with GET plus unconditional PUT.

## 7. Required source changes

### 9Router source

- Add strict transport options for Antigravity OAuth/quota/generation.
- Remove insecure TLS retry from the strict Antigravity path.
- Remove direct fallback when a configured proxy is required.
- Preserve structured status/body metadata for 401/403/409/429.
- Move proxy-rebind retry into the pre-commit request handler.
- Keep existing account fallback and quota reset behavior.
- Add tests for retry count and stream commitment.

### proxy-checker source

- Replace boolean `googleBlocked` design with scoped transport status.
- Add strict Cloud Code transport probe.
- Persist audit state keyed by router, local pool, endpoint, and timestamp.
- Centralize quota/error classification; remove divergent regex copies.
- Make rebind router-local and compare-and-set.
- Verify binding and quota after update.
- Ensure repair never returns success for same-pool or unverified updates.
- Fix planner behavior for unknown quota, forbidden transport, missing pools, invalid reset dates, and proxy assignment collisions.
- Add `proxyPoolId` to dual-router dependency coupling where applicable.
- Keep console SSE diagnostic-only.

## 8. Test contract

Permanent tests MUST cover:

1. strict TLS failure never transmits OAuth credentials over an unverified connection and never retries insecure;
2. configured proxy failure does not fallback direct;
3. Cloud Code 401 without token is reachable, not blocked;
4. empty quota without message is unknown;
5. quota 403 does not globally blacklist proxy;
6. valid 0% quota with reset is exhaustion;
7. old valid quota cache survives soft 403/empty response;
8. a route-attributed pre-commit rejection can rebind and retry once, while generic account 403 cannot trigger blind proxy rotation;
9. after any downstream headers or bytes, including heartbeat/role frames, an error never replays;
10. stale compare-and-set rebind does not overwrite newer state;
11. router A pool ID is never written to router B;
12. no candidate leaves binding unchanged and reports failure;
13. successful repair requires read-after-write and account verification;
14. no more than two accounts are bound per proxy and no more than one is active per shared proxy across both masters;
15. concurrent rotation and repair preserve the newest binding.
16. cancelled requests and exhausted shared retry budgets produce no extra upstream attempts;
17. route changes invalidate old health/quota evidence; cached quota is not accepted as candidate verification;
18. competing repairs reserve different active ownership or return conflict without overwriting;
19. verification failure rolls back only its own revision, never a newer write or an unsafe binding;
20. quota-only 403 never fabricates exhaustion, bans an account, or disables working chat by itself;
21. unavailable peers/controllers never cause direct fallback or a second active owner of a shared proxy.

Verification commands:

```bash
npm test
npm run typecheck
npm run lint
```

Runtime smoke verification must use an isolated/test account and a router-local candidate. It must confirm strict TLS outcome, binding before/after, quota verification result, and absence of direct fallback in logs. Production account state must not be mutated as part of unit verification.

## Acceptance criteria

The design is implemented only when:

- Antigravity OAuth, quota, and generation paths fail closed on untrusted TLS.
- Generic Google connectivity is not used as Antigravity eligibility proof.
- Quota 403, account 403, transport failure, and exhausted quota are distinct states.
- Rebind and retry happen in the request handler before stream commitment.
- No automatic replay occurs after any downstream commitment, including headers or non-content frames.
- Rebind is router-local, compare-and-set, read-after-write verified, and quota-verified.
- The repair path never reports a same-pool or unverified repair.
- All affected classifiers and callsites use one shared contract.
- Full test, typecheck, lint, and isolated runtime smoke checks pass.

## Source and deployment boundary

Upstream research was pinned to `decolua/9router` commit `f39d8f07481ae8518e93175f0ecaaafa61573c6c`; the observed deployed npm version was `0.5.109`. These are not asserted to be identical source revisions. Implementation planning must identify a writable, reproducible 9Router source checkout matching the deployment, pin the base revision, and verify its build/test commands before naming final patch sites. This proxy-checker repository alone cannot deliver an in-flight 9Router retry hook. No compiled-bundle patching or undocumented DB writes are acceptable substitutes.

The authenticated conditional rebind/reservation contract must be implemented in 9Router for all binding writers affected by this feature: background repair, rotation, manual/speed binding, and relevant dual-master synchronization. Retire the current unverified `autoRepairForbidden` behavior and its callers under the corrected contract; do not keep a second legacy repair path. Unreachable VPN-node smoke verification remains an explicit deployment prerequisite, not evidence of a passing dual-master rollout.

Delivery consists of dependent, separately verifiable work packages: (A) strict 9Router transport and structured observation; (B) backend/database audit plus conditional router-local repair and ownership; (C) bounded pre-commit recovery and two-node rollout. Package C requires the actual source/build and ownership contracts from A/B. Keep these boundaries in the implementation plan rather than introducing a general-purpose workflow framework or unrelated refactors. New background work stays inside the existing unified maintenance cycle; manual repair remains independent of the automatic-sync toggle.

The earlier spec `2026-10-25-google-proxy-audit-and-inflight-rebind.md` and corresponding console-watcher implementation plan are superseded. They must not be executed: neither Google 204, blanket 403 blacklisting, nor a console watcher meets this specification.

## Evidence references

- Quota classification: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/open-sse/services/usage/google.js
- Usage proxy policy: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/src/app/api/usage/%5BconnectionId%5D/route.js
- Transport fallback: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/open-sse/utils/proxyFetch.js
- Quota summary cache: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/open-sse/services/usage/antigravity-weekly.js
- Request retry boundary: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/open-sse/handlers/chatCore.js
- Account fallback: https://github.com/decolua/9router/blob/f39d8f07481ae8518e93175f0ecaaafa61573c6c/src/sse/handlers/chat.js
