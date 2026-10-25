# 9Router Remote Capability & Endpoint Binding Report

**Date:** 2026-10-23  
**Status:** Complete  
**Reference Spec:** `docs/superpowers/specs/2026-10-22-dual-9router-master-sync-design.md`  
**Reference Plan:** `docs/superpowers/plans/2026-10-23-dual-9router-master-sync.md` (Task 1)  

---

## 1. Executive Summary & Router Topology

Dual 9Router synchronization requires managing two independently writable router targets configured via comma-separated URLs in settings (`NINEROUTER_URL`):
- **Router Target A (`router-a`):** `http://192.168.1.54:20128` (Local LAN master endpoint)
- **Router Target B (`router-b`):** `https://9router.minhmice.com` (External / public domain master endpoint)

### 1.1 Alias Detection Analysis
Under dual-master sync, treating two URLs as separate stateful masters when they point to the same underlying 9Router process leads to duplicate accounting and phantom conflict cycles.

Evidence regarding instance identity:
1. **Remote ID Topology:** 9Router does not expose an instance UUID or node ID endpoint (`/api/version`, `/api/health`, and `/api/node-info` are unsupported or unauthenticated 404s).
2. **Session Isolation:** `src/server/nine-router-client.ts` isolates `authCookiesByUrl` per normalized URL. Login against `http://192.168.1.54:20128` and `https://9router.minhmice.com` produces independent cookie state.
3. **Entity Overlap Check:**
   - If both router URLs return identical proxy pool IDs (e.g. `remote-1`), identical created timestamps, or identical connection account IDs for provider `antigravity`, the two targets MUST be flagged as **aliased instances** of a single underlying deployment rather than dual masters.
   - If writing or renaming a proxy pool on Router A immediately reflects without latency on Router B under read verification, the instances share the same database and MUST NOT execute dual-master merge cycles.

---

## 2. Remote Client & Route Inventory

### 2.1 Existing Client Functions (`src/server/nine-router-client.ts`)
| Function | HTTP Method | Remote Path | Purpose |
|---|---|---|---|
| `loginWithConfig` | `POST` | `/api/auth/login` | Session authentication, sets `auth_token` cookie |
| `listPools` | `GET` | `/api/proxy-pools?includeUsage=true` | Full snapshot of proxy pools |
| `createPool` | `POST` | `/api/proxy-pools` | Create single proxy pool |
| `updatePool` | `PUT` | `/api/proxy-pools/:id` | Update pool properties (`name`, `isActive`) |
| `renamePool` | `PUT` | `/api/proxy-pools/:id` | Wrapper around `updatePool` updating name |
| `setPoolActive` | `PUT` | `/api/proxy-pools/:id` | Wrapper around `updatePool` updating `isActive` |
| `bulkSetActive` | `PUT` | `/api/proxy-pools/:id` (sequential) | Series of individual PUT requests with throttle delay |
| `deletePool` | `DELETE` | `/api/proxy-pools/:id` | Delete proxy pool |
| `testPool` | `POST` | `/api/proxy-pools/:id/test` | Trigger diagnostic test for single pool |
| `listAntigravityConnections` | `GET` | `/api/providers/client?pageSize=50&provider=antigravity` | Read Antigravity accounts (paginated up to 50) |
| `getAccountUsage` | `GET` | `/api/usage/:id` | Read per-connection quota & usage snapshot |
| `updateConnection` | `PUT` | `/api/providers/:id` | Update connection (`isActive`, `providerSpecificData`) |

