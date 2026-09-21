# Task 2 Report: Proxies and Diagnostics Operator UI

## 1. TDD Provenance & Evidence

### Step 1: Restoration and RED Verification
- Restored `src/lib/api.ts` to `HEAD` with `git restore src/lib/api.ts`.
- Verified `tests/api-contract.test.ts` failed as expected:
  ```
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
    {
  +   file: {
  +     file: 'sample.txt',
  +     sampleCount: 25
  +   }
  -   file: 'sample.txt',
  -   sampleCount: 25
    }

  ✖ lifecycle helpers propagate the server error text (0.1856ms)
    TypeError: (0 , import_api.testPools) is not a function
  ```

### Step 2: Implementation and GREEN Verification
- Added 5 typed API client helpers in `src/lib/api.ts`:
  - `testPools(password, ids)`
  - `renamePool(password, localId, name)`
  - `removePool(password, localId)`
  - `restorePool(password, localId)`
  - `runDiagnostics(password, { file, samplePercent?, sampleCount? })`
- Re-ran focused test suite:
  ```
  > test
  > node --import tsx --test tests/**/*.test.ts tests/api-contract.test.ts

  ℹ tests 24
  ℹ suites 0
  ℹ pass 24
  ℹ fail 0
  ℹ duration_ms 224.889
  ```

## 2. Frontend Compiler & Next.js Build
- Ran `npm run build`:
  ```
  ▲ Next.js 16.2.12 (Turbopack)
  - Environments: .env

    Creating an optimized production build ...
  ✓ Compiled successfully in 1671ms
    Running TypeScript ...
    Finished TypeScript in 2.7s ...
    Collecting page data using 15 workers ...
  ✓ Generating static pages using 15 workers (14/14) in 456ms
    Finalizing page optimization ...

  Route (app)
  ├ ○ /
  ├ ○ /cdk
  ├ ○ /diagnostics
  ├ ○ /help
  ├ ○ /invoice
  ├ ○ /proxies
  ├ ○ /referral
  ├ ○ /reseller
  ├ ○ /scraping
  ├ ○ /settings
  └ ○ /wallet

  ○  (Static)  prerendered as static content
  ```

## 3. Browser Smoke & Visual Inspection
- Started local dev server on port 1300.
- Evaluated `/proxies` and `/diagnostics` via headless Chromium browser at:
  - Desktop viewport: 1280x800
  - Mobile viewport: 390x844
- Screenshots captured:
  - Desktop `/proxies`: `~/AppData/Local/Temp/omp-sshots-1588cbcfe8050c16.png`
  - Desktop `/proxies` (active dev server): `~/AppData/Local/Temp/omp-sshots-1588cc0daa850c17.png`
  - Mobile `/proxies`: `~/AppData/Local/Temp/omp-sshots-1588cc0e703f629d.png`
  - Desktop `/diagnostics`: `~/AppData/Local/Temp/omp-sshots-1588cc3541450c18.png`
  - Mobile `/diagnostics`: `~/AppData/Local/Temp/omp-sshots-1588cc35683f629e.png`
- Settled responsive validation:
  - Mobile sidebar rect settles off-screen correctly (`x=-294, right=-14`), verified not obstructing main content.
  - Reset mobile `.setup-toolbar-source` `flex-basis: auto` to eliminate 280px vertical empty space.
  - Increased `.btn-pill` `min-height: 44px` to meet 44px touch target requirement.

## 4. Scoped Re-Review Corrections

### 1. Immediate Non-Blocking Test Batch Return & Concurrency (Finding 2)
- `testPools` in `src/server/pool-ranker.ts` reserves IDs synchronously, marks them `queued`, detaches background worker execution without `await`, and immediately returns `{ accepted, busy }`.
- Background worker errors are caught and recorded via `logActivity`, with guaranteed release of `busyIds` in `finally`.
- Tested with deferred checker gate (`tests/pool-ranker-lifecycle.test.ts`):
  - Verified `testPools` returns `{ accepted: ["1"], busy: [] }` while the proxy check is still pending.
  - Verified concurrent call during pending check immediately receives `{ accepted: [], busy: ["1"] }`.
  - Verified observable completion reaches `idle` and `usable` upon releasing the gate.

### 2. Transport and HTTPS Probe Restoration (Findings N1, N2, N3)
- Restored `src/server/detailed-checker.ts` transport (`Reader`, `connect`, `openTunnel`, `requestThrough`) and probe logic (`testProxyDetailed`) verbatim from commit `bf77395`:
  - Full non-consuming header parsing with `until` and EOF/timeout handling.
  - Complete body collection (content-length and chunked transfer decoding).
  - Two-phase check: `ip-api.com` identity validation (IP check, status=success) followed by TLS tunneling to `httpbin.org` for HTTPS header leak inspection.
- Retained only the runner aggregate counters (`passedCount`, `failedCount`) and legacy migration logic.
- Verified with `tests/detailed-checker.test.ts` including >500 capped results assertion.

### 3. Rename 404 Reconcile by Normalized Endpoint (Finding 6)
- In `renamePool`, on upstream 404, list remote pools and check if the proxy reappeared with a new remote ID matching normalized endpoint:
  - If reappeared, attach new `remoteId`, set `linked`, and log activity.
  - If absent, transition to `removed`, clear `remoteId`, and log activity.
  - Always throw `PoolConflictError` (mapped to HTTP 409 by `server.ts`) and leave local name unmutated.

### 4. Diagnostics Route Scope Validation (Finding 10 & N6)
- In `src/server/server.ts`:
  - Validate non-empty string `file` matching an available file in input directory.
  - Validate scope values are finite numbers.
  - Honor `sampleCount` precedence when both `sampleCount` and `samplePercent` are provided (per spec).
  - Runner clamps values to valid bounds (1..100% / 1..eligible).

### 5. Audit Logging Trail (Finding 13)
- Emitted explicit activity log events for:
  - Accepted test batches (IDs and counts).
  - Transient retry successes.
  - Manual DELETE 404 idempotent completions.
  - Normalized endpoint reconciliation.

### 6. Failure Branch State Consistency (checked_at & latency_ms)
- In `executeSingleCheckAndLifecycle`, failure branch records `checked_at = result.checked_at || Date.now()`, `latency_ms = result.latency_ms`, and `exit_ip = result.exit_ip` so that dead/removed records reflect accurate check timestamps rather than 0/Never.

### 7. Full-Registry Polling & Newly Observed Removed Toast Detection (Finding 14)
- `proxies/page.tsx` polls with `fetchPools(password, "all")` so transitions from `linked` to `removed` are detected across all tabs regardless of whether Active or Reserve is currently viewed.
- Initial load establishes baseline without toast; subsequent polls toast when an existing linked record becomes removed or when a newly fetched pool is observed removed after the initial load.

## 5. Verification Commands and Results
- Focused test suite:
  ```
  node --import tsx --test tests/pool-ranker-lifecycle.test.ts tests/detailed-checker.test.ts tests/sync-lifecycle.test.ts tests/route-validation.test.ts tests/pool-ranker.test.ts tests/api-contract.test.ts
  ```
  Output: **27/27 pass** (0 fail, duration ~5.2s).
- Full test suite (`npm test`):
  Output: **31/31 pass** (0 fail).
- Production build (`npm run build`):
  Output: **Compiled successfully; 14/14 static pages generated**.
