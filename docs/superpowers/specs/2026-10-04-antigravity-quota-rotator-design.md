# Design Document: Antigravity Quota Rotator & Sidebar Drop-up Widget

**Date:** 2026-10-04  
**Status:** Approved in Brainstorming, Pending Spec Review  
**Target Surface:** 9Router Integration, Backend Daemon, Sidebar UI, Settings  

---

## 1. Overview & Objectives

### 1.1 Goal
Provide an automated daemon inside `minhmiceProxy` that tracks 9Router Antigravity account quotas, automatically rotates accounts when quota falls below threshold, ensures proxies are safely multiplexed without concurrent conflicts, and presents aggregate quota and active account details in a compact sidebar drop-up widget.

### 1.2 Key Requirements
1. **Quota Monitoring:** Poll 9Router `/api/providers/client` and `/api/usage/{id}` to track `gemini_session` (5-hour window) and `gemini_weekly` quotas.
2. **Automatic Rotation:**
   - Turn OFF accounts whose `gemini_session` remaining percentage is $\le 20\%$ or encountering HTTP 429/errors.
   - Turn ON candidate accounts whose `gemini_session` remaining is $> 20\%$, prioritizing accounts with the lowest/earliest `resetAt` timestamp.
   - Enforce an active concurrency limit (default 3 active accounts, configurable).
3. **Proxy Assignment & Conflict Prevention:**
   - Each Antigravity account is assigned a proxy (`proxyPoolId`).
   - If an account already has an assigned proxy, preserve it unless that proxy is marked dead in `minhmiceProxy`.
   - If an account's assigned proxy is dead or missing, replace it with a healthy proxy from the top active pool.
   - Strict Constraint 1: One proxy can be assigned to at most 2 accounts total.
   - Strict Constraint 2: Two accounts sharing the same proxy must NEVER be active simultaneously.
4. **Background Daemon:** Runs every $M$ minutes (default 10 minutes, configurable via Settings).
5. **Sidebar UI Drop-up Widget:**
   - Placed at the bottom of the left sidebar (`SidebarFooter`), right above the "Sign out" item.
   - Collapsed state: Displays total aggregate quota percentage across all Antigravity accounts (e.g., 8 accounts = `645% / 800%`) with a compact progress bar.
   - Hover / Focus state: Drops up a panel showing the active accounts (e.g. 3 active), exact Session % and Weekly %, assigned proxy badge with health indicator, reset countdown timer, and a "Refresh All" button.
6. **Settings Page:** Configurable options under `/settings` for enable/disable toggle, active limit, rotation interval, and threshold.

---

## 2. Architecture & Data Flow

```
+-------------------------------------------------------------+
|                minhmiceProxy Server (Node.js)              |
|                                                             |
|  +-------------------------------------------------------+  |
|  |           Antigravity Rotator Daemon                 |  |
|  |             (antigravity-rotator.ts)                  |  |
|  |                                                       |  |
|  |  Timer (default 10m) / POST /api/antigravity/refresh   |  |
|  |                          |                            |  |
|  |   1. Query Connections   v                            |  |
|  |   2. Fetch Quotas -------------------------------->   |  |
|  |   3. Read Usable Proxies (from poolRanker)            |  |
|  |   4. Algorithm: Demote <= 20%, Promote > 20%          |  |
|  |      (lowest resetAt, enforce <= 2 per proxy,        |  |
|  |       no concurrent proxy collision)                  |  |
|  |   5. Update Connections on 9Router                    |  |
|  |   6. Save Snapshot to data/antigravity-rotator.json   |  |
|  +-------------------------------------------------------+  |
|                             |                               |
|                             v                               |
|              GET /api/antigravity/status                    |
+-------------------------------------------------------------+
                              |
                              v
+-------------------------------------------------------------+
|                     Next.js Frontend                        |
|                                                             |
|  - SidebarFooter: AntigravityQuotaWidget (Drop-up)          |
|    * Collapsed: Aggregate % (e.g. 645% / 800%)              |
|    * Hover Popover: Active 3 accounts + Quota + Proxies     |
|      + Reset Timers + "Refresh All" button                  |
|  - /settings: Rotator Configuration Cards                   |
+-------------------------------------------------------------+
```