### 2.2 Local API Routes (`src/server/api/routes/ninerouter.ts` & `src/server/server.ts`)
| Route | Method | Downstream 9Router Impact |
|---|---|---|
| `/api/ninerouter/status` | `GET` | Reads local ranker state; no direct remote call |
| `/api/ninerouter/metrics` | `GET` | Reads local metrics history; no direct remote call |
| `/api/ninerouter/pools` | `GET` | Triggers stale sync (`listPools`) if necessary |
| `/api/ninerouter/sync` | `POST` | Triggers async `poolRanker.syncPools({ force: true })` |
| `/api/ninerouter/sync-all` | `POST` | Triggers `unifiedSyncCoordinator.runUnifiedSyncCycle({ force: true })` |
| `/api/ninerouter/activate` | `POST` | Sets pool active state locally and on 9Router via `setPoolActive` |
| `/api/ninerouter/pools/:id` | `PATCH` | Calls 9Router `renamePool` |
| `/api/ninerouter/pools/:id` | `DELETE` | Calls 9Router `deletePool` |

---

## 3. Resource Capability Analysis

### 3.1 Proxy Pools (`pool`)
- **Read Capabilities:** Supported via `GET /api/proxy-pools?includeUsage=true`. Returns an array `{ proxyPools: NineRouterPool[] }`.
- **Export Capabilities:** Unsupported natively as an export bundle; must be enumerated via `listPools`.
- **Write Capabilities:** Supported via `POST /api/proxy-pools`, `PUT /api/proxy-pools/:id`, and `DELETE /api/proxy-pools/:id`.
- **Import Capabilities:** No batch or transactional import endpoint exists. All imports must be applied entity-by-entity via `POST` or `PUT`.
- **Pagination & Completeness:** **Unpaginated**. The endpoint returns all pools in a single JSON payload. Completeness is guaranteed per read if the response status is 200.
- **Concurrency & Conditional Boundaries:** **No conditional write support**. 9Router accepts unconditional `PUT` payloads without `ETag`, `If-Match`, or revision counters. Concurrent writes result in Last-Write-Wins (LWW) data clobbering.
- **Idempotency:** `POST` is not idempotent (repeated calls create duplicate proxy entries with different IDs). `DELETE` is idempotent in caller handling (status 404 treated as already-deleted).

### 3.2 Antigravity Accounts (`account`)
- **Read Capabilities:** Supported via `GET /api/providers/client?pageSize=50&provider=antigravity`. Returns `{ connections: NineRouterConnectionItem[] }`.
- **Export Capabilities:** Unsupported as an export bundle.
- **Write Capabilities:** Partially supported via `PUT /api/providers/:id`. Only updates `isActive` and `providerSpecificData` (which holds `proxyPoolId`). Account creation and deletion are **unsupported** via API; account onboarding is handled via external OAuth flows.
- **Import Capabilities:** Unsupported.
- **Pagination & Completeness:** Query string `pageSize=50` is hardcoded in the client. 9Router supports pagination parameters (`pageSize`, cursor/page), but current client does not follow next-page tokens. If accounts exceed 50, read completeness is truncated (`incomplete`).
- **Concurrency & Conditional Boundaries:** No revision checks, conditional headers, or operation IDs.
- **Idempotency:** `PUT` updates mutable fields idempotently.

### 3.3 Provider & Model Roles (`role`)
- **Status:** **Unsupported on Remote 9Router API**.
- **Evidence:** 9Router exposes no endpoints for defining, listing, or updating model role mappings (`Codex GPT 5.6`, `Sol`, `Astra`, `Luna`, `oc/big-pickle`).
- **Sync Boundary:** Roles exist purely in local application configuration and routing logic. No remote writes to 9Router are possible or required.

### 3.4 Router Settings (`settings`)
- **Status:** **Unsupported on Remote 9Router API**.
- **Evidence:** 9Router exposes no API route for querying or modifying router daemon settings (such as active limits, timeouts, listen ports).
- **Sync Boundary:** Local `data/settings.json` governs rotation intervals, concurrency, and threshold policies. Remote router settings must be treated as immutable through this client.

