# Unified Proxies Donut Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `/proxies` and `/intelligence` into a single DonutBrowser-style proxy management and inspection workspace with 3-tier status classification (`working`, `regressed`, `dead`).

**Architecture:** Route `/proxies` becomes the sole proxy workspace. Route `/intelligence` redirects to `/proxies`, and sidebar navigation is simplified to a single "Proxies" entry. The backend SQLite database (`proxies` and `proxy_audits`) computes operational status via SQL, exposes a unified API (`/api/proxies/unified`, `/api/proxies/check`, `/api/proxies/:key/history`), and the UI provides a 7-column DonutBrowser table with a slide-over Connection Test drawer.

**Tech Stack:** Next.js 16 (Turbopack), React 19, TypeScript 5, Node 22 `node:sqlite` (DatabaseSync), Tailwind CSS, shadcn/ui (Sheet, Badge, Button, Input, Table).

**Spec:** `docs/superpowers/specs/2026-10-02-unified-proxies-donut-workspace-design.md`

## Global Constraints

- Storage source of truth: `data/proxies.sqlite3` using Node 22 built-in `node:sqlite`.
- No new NPM packages; use installed libraries.
- Strict 3-tier status definitions: `working` (usable/PASS), `regressed` (dead now, but successes > 0 or has PASS audit), `dead` (dead and never succeeded).
- In-flight abort handling: always guard fetch promises with `isAbortError`.

---

### Task 1: Backend Data Model & 3-Tier Status Calculation in Repository

**Files:**
- Modify: `src/server/proxy-intelligence-repository.ts`
- Test: `tests/proxy-unified-status.test.ts`

**Interfaces:**
- Produces: `getUnifiedProxies(filter?: { status?: string; search?: string; protocol?: string; page?: number; pageSize?: number }): Promise<{ total: number; counts: { all: number; working: number; regressed: number; dead: number }; items: UnifiedProxyItem[] }>`
- Type `UnifiedProxyItem`:
  ```ts
  export interface UnifiedProxyItem {
    key: string;
    name: string;
    protocol: "http" | "https" | "socks4" | "socks5";
    host: string;
    port: number;
    status: "working" | "dead" | "regressed";
    udp: "Yes" | "No" | "Unknown";
    sync: "active" | "reserve" | "unsynced";
    latencyMs: number | null;
    exitIp: string | null;
    geo?: { city?: string; country?: string };
    isp?: string;
    timezone?: string;
    lastCheckedAt: number | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/proxy-unified-status.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("computes working, dead, and regressed proxy statuses accurately", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-status-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    // 1. Insert 3 test proxies
    // Proxy 1: Usable -> working
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["p1", "10.0.0.1:8080", "http", "10.0.0.1", 8080, "usable", "1.1.1.1", 120, 5, 0, "test", "working"]
    );

    // Proxy 2: Dead with 0 successes, 0 audit passes -> dead
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["p2", "10.0.0.2:8080", "socks5", "10.0.0.2", 8080, "dead", null, null, 0, 3, "test", "dead"]
    );

    // Proxy 3: Dead with past successes > 0 -> regressed
    db.run(
      `INSERT INTO proxies (proxy_key, endpoint, protocol, host, port, status, exit_ip, latency_ms, successes, failures, source, lifecycle_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["p3", "10.0.0.3:1080", "socks5", "10.0.0.3", 1080, "dead", null, null, 2, 1, "test", "dead"]
    );

    // 2. Fetch unified proxies
    const resAll = await repo.getUnifiedProxies({ status: "all" });
    assert.equal(resAll.total, 3);
    assert.equal(resAll.counts.working, 1);
    assert.equal(resAll.counts.dead, 1);
    assert.equal(resAll.counts.regressed, 1);

    const item1 = resAll.items.find((p) => p.key === "p1");
    assert.equal(item1?.status, "working");

    const item2 = resAll.items.find((p) => p.key === "p2");
    assert.equal(item2?.status, "dead");

    const item3 = resAll.items.find((p) => p.key === "p3");
    assert.equal(item3?.status, "regressed");

    // 3. Filter by regressed
    const resRegressed = await repo.getUnifiedProxies({ status: "regressed" });
    assert.equal(resRegressed.items.length, 1);
    assert.equal(resRegressed.items[0].key, "p3");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/proxy-unified-status.test.ts`
Expected: FAIL (`repo.getUnifiedProxies is not a function`).

- [ ] **Step 3: Implement `getUnifiedProxies` in repository**

In `src/server/proxy-intelligence-repository.ts`:
Add `UnifiedProxyItem` and `UnifiedProxyCounts` interfaces and implement `getUnifiedProxies`:
```ts
export interface UnifiedProxyItem {
  key: string;
  name: string;
  protocol: "http" | "https" | "socks4" | "socks5";
  host: string;
  port: number;
  status: "working" | "dead" | "regressed";
  udp: "Yes" | "No" | "Unknown";
  sync: "active" | "reserve" | "unsynced";
  latencyMs: number | null;
  exitIp: string | null;
  geo?: { city?: string; country?: string };
  isp?: string;
  timezone?: string;
  lastCheckedAt: number | null;
}

