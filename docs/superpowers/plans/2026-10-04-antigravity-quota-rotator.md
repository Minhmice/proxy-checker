# Antigravity Quota Rotator & Sidebar Drop-up Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically monitor 9Router Antigravity account quotas, rotate accounts below 20% session quota, assign and multiplex proxies safely (max 2 accounts per proxy, no concurrent active collision), and display aggregate quota and active accounts in a left sidebar footer drop-up widget.

**Architecture:** An embedded Node.js background rotator daemon (`antigravity-rotator.ts`) polls 9Router connection and usage endpoints every 10 minutes, applies rotation and proxy conflict rules using usable proxies from `poolRanker`, persists snapshots to `data/antigravity-rotator.json`, exposes REST endpoints in `server.ts`, and renders an interactive drop-up widget in `SidebarFooter`.

**Tech Stack:** TypeScript, Node.js HTTP server, Next.js 16 (App Router), React 19, Tailwind CSS v4, Lucide React, Node.js native test runner (`node --test`).

**Spec:** `docs/superpowers/specs/2026-10-04-antigravity-quota-rotator-design.md`

## Global Constraints

- Reuses existing `request<T>()` from `nine-router-client.ts` for authenticated 9Router calls.
- Reuses existing `poolRanker.readState().pools` to identify usable proxies and their remote IDs.
- Quota threshold rule: Turn off when `gemini_session` remaining percentage $\le 20\%$ or encountering 429/errors.
- Candidate promotion rule: Turn on accounts $> 20\%$ prioritizing the lowest `resetAt`.
- Max 2 accounts assigned per proxy; zero concurrent active accounts sharing the same proxy.
- Sidebar placement: Inside `SidebarFooter` in `src/components/app-sidebar.tsx`, positioned right above the "Sign out" button.
- UI styling must follow shadcn conventions and dark/light design tokens in `globals.css`.

---

### Task 1: 9Router Client Extensions & Configuration Types

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/server/app-config.ts`
- Modify: `src/server/nine-router-client.ts`
- Test: `tests/antigravity-config-client.test.ts`

**Interfaces:**
- Produces:
  - `AppSettings.antigravityRotatorEnabled`: boolean
  - `AppSettings.antigravityActiveLimit`: number
  - `AppSettings.antigravityRotateMinutes`: number
  - `AppSettings.antigravitySessionThreshold`: number
  - `listAntigravityConnections(overrides?)`: Promise<NineRouterConnection[]>
  - `getAccountUsage(id, overrides?)`: Promise<NineRouterAccountUsage>
  - `updateConnection(id, patch, overrides?)`: Promise<{ connection: unknown }>

- [ ] **Step 1: Write failing test for config and client helpers**

```ts
// tests/antigravity-config-client.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { initAppConfig, getSettingsPublic, getSettingsSecrets } from "../src/server/app-config.js";