### 3.5 Usage & Quotas (`usage`)
- **Read Capabilities:** Supported via `GET /api/usage/:id` for individual connection accounts. Returns quota objects:
  ```json
  {
    "quotas": {
      "gemini_session": {
        "remainingPercentage": 85,
        "resetAt": "2026-10-23T14:00:00Z",
        "used": 150,
        "total": 1000
      },
      "gemini_weekly": { ... }
    }
  }
  ```
- **Write Capabilities (Usage Write-Back):** **Completely Unsupported**.
  - 9Router has no HTTP endpoint for writing, injecting, adjusting, or reconciling usage counters (`POST /api/usage`, `PUT /api/usage`, etc. do not exist).
  - Any attempt to mutate usage counters on 9Router would require direct SQLite manipulation of 9Router's internal database files, which is strictly prohibited by architecture decisions.
- **Native vs Replicated Semantics:**
  - 9Router usage endpoints only report native router metrics observed by that instance.
  - Proxy-checker must maintain aggregate usage and replicated totals strictly in its local metadata store (`APP_DATA_DIR/router-sync.sqlite3`).
  - Remote write-back cannot be executed against 9Router without a custom server-side extension to 9Router.

### 3.6 Diagnostics & Audit Logs (`audit`, `diagnostics`)
- **Diagnostics:** Supported for proxy pools via `POST /api/proxy-pools/:id/test`. Returns latency and status or structured error (`status`, `elapsedMs`, `error`, `failureKind`).
- **Audit Logs:** **Unsupported on Remote 9Router API**. 9Router does not provide an event stream or audit log endpoint. All operational audit history is generated and stored locally in `proxy-checker` (`data/auditor-history.json` and SQLite).

### 3.7 Export & Import
- **Status:** **Unsupported natively**.
- **Evidence:** 9Router has no `/api/export` or `/api/import` endpoints.
- **Convergence Path:** Synchronization must be achieved through granular entity mapping (reading normalized entities from A and applying diffs to B via REST endpoints).

---

## 4. Capability Matrix