---

## 3. Detailed Component Specifications

### 3.1 9Router Client Extensions (`src/server/nine-router-client.ts`)
Reuses the existing authenticated `request<T>()` helper with automatic cookie session management:
- `listAntigravityConnections()`:
  - Calls `GET /api/providers/client?pageSize=50&provider=antigravity`
  - Returns array of Antigravity connection records (`id`, `name`, `email`, `isActive`, `testStatus`, `providerSpecificData`).
- `getAccountUsage(connectionId: string)`:
  - Calls `GET /api/usage/${encodeURIComponent(connectionId)}`
  - Extracts `quotas.gemini_session` (`remainingPercentage`, `resetAt`, `used`, `total`) and `quotas.gemini_weekly`.
- `updateConnection(connectionId: string, patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown> })`:
  - Calls `PUT /api/providers/${encodeURIComponent(connectionId)}` with JSON body `{ isActive, providerSpecificData }`.

### 3.2 Configuration & Types (`src/server/app-config.ts` & `src/lib/types.ts`)
Add persistent settings fields:
- `antigravityRotatorEnabled`: boolean (default `true`)
- `antigravityActiveLimit`: number (default `3`, clamped 1..10)
- `antigravityRotateMinutes`: number (default `10`, clamped 1..60)
- `antigravitySessionThreshold`: number (default `20`, clamped 5..50)

Expose through `AppSettings`, `AppSettingsPublic`, `SettingsUpdatePatch`, and emit change events via `onSettingsChange`.

### 3.3 Core Engine (`src/server/antigravity-rotator.ts`)
- **State Persistence:** `data/antigravity-rotator.json` containing:
  ```ts
  interface AntigravityAccountState {
    id: string;
    email: string;
    name: string;
    isActive: boolean;
    sessionPercentage: number;
    weeklyPercentage: number;
    resetAt: string | null;
    proxyPoolId: string | null;
    proxyName?: string | null;
    proxyHealthy: boolean;
    lastError?: string | null;
    lastCheckedAt: number;
  }
  interface AntigravityRotatorSnapshot {
    lastRunAt: number | null;
    running: boolean;
    totalAccounts: number;
    activeCount: number;
    totalSessionQuotaPercentage: number; // e.g. 645 (% sum)
    maxPossiblePercentage: number;       // e.g. 800 (% max)
    accounts: AntigravityAccountState[];
  }
  ```
- **Rotation & Proxy Resolution Algorithm:**
  1. Fetch all Antigravity connections and their current usage.
  2. Inspect available usable proxies from `poolRanker.readState().pools` (where `status === "usable"` and `remoteId` exists).
  3. **Proxy Validation & Reassignment:**
     - For each account, inspect `providerSpecificData.proxyPoolId`.
     - If missing or dead (not in usable pools), select a usable proxy that currently has $< 2$ accounts assigned.
     - Update assignment map and queue connection patch if proxy changed.
  4. **Account State Evaluation:**
     - Compute `sessionPercentage` from `gemini_session.remainingPercentage`.
     - If account is currently `isActive = true`:
       - If `sessionPercentage <= threshold` or `testStatus === "unavailable"`, mark for deactivation (`isActive = false`).
       - Otherwise, keep active candidate.
  5. **Promotion & Collision Avoidance:**
     - Determine number of active slots available: `availableSlots = activeLimit - survivingActiveCount`.
     - Filter inactive candidate accounts: `sessionPercentage > threshold` and no active errors.
     - Sort candidates by `resetAt` ascending (earliest reset window prioritized).
     - Iterate through sorted candidates:
       - If candidate's `proxyPoolId` is already used by an active account, SKIP to next candidate (enforce no concurrent proxy collision).
       - If valid, mark for activation (`isActive = true`) and record its proxy as actively occupied.
       - Decrement `availableSlots` until 0 or candidates exhausted.
  6. **Batch Update on 9Router:**
     - Apply required `PUT /api/providers/{id}` requests for changed accounts.
     - Record activity log via `logActivity("info", "Antigravity Rotator: ...")`.
     - Write updated snapshot to `data/antigravity-rotator.json`.

