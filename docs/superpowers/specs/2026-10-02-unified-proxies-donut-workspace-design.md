# Unified Proxies Donut Workspace Design

**Date**: 2026-10-02  
**Status**: Draft (Approved in Brainstorming)  
**Target Route**: `/proxies` (consolidating `/proxies` and `/intelligence`)

---

## 1. Objectives & Scope

### 1.1 Problem Statement
The dashboard currently divides proxy tracking across two separate screens:
- `/proxies`: 9Router pool ranking and fleet synchronization.
- `/intelligence`: SQLite proxy inventory, security audit jobs, and detailed diagnostics.

This causes fragmentation. Users only need to know:
1. Which proxies are **currently working** (`working`).
2. Which proxies are **dead** (`dead`).
3. Which proxies **previously worked or passed audit, but are currently dead** (`regressed` / Zombie).
4. Essential operational proxy information matching **DonutBrowser**'s clean layout (protocol, host:port, UDP capability, sync status, exit IP, geo/ISP, latency, and test history).

### 1.2 Non-Goals
- Keeping two separate pages with redundant data.
- Over-complicating the table with deep cryptographic fingerprints (SPKI, TLS cipher suites, raw SSL certificates) in the primary view. Those are secondary audit internals and will remain encapsulated in the detail drawer if needed.

---

## 2. Architecture & System Design

```
+-------------------------------------------------------------+
|                      Unified UI: /proxies                   |
|  - Quick Filter Pills: All | Working | Regressed | Dead     |
|  - DonutBrowser Table: Name, Protocol, Host:port, UDP, ...  |
|  - DonutBrowser Connection Test Drawer (Geo, ISP, History)  |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|                     HTTP / Next.js Server                   |
|  - GET /api/proxies/unified (paginated, filtered, stats)    |
|  - POST /api/proxies/check (on-demand DonutBrowser probe)   |
|  - POST /api/proxies/sync (sync pools with 9Router)         |
|  - GET /api/proxies/:key/history (last 10 check runs)       |
|  - Redirect /intelligence -> /proxies                       |
+------------------------------+------------------------------+
                               |
                               v
+-------------------------------------------------------------+
|              SQLite (data/proxies.sqlite3)                  |
|  - proxies table (inventory, credentials, status, host, ...) |
|  - proxy_audits table (immutable audit historical runs)     |
|  - proxy_diagnostics table (fast probe historical runs)     |
+-------------------------------------------------------------+
```

### 2.1 Navigation & Route Consolidation
- **Sidebar**: Remove `/intelligence` item. The `Workspace` group retains:
  - `Overview` (`/`)
  - `Proxies` (`/proxies`)
  - `Help Center` (`/help`)
- **Redirect**: Any request to `/intelligence` redirects (`307` / client redirect) directly to `/proxies`.

---

## 3. Data Model & 3-Tier Status Calculation

### 3.1 Status State Machine
A proxy in `proxies.sqlite3` resolves into exactly one of three operational states:

1. **`working`**:
   - **Condition**: `status = 'usable'` OR the latest audit/diagnostic check succeeded (`verdict = 'PASS'` or exit IP reachable).
   - **Badge**: Emerald green (`Working`).

2. **`dead`**:
   - **Condition**: Currently unreachable (`status = 'dead'`) AND has never succeeded in the past (`successes = 0` AND no historical audit with `verdict = 'PASS'`).
   - **Badge**: Rose red (`Dead`).

3. **`regressed`** (Formerly usable, now dead):
   - **Condition**: Currently unreachable (`status = 'dead'`) BUT has a history of working (`successes > 0` OR at least 1 record in `proxy_audits` where `verdict = 'PASS'`).
   - **Badge**: Amber/Orange (`Regressed`).

### 3.2 SQL Computation
```sql
SELECT 
  p.proxy_key,
  p.endpoint,
  p.protocol,
  p.host,
  p.port,
  p.status,
  p.exit_ip,
  p.latency_ms,
  p.checked_at,
  p.successes,
  p.failures,
  p.source,
  p.lifecycle_state,
  (
    SELECT COUNT(*) 
    FROM proxy_audits a 
    WHERE a.proxy_key = p.proxy_key AND a.verdict = 'PASS'
  ) AS audit_pass_count,
  CASE
    WHEN p.status = 'usable' THEN 'working'
    WHEN (p.successes > 0 OR (SELECT COUNT(*) FROM proxy_audits a WHERE a.proxy_key = p.proxy_key AND a.verdict = 'PASS') > 0) THEN 'regressed'
    ELSE 'dead'
  END AS computed_status
FROM proxies p;
```

---

## 4. API Interface Specifications

### 4.1 `GET /api/proxies/unified`
- **Query Params**:
  - `status`: `"all"` | `"working"` | `"regressed"` | `"dead"`
  - `search`: string (matches endpoint, host, IP, or ISP)
  - `protocol`: `"all"` | `"http"` | `"socks5"`
  - `page`: number (default 1)
  - `pageSize`: number (default 50)