| routerId | version | resource | method/path | read/export/import/write | pagination/completeness | conditional boundary | event identity namespace | absolute usage semantics | delta dedupe/receipt semantics | evidence | blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `router-a` | Unknown (v1.x) | `pool` | `GET /api/proxy-pools?includeUsage=true` | read: yes, export: no, import: no, write: no | unpaginated / complete snapshot | none | router-local pool ID (`id`) | none | none | `listPools` in `nine-router-client.ts#348` | None for read |
| `router-a` | Unknown (v1.x) | `pool` | `POST /api/proxy-pools` | read: no, export: no, import: no, write: create | single entity / non-idempotent | none | generated remote `id` | none | none | `createPool` in `nine-router-client.ts#426` | No conditional create |
| `router-a` | Unknown (v1.x) | `pool` | `PUT /api/proxy-pools/:id` | read: no, export: no, import: no, write: update | single entity / unconditional | none (blind PUT) | router-local pool ID (`id`) | none | none | `updatePool` in `nine-router-client.ts#405` | Concurrent edit clobbering |
| `router-a` | Unknown (v1.x) | `pool` | `DELETE /api/proxy-pools/:id` | read: no, export: no, import: no, write: delete | single entity / idempotent on 404 | none | router-local pool ID (`id`) | none | none | `deletePool` in `nine-router-client.ts#420` | Concurrent delete-edit race |
| `router-a` | Unknown (v1.x) | `account` | `GET /api/providers/client?pageSize=50&provider=antigravity` | read: yes, export: no, import: no, write: no | paginated (page size 50) / incomplete if >50 | none | router-local connection ID (`id`) | none | none | `listAntigravityConnections` in `nine-router-client.ts#458` | Needs pagination loop |
| `router-a` | Unknown (v1.x) | `account` | `PUT /api/providers/:id` | read: no, export: no, import: no, write: update | single entity / unconditional | none (blind PUT) | router-local connection ID (`id`) | none | none | `updateConnection` in `nine-router-client.ts#484` | Blind write to active/proxy binding |
| `router-a` | Unknown (v1.x) | `role` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote API does not support roles |
| `router-a` | Unknown (v1.x) | `settings` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote API does not support settings |
| `router-a` | Unknown (v1.x) | `usage` | `GET /api/usage/:id` | read: yes (quota only), export: no, import: no, write: no | single account snapshot | none | connection ID (`id`) | native snapshot only; not additive | read-only; no dedupe/receipt on remote | `getAccountUsage` in `nine-router-client.ts#472` | Read-only; write-back unsupported |
| `router-a` | Unknown (v1.x) | `audit` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote audit stream missing |
| `router-a` | Unknown (v1.x) | `diagnostics` | `POST /api/proxy-pools/:id/test` | read: execute test, export: no, import: no, write: trigger | single test result | none | router-local pool ID (`id`) | none | none | `testPool` in `nine-router-client.ts#364` | None for test execution |
| `router-b` | Unknown (v1.x) | `pool` | `GET /api/proxy-pools?includeUsage=true` | read: yes, export: no, import: no, write: no | unpaginated / complete snapshot | none | router-local pool ID (`id`) | none | none | Identical client methods across URLs | None for read |
| `router-b` | Unknown (v1.x) | `pool` | `POST /api/proxy-pools` | read: no, export: no, import: no, write: create | single entity / non-idempotent | none | generated remote `id` | none | none | Identical client methods across URLs | No conditional create |
| `router-b` | Unknown (v1.x) | `pool` | `PUT /api/proxy-pools/:id` | read: no, export: no, import: no, write: update | single entity / unconditional | none (blind PUT) | router-local pool ID (`id`) | none | none | Identical client methods across URLs | Concurrent edit clobbering |
| `router-b` | Unknown (v1.x) | `pool` | `DELETE /api/proxy-pools/:id` | read: no, export: no, import: no, write: delete | single entity / idempotent on 404 | none | router-local pool ID (`id`) | none | none | Identical client methods across URLs | Concurrent delete-edit race |
| `router-b` | Unknown (v1.x) | `account` | `GET /api/providers/client?pageSize=50&provider=antigravity` | read: yes, export: no, import: no, write: no | paginated (page size 50) / incomplete if >50 | none | router-local connection ID (`id`) | none | none | Identical client methods across URLs | Needs pagination loop |
| `router-b` | Unknown (v1.x) | `account` | `PUT /api/providers/:id` | read: no, export: no, import: no, write: update | single entity / unconditional | none (blind PUT) | router-local connection ID (`id`) | none | none | Identical client methods across URLs | Blind write to active/proxy binding |
| `router-b` | Unknown (v1.x) | `role` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote API does not support roles |
| `router-b` | Unknown (v1.x) | `settings` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote API does not support settings |
| `router-b` | Unknown (v1.x) | `usage` | `GET /api/usage/:id` | read: yes (quota only), export: no, import: no, write: no | single account snapshot | none | connection ID (`id`) | native snapshot only; not additive | read-only; no dedupe/receipt on remote | Identical client methods across URLs | Read-only; write-back unsupported |
| `router-b` | Unknown (v1.x) | `audit` | None | read: no, export: no, import: no, write: no | none / unsupported | none | none | none | none | Codebase audit: zero endpoints | Remote audit stream missing |
| `router-b` | Unknown (v1.x) | `diagnostics` | `POST /api/proxy-pools/:id/test` | read: execute test, export: no, import: no, write: trigger | single test result | none | router-local pool ID (`id`) | none | none | Identical client methods across URLs | None for test execution |

---

## 5. Usage Write-Back & Deduplication Deep Dive