export interface UnifiedProxyCounts {
  all: number;
  working: number;
  regressed: number;
  dead: number;
}
```
Compute `computed_status` using SQL `CASE WHEN p.status = 'usable' THEN 'working' WHEN (p.successes > 0 OR audit_pass_count > 0) THEN 'regressed' ELSE 'dead' END`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/proxy-unified-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/proxy-unified-status.test.ts src/server/proxy-intelligence-repository.ts
git commit -m "feat(intelligence): add 3-tier status calculation and getUnifiedProxies"
```

---

### Task 2: Backend Unified Endpoints in `server.ts`

**Files:**
- Modify: `src/server/server.ts`
- Test: `tests/proxy-unified-api.test.ts`

**Interfaces:**
- Consumes: `repo.getUnifiedProxies`, `probeProxyConnectivity` (auditor probe)
- Exposes:
  - `GET /api/proxies/unified`
  - `POST /api/proxies/check`
  - `GET /api/proxies/:key/history`

- [ ] **Step 1: Write the failing test**

Create `tests/proxy-unified-api.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("GET /api/proxies/unified returns status counts and items", async () => {
  // Test will verify that server handles GET /api/proxies/unified correctly
  const req = http.request("http://127.0.0.1:1300/api/proxies/unified", {
    method: "GET",
    headers: {
      Authorization: `Basic ${Buffer.from("admin:minh2908").toString("base64")}`,
    },
  });
  // Verify status code 200 and schema
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/proxy-unified-api.test.ts`
Expected: FAIL (404 Not Found).

- [ ] **Step 3: Implement endpoint handlers in `src/server/server.ts`**

Add handlers for `/api/proxies/unified`, `/api/proxies/check`, and `/api/proxies/history`.
Map active/reserve status from `poolRanker.listByTier("all")`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/proxy-unified-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/proxy-unified-api.test.ts src/server/server.ts
git commit -m "feat(api): add unified proxy endpoints in server"
```

---

### Task 3: Client API & Types in `src/lib/`

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces:
  - `fetchUnifiedProxies(password: string, query?: ...): Promise<{ total: number; counts: UnifiedProxyCounts; items: UnifiedProxyItem[] }>`
  - `checkProxyValidity(password: string, proxyKey: string): Promise<UnifiedProxyItem>`
  - `fetchProxyHistory(password: string, proxyKey: string): Promise<{ history: UnifiedProxyHistoryEntry[] }>`

- [ ] **Step 1: Update `src/lib/types.ts`**

Export `UnifiedProxyItem`, `UnifiedProxyCounts`, and `UnifiedProxyHistoryEntry`.

- [ ] **Step 2: Add functions in `src/lib/api.ts`**

Implement `fetchUnifiedProxies`, `checkProxyValidity`, and `fetchProxyHistory` with `isAbortError` handling.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(client): add unified proxy types and API helpers"
```

---

### Task 4: DonutBrowser Detail Drawer Component

**Files:**
- Create: `src/components/proxy-detail-drawer.tsx`

**Interfaces:**
- Consumes: `UnifiedProxyItem`, `fetchProxyHistory`, `checkProxyValidity`
- Props:
  ```ts
  interface ProxyDetailDrawerProps {
    proxy: UnifiedProxyItem | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onProxyUpdated?: (updated: UnifiedProxyItem) => void;
  }
  ```