test("app-config includes Antigravity rotator settings with sensible defaults", () => {
  initAppConfig();
  const pub = getSettingsPublic();
  assert.equal(typeof pub.antigravityRotatorEnabled, "boolean");
  assert.equal(pub.antigravityActiveLimit, 3);
  assert.equal(pub.antigravityRotateMinutes, 10);
  assert.equal(pub.antigravitySessionThreshold, 20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/antigravity-config-client.test.ts`  
Expected: FAIL with missing properties on `AppSettingsPublic`.

- [ ] **Step 3: Implement config keys and 9Router client extensions**

Add types in `src/lib/types.ts`:
```ts
export interface AntigravityAccountState {
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

export interface AntigravityRotatorSnapshot {
  lastRunAt: number | null;
  running: boolean;
  totalAccounts: number;
  activeCount: number;
  totalSessionQuotaPercentage: number;
  maxPossiblePercentage: number;
  accounts: AntigravityAccountState[];
}
```

Add config fields in `src/server/app-config.ts` (with defaults and validation).  
Add client functions in `src/server/nine-router-client.ts`:
```ts
export async function listAntigravityConnections() {
  const body = await request<{ connections?: unknown[] }>("/api/providers/client?pageSize=50&provider=antigravity");
  return body.connections ?? [];
}
export async function getAccountUsage(id: string) {
  return await request<Record<string, unknown>>(`/api/usage/${encodeURIComponent(id)}`);
}
export async function updateConnection(id: string, patch: { isActive?: boolean; providerSpecificData?: Record<string, unknown> }) {
  return await request<{ connection: unknown }>(`/api/providers/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/antigravity-config-client.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/server/app-config.ts src/server/nine-router-client.ts tests/antigravity-config-client.test.ts
git commit -m "feat(rotator): add antigravity rotator config keys and 9router client helpers"
```

---

### Task 2: Core Antigravity Rotation Engine & Decision Rules

**Files:**
- Create: `src/server/antigravity-rotator.ts`
- Test: `tests/antigravity-rotator.test.ts`

**Interfaces:**
- Consumes:
  - `listAntigravityConnections`, `getAccountUsage`, `updateConnection` from `src/server/nine-router-client.ts`
  - `getSettingsSecrets` from `src/server/app-config.ts`
  - `poolRanker.readState()` for usable proxies
- Produces:
  - `createAntigravityRotator(deps)`: `{ runRotation, getSnapshot, isRunning }`
  - Exported pure decision function: `computeRotationPlan(accounts, usableProxies, options)`

- [ ] **Step 1: Write failing test for rotation decisions and proxy constraints**

```ts
// tests/antigravity-rotator.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { computeRotationPlan } from "../src/server/antigravity-rotator.js";

test("demotes accounts <= 20% and promotes candidates with lowest resetAt avoiding proxy collision", () => {
  const accounts = [
    { id: "acc1", email: "a@x.com", isActive: true, sessionRemaining: 15, resetAt: "2026-10-04T12:00:00Z", proxyPoolId: "px1" },
    { id: "acc2", email: "b@x.com", isActive: true, sessionRemaining: 80, resetAt: "2026-10-04T14:00:00Z", proxyPoolId: "px2" },
    { id: "acc3", email: "c@x.com", isActive: false, sessionRemaining: 90, resetAt: "2026-10-04T11:00:00Z", proxyPoolId: "px2" }, // shares px2 with acc2!
    { id: "acc4", email: "d@x.com", isActive: false, sessionRemaining: 85, resetAt: "2026-10-04T11:30:00Z", proxyPoolId: "px3" },
  ];
  const usableProxies = [{ remoteId: "px1" }, { remoteId: "px2" }, { remoteId: "px3" }];

  const plan = computeRotationPlan(accounts, usableProxies, {
    activeLimit: 2,
    sessionThreshold: 20
  });

  // acc1 must be deactivated (<= 20)
  assert.equal(plan.deactivations.includes("acc1"), true);
  // acc2 stays active (80% > 20)
  // acc3 has earliest resetAt (11:00), BUT shares px2 with acc2 which is already active! Must skip acc3 to prevent collision.
  // acc4 (resetAt 11:30, px3) should be activated instead.
  assert.equal(plan.activations.includes("acc4"), true);
  assert.equal(plan.activations.includes("acc3"), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/antigravity-rotator.test.ts`  
Expected: FAIL with `computeRotationPlan` not found.

- [ ] **Step 3: Implement `src/server/antigravity-rotator.ts`**

Implement:
1. `computeRotationPlan()` pure function:
   - Evaluates active accounts: demotes if `sessionRemaining <= threshold` or status error.
   - Enforces proxy mapping: ensures each account has a healthy `proxyPoolId` assigned (max 2 accounts assigned per proxy, auto-replaces dead proxies with least-assigned usable proxies).
   - Promotes inactive accounts with `sessionRemaining > threshold`, sorted ascending by `resetAt`.
   - Filters out candidates whose assigned `proxyPoolId` is already occupied by an active account in this cycle.
2. Snapshot persistence into `data/antigravity-rotator.json`.
3. `runRotation()` executing required `updateConnection()` calls.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/antigravity-rotator.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/antigravity-rotator.ts tests/antigravity-rotator.test.ts
git commit -m "feat(rotator): implement core antigravity rotation and proxy conflict engine"
```

---

### Task 3: Backend HTTP Routes & Scheduler

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/lib/api.ts`
- Test: `tests/antigravity-server-api.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/antigravity/status` -> `AntigravityRotatorSnapshot`
  - `POST /api/antigravity/refresh` -> `{ started: boolean, snapshot: AntigravityRotatorSnapshot }`
  - Client helper: `fetchAntigravityStatus(password?, signal?)`
  - Client helper: `refreshAntigravityQuota(password?)`

- [ ] **Step 1: Write failing test for HTTP routes**

```ts
// tests/antigravity-server-api.test.ts
import test from "node:test";
import assert from "node:assert/strict";

test("GET /api/antigravity/status returns snapshot structure", async () => {
  // Test endpoint handler with mock request/response
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/antigravity-server-api.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement server routes and scheduler in `src/server/server.ts`**

- Wire `antigravityRotator` into `server.ts`.
- Add route handler for `pathname.startsWith("/api/antigravity/")`.
- Add `scheduleAntigravityRotator()` timer (every `antigravityRotateMinutes`, default 10m).
- Wire `onSettingsChange` listener to reschedule when interval changes.
- Add client fetch helpers in `src/lib/api.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx --test tests/antigravity-server-api.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts src/lib/api.ts tests/antigravity-server-api.test.ts
git commit -m "feat(rotator): wire antigravity endpoints and periodic background scheduler"
```

---

### Task 4: Sidebar Footer Drop-up Widget (Impeccable Craft)

**Files:**
- Create: `src/components/antigravity-quota-widget.tsx`
- Modify: `src/components/app-sidebar.tsx`

**Interfaces:**
- Consumes:
  - `fetchAntigravityStatus`, `refreshAntigravityQuota` from `src/lib/api.ts`
  - `useAuth` from `src/components/auth-provider.tsx`
- Produces:
  - `<AntigravityQuotaWidget />` rendered inside `SidebarFooter` above `Sign out`.

- [ ] **Step 1: Write component contract test / smoke check**

Verify component renders without crashing when given mock snapshot data.

- [ ] **Step 2: Build `<AntigravityQuotaWidget />` with Impeccable craftsmanship**

Design details:
- **Collapsed Bar:**
  - Placed in `SidebarFooter`.
  - Icon: `Gauge` in emerald/accent tone.
  - Label: "Antigravity Quota".
  - Total Metric: e.g. `645% / 800%` in mono font.
  - Progress: Micro progress bar showing aggregate ratio.
- **Hover/Drop-up Popover:**
  - Pops upward (`bottom-full mb-2`, styled with subtle shadow, border, and dark backdrop-blur).
  - Header: "Active Accounts (3 / 8)" + "Refresh All" button (`RotateCw` icon with smooth spinning state on fetch).
  - Cards for 3 Active Accounts:
    - Email header.
    - Badges: `Session: X%` (emerald if >50%, amber 21-50%, rose <=20%), `Weekly: Y%`.
    - Proxy badge: Name + green ping dot.
    - Countdown: `Reset in Xh Ym` based on `resetAt`.
  - Footer note: "Auto-rotates when Session <= 20%".

- [ ] **Step 3: Integrate into `src/components/app-sidebar.tsx`**

Place `<AntigravityQuotaWidget />` right above the `SidebarMenuItem` containing `LogOut`.

- [ ] **Step 4: Run typecheck and linting**

Run: `npm run typecheck`  
Expected: PASS with 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/antigravity-quota-widget.tsx src/components/app-sidebar.tsx
git commit -m "feat(ui): add polished antigravity quota drop-up widget to sidebar footer"
```

---

### Task 5: Settings Form & End-to-End Verification

**Files:**
- Modify: `src/app/(dashboard)/settings/page.tsx`
- Test: Smoke verification with browser / live fetch

**Interfaces:**
- Consumes:
  - `antigravityRotatorEnabled`, `antigravityActiveLimit`, `antigravityRotateMinutes`, `antigravitySessionThreshold`

- [ ] **Step 1: Add Antigravity Rotator section to Settings page**

Add Card "Antigravity Account Rotator" inside `src/app/(dashboard)/settings/page.tsx`:
- Switch for `antigravityRotatorEnabled`
- Number input for `antigravityActiveLimit` (1–10)
- Number input for `antigravityRotateMinutes` (1–60)
- Number input for `antigravitySessionThreshold` (5–50%)
- Save handler updating settings.

- [ ] **Step 2: Run typecheck and all tests**

Run:
```bash
npm run typecheck
npm run test
```
Expected: PASS.

- [ ] **Step 3: Smoke test in browser**

Open minhmiceProxy web interface, inspect the sidebar footer drop-up widget, verify hover display of 3 active accounts, click "Refresh All", and verify real-time status update.

- [ ] **Step 4: Commit**

```bash
git add src/app/(dashboard)/settings/page.tsx
git commit -m "feat(settings): add antigravity rotator settings controls"
```