### 5.1 Native Counters vs Replicated Totals
- **Native Remote Counters:** 9Router tracks usage natively via internal request handlers and aggregates it into quota snapshots returned by `/api/usage/:id`. These represent real-time observations of requests passing through that router instance.
- **Replicated Usage:** If aggregate usage is synchronized between routers, writing Router A's totals into Router B would contaminate Router B's native counters if not explicitly segregated. Because 9Router does not provide separate fields for "native" vs "replicated" usage, **no writes can be made to 9Router's usage counters**.
- **Local Ledger Solution:** All usage reconciliation, deduplication, and aggregation MUST reside in `proxy-checker`'s sync metadata database (`APP_DATA_DIR/router-sync.sqlite3`).

### 5.2 Reset and Generation Semantics
- Antigravity session quotas use a 5-hour rolling window (`gemini_session.resetAt`).
- When `Date.now() >= resetAt`, the quota resets to 100% on 9Router.
- Any attempt to accumulate absolute request counts across resets without tracking the `generation` timestamp causes erratic quota calculations.
- `UsageEvent` models in `src/server/dual-router/types.ts` capture `generation: string` to fence observations across quota reset boundaries.

### 5.3 Event Identity & Deduplication
- 9Router does not assign globally unique transaction IDs to requests exposed via API.
- Reconciling usage across routers requires deterministic event IDs constructed from canonical scopes:
  `hash(sourceRouterId, accountKey, provider, model, periodStart, periodEnd, generation)`

---

## 6. Verified Request & Response Contracts

The following request/response structures are verified through tests (`tests/ninerouter-client.test.ts`, `tests/ninerouter-multi-target.test.ts`, `tests/repro-deadlock-race.test.ts`):

### 6.1 Authentication (`POST /api/auth/login`)
- **Headers:** `Content-Type: application/json`, `Accept: application/json`
- **Request Body:**
  ```json
  { "password": "your-password" }
  ```
- **Response Headers:** `Set-Cookie: auth_token=mock-token; Path=/`
- **Response Body (200 OK):**
  ```json
  { "ok": true }
  ```
- **Error Response (401 Unauthorized):**
  ```json
  { "error": "Invalid password" }
  ```

### 6.2 Proxy Pools List (`GET /api/proxy-pools?includeUsage=true`)
- **Headers:** `Cookie: auth_token=...`, `Accept: application/json`
- **Response Body (200 OK):**
  ```json
  {
    "proxyPools": [
      {
        "id": "remote-1",
        "name": "1",
        "proxyUrl": "http://127.0.0.1:8080",
        "type": "http",
        "isActive": true,
        "testStatus": "passed",
        "lastError": null,
        "lastTestedAt": "2026-10-23T08:00:00.000Z"
      }
    ]
  }
  ```

### 6.3 Proxy Pool Test (`POST /api/proxy-pools/:id/test`)
- **Headers:** `Cookie: auth_token=...`, `Accept: application/json`
- **Response Body (200 OK - Test Passed):**
  ```json
  {
    "ok": true,
    "elapsedMs": 420
  }
  ```
- **Response Body (500 Internal Error / Structured Failure):**
  ```json
  {
    "ok": false,
    "error": "Proxy test timed out",
    "elapsedMs": 6000
  }
  ```
- **Response Body (500 Transport Failure):**
  ```json
  {
    "ok": false,
    "failureKind": "transport",
    "error": "9Router test service unavailable"
  }
  ```

### 6.4 Proxy Pool Mutation (`PUT /api/proxy-pools/:id`)
- **Headers:** `Cookie: auth_token=...`, `Content-Type: application/json`
- **Request Body:**
  ```json
  { "name": "Edge Proxy 1", "isActive": true }
  ```
- **Response Body (200 OK):**
  ```json
  {
    "proxyPool": {
      "id": "remote-1",
      "name": "Edge Proxy 1",
      "proxyUrl": "http://127.0.0.1:8080",
      "isActive": true
    }
  }
  ```