- [ ] **Step 1: Create `src/components/proxy-detail-drawer.tsx`**

Implement Sheet drawer with:
1. Title: "Connection test" + host:port + protocol badge.
2. Verified exit box: IP address, City/Country, last check status.
3. 4-box metrics grid:
   - `UDP`: "Yes" (green) / "No" (muted)
   - `ISP`: string
   - `Timezone`: string
   - `Took`: latency in ms
4. Button: `Check proxy validity` (shows spinner during probe).
5. "Recent checks" section: list of recent runs with status badge, exit IP, ISP, UDP, Took, and time ago.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/proxy-detail-drawer.tsx
git commit -m "feat(ui): add DonutBrowser-style proxy detail drawer"
```

---

### Task 5: DonutBrowser Main Page (`src/app/(dashboard)/proxies/page.tsx`)

**Files:**
- Modify: `src/app/(dashboard)/proxies/page.tsx`

**Interfaces:**
- Consumes: `fetchUnifiedProxies`, `checkProxyValidity`, `syncPools`, `ProxyDetailDrawer`

- [ ] **Step 1: Rewrite `src/app/(dashboard)/proxies/page.tsx`**

1. **Header**:
   - `Proxies (total)`
   - Subtitle: `Manage proxy fleet, test connectivity, and sync with 9Router.`
   - Actions: `Sync 9Router`, `Import`, `Export`, `+ New proxy`.
2. **Filter Pills**:
   - `All (counts.all)`
   - `Working (counts.working)` (emerald)
   - `Regressed (counts.regressed)` (amber)
   - `Dead (counts.dead)` (rose)
   - Search input.
3. **Table (7 Columns)**:
   - Name
   - Protocol
   - Host : port (with copy button)
   - UDP (Yes / No)
   - Status (Working / Regressed / Dead)
   - Sync (Active / Reserve / —)
   - Actions (Check validity icon, Detail drawer icon, delete)
4. Integration with `ProxyDetailDrawer`.

- [ ] **Step 2: Run typecheck and lint**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/(dashboard)/proxies/page.tsx
git commit -m "feat(ui): rewrite /proxies with DonutBrowser table and status pills"
```

---

### Task 6: Navigation Consolidation & Redirect

**Files:**
- Modify: `src/components/app-sidebar.tsx`
- Modify: `src/app/(dashboard)/intelligence/page.tsx`

- [ ] **Step 1: Update `src/components/app-sidebar.tsx`**

Remove `/intelligence` from `NAV_MAIN`. Only keep `Overview`, `Proxies`, and `Help Center`.

- [ ] **Step 2: Update `src/app/(dashboard)/intelligence/page.tsx`**

Add client-side redirect (`router.replace("/proxies")`) to seamlessly forward any legacy bookmarked visits.

- [ ] **Step 3: Run full test suite and production build**

Run: `npm test && npm run build`
Expected: All tests pass, build completes with 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/app-sidebar.tsx src/app/(dashboard)/intelligence/page.tsx
git commit -m "feat(nav): consolidate sidebar and redirect /intelligence to /proxies"
```

---

### Task 7: End-to-End Browser Smoke Test

**Files:**
- Test: Throwaway script or interactive browser session

- [ ] **Step 1: Launch application server**

Run: `node scripts/dev-stop.mjs && npm run start`

- [ ] **Step 2: Browser verification**

1. Visit `http://localhost:1300/proxies` after login.
2. Verify Quick Filter Pills show correct counts (`All`, `Working`, `Regressed`, `Dead`).
3. Click `Regressed` pill: verify table shows only regressed proxies.
4. Click `Check` icon on a proxy: observe latency and status updating.
5. Click `Detail` icon: verify DonutBrowser slide-over drawer opens showing Verified exit, UDP, ISP, Timezone, Took, and Recent checks history.
6. Visit `http://localhost:1300/intelligence`: verify automatic redirect to `/proxies`.

- [ ] **Step 3: Final commit and clean-up**

```bash
git status
```
Confirm working tree clean.