- **Response**:
```json
{
  "total": 100,
  "counts": {
    "all": 100,
    "working": 79,
    "regressed": 12,
    "dead": 9
  },
  "items": [
    {
      "key": "socks5://100.71.252.27:10001",
      "name": "100.71.252.27:10001",
      "protocol": "socks5",
      "host": "100.71.252.27",
      "port": 10001,
      "status": "working",
      "udp": "Yes",
      "sync": "active",
      "latencyMs": 1467,
      "exitIp": "101.36.104.46",
      "geo": { "city": "Hanoi", "country": "Vietnam" },
      "isp": "Viettel Group",
      "timezone": "Asia/Bangkok",
      "lastCheckedAt": 1727823518000
    }
  ]
}
```

### 4.2 `POST /api/proxies/check`
- **Body**: `{ "proxyKey": "socks5://100.71.252.27:10001" }`
- **Action**: Runs on-demand connectivity test, verifies UDP support, resolves exit IP and Geo/ISP, persists result into `proxy_diagnostics` and updates `proxies` status.
- **Response**: The updated `UnifiedProxyItem`.

### 4.3 `GET /api/proxies/:key/history`
- **Action**: Returns the last 10 audit/diagnostic check results for this proxy.
- **Response**:
```json
{
  "history": [
    {
      "id": "diag_123",
      "status": "passed",
      "exitIp": "117.5.147.3",
      "isp": "Viettel Group",
      "udp": "Yes",
      "latencyMs": 2391,
      "timestamp": 1727715518000
    }
  ]
}
```

---

## 5. UI Layout & Component Architecture

### 5.1 Main Table Page (`src/app/(dashboard)/proxies/page.tsx`)
1. **Header**:
   - Title: `Proxies` with total badge count.
   - Action buttons:
     - `Sync 9Router`: Synchronize local pool with remote 9Router.
     - `Import`: Dropdown / button to import `.txt` proxies.
     - `Export`: Download working proxies as `.txt`.
     - `+ New proxy`: Quick add single proxy modal.
2. **Status Pills Bar**:
   - `All (100)`
   - `Working (79)` (Emerald green chip)
   - `Regressed (12)` (Amber warning chip - "Từng chạy được nhưng giờ dead")
   - `Dead (9)` (Rose red chip)
   - Search input (host, port, IP, ISP)
3. **Table Columns (DonutBrowser Layout)**:
   - `Name`: Custom tag or host:port.
   - `Protocol`: Badge `socks5` | `http`.
   - `Host : port`: Endpoint string with quick copy.
   - `UDP`: Badge `Yes` | `No`.
   - `Status`: Badge `Working` | `Regressed` | `Dead`.
   - `Sync`: `Active` (green) | `Reserve` (slate) | `—` (none).
   - `Actions`:
     - `Check`: Quick play icon button to trigger probe.
     - `Detail`: Drawer opener icon.
     - `More`: Rename and Delete options.

### 5.2 DonutBrowser Detail Drawer (`src/components/proxy-detail-drawer.tsx`)
- Slide-over sheet from the right matching DonutBrowser's Connection Test layout:
  - **Header**: `Connection test` — Endpoint title with protocol badge.
  - **Verified exit**: Exit IP (`117.5.147.3`) + Location badge (`Hanoi, Vietnam`).
  - **Last check status banner**: `Last check succeeded` or `Last check failed` with timestamp.
  - **Four-Metric Grid**:
    - `UDP`: `Yes` / `No`
    - `ISP`: Provider name (e.g. `Viettel Group`)
    - `Timezone`: Detected timezone (e.g. `Asia/Bangkok`)
    - `Took`: Latency in milliseconds (e.g. `2391 ms`)
  - **Button**: `Check proxy validity` to re-test on the spot.
  - **Recent checks section**: Chronological cards/list of past tests showing status, exit IP, ISP, UDP support, latency, and relative timestamp (e.g. `1 day ago`).

---

## 6. Implementation & Verification Plan

1. **Backend & DB Layer**:
   - Implement `getUnifiedProxies` in repository with 3-tier status calculation.
   - Add `/api/proxies/unified`, `/api/proxies/check`, and `/api/proxies/history` handlers in `server.ts`.
   - Add unit test verifying status calculation for `working`, `dead`, and `regressed`.
2. **UI & Navigation Layer**:
   - Rewrite `src/app/(dashboard)/proxies/page.tsx` with DonutBrowser table and status pills.
   - Implement `ProxyDetailDrawer` matching DonutBrowser inspector.
   - Update `app-sidebar.tsx` removing `Proxy Intelligence` item.
   - Redirect `src/app/(dashboard)/intelligence/page.tsx` to `/proxies`.
3. **Quality & Verification**:
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - Browser smoke test verifying UI rendering, filter pills, check action, and drawer history.