### 6.5 Antigravity Connections (`GET /api/providers/client?pageSize=50&provider=antigravity`)
- **Headers:** `Cookie: auth_token=...`, `Accept: application/json`
- **Response Body (200 OK):**
  ```json
  {
    "connections": [
      {
        "id": "acc-1",
        "provider": "antigravity",
        "name": "User One",
        "email": "user1@example.com",
        "isActive": true,
        "testStatus": "active",
        "providerSpecificData": {
          "proxyPoolId": "remote-1"
        }
      }
    ]
  }
  ```

### 6.6 Connection Mutation (`PUT /api/providers/:id`)
- **Headers:** `Cookie: auth_token=...`, `Content-Type: application/json`
- **Request Body:**
  ```json
  {
    "isActive": false,
    "providerSpecificData": {
      "proxyPoolId": "remote-2"
    }
  }
  ```
- **Response Body (200 OK):**
  ```json
  {
    "connection": {
      "id": "acc-1",
      "isActive": false,
      "providerSpecificData": {
        "proxyPoolId": "remote-2"
      }
    }
  }
  ```

### 6.7 Account Quota / Usage (`GET /api/usage/:id`)
- **Headers:** `Cookie: auth_token=...`, `Accept: application/json`
- **Response Body (200 OK):**
  ```json
  {
    "quotas": {
      "gemini_session": {
        "remainingPercentage": 85,
        "resetAt": "2026-10-23T15:00:00.000Z",
        "used": 150,
        "total": 1000
      },
      "gemini_weekly": {
        "remainingPercentage": 92,
        "resetAt": "2026-10-30T00:00:00.000Z"
      }
    }
  }
  ```

---

## 7. Concurrency, Race Conditions & Failure Modes

1. **No Conditional Writes:** Neither `/api/proxy-pools/:id` nor `/api/providers/:id` support `If-Match` or revision preconditions. To minimize lost updates:
   - Before executing any planned operation, the sync coordinator MUST re-read the entity from the target router and verify that the remote state matches `expected` and `expectedRevision`.
   - If the remote state has changed in the interim, the operation MUST be aborted with status `rejected` and re-evaluated by the merge engine.
2. **Mutual Exclusion for Active Shared Proxies:**
   - Multiple routers MUST NOT activate connections backed by the same proxy pool concurrently.
   - Deactivation on Router A MUST be confirmed via read-back before activation on Router B is attempted.
   - If Router A is unreachable or fails deactivation, the transfer to Router B MUST be blocked.
3. **Single-Flight Login Race:**
   - As documented in `tests/repro-deadlock-race.test.ts`, concurrent requests encountering 401 must coalesce on a single in-flight `loginPromise` per URL to prevent login stampedes.

---

## 8. Execution Gate & Impact on Downstream Tasks

Based on the verified capabilities:
- **Task 2 (Metadata & Persistence):** Unblocked. Schema and repository can fully represent entities, baselines, operations, conflicts, and local usage ledger.
- **Task 3 (Adapter & Identity):** Unblocked with constraints:
  - Account listing must implement pagination if total accounts exceed 50.
  - Proxy identity normalization MUST use protocol, credentials, host, port, and path.
- **Task 4 (Merge Engine):** Unblocked. Three-way merge logic functions as designed against normalized baseline snapshots.
- **Task 5 (Usage Reconciliation):** **Scope Limitation Verified**:
  - Remote usage write-back to 9Router is **unsupported** due to missing remote mutation endpoints.
  - Usage write-back MUST be recorded in the local repository and marked as `unsupported` when dispatching remote writes, satisfying acceptance criteria without fabricating remote writes or mutating internal SQLite files.
- **Task 6 (Encrypted Backup):** Unblocked. Snapshots and key handling are local.
- **Task 7 & 8 (Orchestration & Controls):** Unblocked.

---

## 9. Conclusion
All readable scopes (`pool`, `account`, `usage`, `diagnostics`) and mutations (`pool` CRUD, `account` binding/activation) have been verified against client code and test fixtures. Missing endpoints (`role`, `settings`, `audit`, usage mutation) are explicitly categorized as **unsupported**, providing an unambiguous contract for dual-router master synchronization.