### 3.4 Backend HTTP Routes (`src/server/server.ts`)
- `GET /api/antigravity/status`:
  - Returns current snapshot from `antigravityRotator.getSnapshot()`.
- `POST /api/antigravity/refresh`:
  - Triggers immediate cycle `antigravityRotator.runRotation({ force: true })`.
  - Returns updated snapshot or 202 accepted.
- **Timer Hook:** Hooked into server startup with interval management and `onSettingsChange` listener.

### 3.5 UI Specification

#### 3.5.1 Left Sidebar Footer Widget (`src/components/antigravity-quota-widget.tsx`)
- Placed in `AppSidebar` within `SidebarFooter`, above `Sign out`.
- **Collapsed View:**
  - Icon: `Gauge` or `Cpu`.
  - Label: "Antigravity Quota".
  - Metrics: `${Math.round(totalQuota)}% / ${totalAccounts * 100}%` (e.g. `645% / 800%`).
  - Bar: Slim, rounded progress bar reflecting `totalQuota / (totalAccounts * 100)`.
- **Drop-up Popover (Triggered on hover / focus):**
  - Positions upward (`side="top"`, `align="start"`).
  - Header:
    - Title: "Active Accounts (${activeCount} / ${totalAccounts})".
    - Action: Compact icon button for "Refresh All" (`RotateCw`) with spinning state while fetching.
  - Active Accounts List (top 3 active):
    - Email / Account Name.
    - Badges: `Session: ${sessionPercentage.toFixed(0)}%` (colored emerald > 50%, amber 21-50%, rose <= 20%), `Weekly: ${weeklyPercentage.toFixed(0)}%`.
    - Proxy Info: Assigned proxy name/ID with green indicator dot.
    - Countdown: Reset time formatted as `Reset in Xh Ym`.
  - Footer caption: "Rotates when Session <= 20% | Prioritizes lowest reset window".

#### 3.5.2 Settings Page Integration (`src/app/(dashboard)/settings/page.tsx`)
- Add form card "Antigravity Account Rotator":
  - Switch: Enable / Disable.
  - Input: Concurrent Active Accounts (1–10).
  - Input: Check Interval in Minutes (1–60).
  - Input: Session Quota Min Threshold % (5–50%).
  - Save button with feedback toast.

---

## 4. Edge Cases & Safeguards

1. **All accounts fall below threshold ($\le 20\%$):**
   - The daemon keeps the best available accounts with highest remaining quota active or notifies via activity log, preventing complete outage of the service if configured.
2. **Proxy pool shortage:**
   - If usable proxy pool has fewer than $\lceil \text{accounts} / 2 \rceil$ proxies, log warning and assign available proxies up to the 2-account cap.
3. **9Router temporary 401 or network glitch:**
   - Existing `request()` handles re-login. If unrecoverable, rotator logs warning without altering existing states.
4. **Concurrent manual toggle on 9Router:**
   - Next 10-minute cycle reads ground truth from 9Router before computing transitions.

---

## 5. Testing & Verification

1. **Unit / Contract Tests:**
   - `tests/antigravity-rotator.test.ts`:
     - Test quota threshold evaluation.
     - Test sorting by earliest `resetAt`.
     - Test proxy conflict invariant: no 2 active accounts share the same `proxyPoolId`.
     - Test proxy cap invariant: no proxy assigned to $> 2$ accounts.
2. **API Verification:**
   - Smoke test `GET /api/antigravity/status` and `POST /api/antigravity/refresh`.
3. **UI Verification:**
   - Inspect sidebar footer widget in browser.
   - Verify hover drop-up opens upward cleanly, displays correct active account details, and Refresh button triggers update.
