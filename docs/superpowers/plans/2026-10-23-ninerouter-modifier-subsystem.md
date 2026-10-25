# 9Router Modifier Subsystem Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây dựng hệ thống trang và sidebar riêng cho 9Router Modifier: trang Dashboard hiển thị 2 mini usage dashboard và 2 live SSE console log terminals của 2 node 9Router, cùng trang Proxies & Bindings 2 cột đồng bộ Antigravity connections và Proxy pools.

**Architecture:** Sử dụng kiến trúc BFF (Backend For Frontend) qua Hono router nội bộ (`/api/ninerouter/nodes/:nodeId/*`). Backend xử lý session auth cookie với từng node 9Router, proxy REST metrics và SSE stream. Frontend xây dựng bằng Next.js App Router, shadcn UI, Tailwind CSS và Framer Motion.

**Tech Stack:** Next.js (App Router), React 19, TypeScript, Hono, Tailwind CSS, shadcn/ui, Lucide Icons, EventSource (SSE).

**Spec:** `docs/superpowers/specs/2026-10-23-ninerouter-modifier-subsystem.md`

## Global Constraints
- Node 1 LAN endpoint: `http://192.168.1.54:20128` (username `minhmice`, password `minh2908`)
- Node 2 VPN endpoint: `http://100.73.175.42:20128` (username `netnut`, password `netnut2026@`)
- Dashboard password lấy từ `settings.json` (`nineRouterPassword`)
- Toàn bộ component UI tuân thủ quy chuẩn shadcn hiện có của repo
- Console log stream kết nối qua SSE `GET /api/translator/console-logs/stream`
- Console log hiển thị giữ tối đa 1,000 dòng để chống tràn RAM trình duyệt

---

### Task 1: Backend BFF Endpoints & Multi-Node Session Proxy

**Files:**
- Modify: `src/server/nine-router-client.ts`
- Modify: `src/server/api/routes/ninerouter.ts`
- Create: `src/server/ninerouter-node-proxy.ts`
- Test: `tests/ninerouter-node-proxy.test.ts`

**Interfaces:**
- Produces:
  - `getNodeInventory(): Array<{ id: string; name: string; url: string; host: string }>`
  - `getNodeStats(nodeId: string, period?: string): Promise<Record<string, unknown>>`
  - `proxyNodeLogsStream(nodeId: string, onData: (chunk: string) => void): () => void`
  - `getNodeProxyPools(nodeId: string): Promise<NineRouterPool[]>`
  - `testNodeProxyPool(nodeId: string, poolId: string): Promise<NineRouterTestResult>`
  - `toggleNodeProxyPool(nodeId: string, poolId: string, isActive: boolean): Promise<unknown>`
  - `getNodeConnections(nodeId: string): Promise<NineRouterConnectionItem[]>`
  - `bindConnectionPool(nodeId: string, connectionId: string, poolId: string | null): Promise<unknown>`

- [ ] **Step 1: Viết test failing cho Node Proxy client**

Tạo `tests/ninerouter-node-proxy.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { getNodeInventory, resolveNodeUrl } from "../src/server/ninerouter-node-proxy.js";

test("getNodeInventory returns both LAN and VPN nodes", () => {
  const nodes = getNodeInventory();
  assert.equal(nodes.length >= 2, true);
  const lan = nodes.find((n) => n.id === "server-lan");
  const vpn = nodes.find((n) => n.id === "server-vpn");
  assert.ok(lan, "Master Node LAN must exist");
  assert.ok(vpn, "Tailscale Node VPN must exist");
  assert.equal(lan.url.includes("192.168.1.54"), true);
  assert.equal(vpn.url.includes("100.73.175.42"), true);
});

test("resolveNodeUrl resolves correct base url", () => {
  const urlLan = resolveNodeUrl("server-lan");
  assert.equal(urlLan, "http://192.168.1.54:20128");
  const urlVpn = resolveNodeUrl("server-vpn");
  assert.equal(urlVpn, "http://100.73.175.42:20128");
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node --import tsx --test tests/ninerouter-node-proxy.test.ts`  
Expected: FAIL ("Cannot find module '../src/server/ninerouter-node-proxy.js'")

- [ ] **Step 3: Triển khai `src/server/ninerouter-node-proxy.ts` và tích hợp vào `src/server/api/routes/ninerouter.ts`**

Tạo file `src/server/ninerouter-node-proxy.ts`:
- Quản lý cookie cache theo `nodeId`.
- Tự động login nếu cookie hết hạn hoặc chưa có.
- Mount các route Hono trong `src/server/api/routes/ninerouter.ts`:
  - `GET /api/ninerouter/nodes`
  - `GET /api/ninerouter/nodes/:nodeId/stats`
  - `GET /api/ninerouter/nodes/:nodeId/logs/stream`
  - `GET /api/ninerouter/nodes/:nodeId/proxy-pools`
  - `POST /api/ninerouter/nodes/:nodeId/proxy-pools/:id/test`
  - `PUT /api/ninerouter/nodes/:nodeId/proxy-pools/:id`
  - `GET /api/ninerouter/nodes/:nodeId/connections`
  - `PUT /api/ninerouter/nodes/:nodeId/connections/:id/bind-pool`

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `node --import tsx --test tests/ninerouter-node-proxy.test.ts`  
Expected: PASS

- [ ] **Step 5: Typecheck & Commit**

Run: `npm run typecheck`  
Commit: `feat(ninerouter): implement multi-node backend proxy and endpoints`

---

### Task 2: Sidebar Navigation Update (`AppSidebar`)

**Files:**
- Modify: `src/components/app-sidebar.tsx`
- Test: `tests/app-sidebar-nav.test.ts`

**Interfaces:**
- Produces: Nhóm navigation `9ROUTER MODIFIER` với 2 route `/ninerouter/dashboard` và `/ninerouter/proxies`.

- [ ] **Step 1: Viết test failing kiểm tra menu navigation**

Tạo `tests/app-sidebar-nav.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("AppSidebar includes 9Router Modifier navigation group", () => {
  const content = fs.readFileSync("src/components/app-sidebar.tsx", "utf8");
  assert.ok(content.includes("/ninerouter/dashboard"), "Must contain /ninerouter/dashboard link");
  assert.ok(content.includes("/ninerouter/proxies"), "Must contain /ninerouter/proxies link");
  assert.ok(content.includes("9ROUTER MODIFIER") || content.includes("9Router Modifier"), "Must contain section label");
});
```

- [ ] **Step 2: Chạy test xác nhận fail**

Run: `node --import tsx --test tests/app-sidebar-nav.test.ts`  
Expected: FAIL

- [ ] **Step 3: Cập nhật `src/components/app-sidebar.tsx`**

Thêm hằng số `NAV_NINEROUTER` và render SidebarGroup riêng biệt cho 9Router Modifier với icon tương ứng (`LayoutDashboard` / `BarChart3` và `Shuffle` / `Globe`).

- [ ] **Step 4: Chạy lại test xác nhận pass**

Run: `node --import tsx --test tests/app-sidebar-nav.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

Commit: `feat(ui): add 9router modifier navigation group to app sidebar`

---

### Task 3: 9Router Live Console Log Terminal Component

**Files:**
- Create: `src/components/ninerouter/live-console-terminal.tsx`
- Test: `tests/live-console-terminal.test.ts`

**Interfaces:**
- Produces: Component `LiveConsoleTerminal` nhận `nodeId`, `nodeName`, `nodeUrl` và render streaming console output với auto-scroll, clear, pause, search filter.

- [ ] **Step 1: Viết test failing cho terminal log parser & buffer**

Tạo `tests/live-console-terminal.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";

test("Terminal buffer caps at max 1000 lines", () => {
  const lines: string[] = [];
  for (let i = 0; i < 1200; i++) {
    lines.push(`Line ${i}`);
    if (lines.length > 1000) lines.shift();
  }
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], "Line 200");
  assert.equal(lines[999], "Line 1199");
});
```

- [ ] **Step 2: Chạy test xác nhận logic buffer**

Run: `node --import tsx --test tests/live-console-terminal.test.ts`  
Expected: PASS

- [ ] **Step 3: Triển khai `src/components/ninerouter/live-console-terminal.tsx`**

Tính năng:
- Mở `EventSource` tới `/api/ninerouter/nodes/${nodeId}/logs/stream`.
- Xử lý các event `init` (mảng logs ban đầu), `line`, `lines`, `clear`.
- Khung UI terminal đen mờ chuẩn xterm/cyberpunk (`bg-zinc-950/90 text-zinc-100 font-mono text-xs`).
- Parse màu sắc ANSI / highlight trạng thái `DONE`, `POST`, `ERROR`, `STREAM`.
- Toolbar trên đầu terminal: Tên Node, Connection Status (Live SSE pulse), nút `Clear`, nút `Pause/Resume`, nút `Auto-scroll: ON/OFF`, ô input tìm kiếm log.

- [ ] **Step 4: Typecheck & Lint**

Run: `npm run typecheck`  
Commit: `feat(ninerouter): implement live console terminal component with sse streaming`

---

### Task 4: 9Router Mini Usage Dashboard Card Component

**Files:**
- Create: `src/components/ninerouter/mini-usage-card.tsx`
- Test: `tests/mini-usage-card.test.ts`

**Interfaces:**
- Produces: Component `MiniUsageCard` hiển thị 5 chỉ số KPI tối giản (Total Requests, Input Tokens, Cached Tokens, Output Tokens, Est. Cost) cùng model breakdown list của một node.

- [ ] **Step 1: Viết test failing cho helper tính toán và format tokens**

Tạo `tests/mini-usage-card.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(2)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
}

test("formatTokens formats values correctly", () => {
  assert.equal(formatTokens(98227261), "98.2M");
  assert.equal(formatTokens(64552877), "64.6M");
  assert.equal(formatTokens(389387), "389.4K");
  assert.equal(formatTokens(1259), "1.3K");
});
```

- [ ] **Step 2: Chạy test xác nhận pass**

Run: `node --import tsx --test tests/mini-usage-card.test.ts`  
Expected: PASS

- [ ] **Step 3: Triển khai `src/components/ninerouter/mini-usage-card.tsx`**

Xây dựng component với phong cách impeccable:
- 5 KPI tiles gọn gàng, sắc nét với background subtle glow tương tự ảnh gốc 9router:
  - Total Requests
  - Input Tokens (coral/red accent)
  - Cached Tokens (sky/blue accent)
  - Output Tokens (emerald/green accent)
  - Est. Cost (gold/yellow accent)
- Bảng con hoặc danh sách thu gọn: Recent Models / Accounts (Gemini 3.8 Flash High, GPT 6.1 Sol...) với số lượng in/out tokens.

- [ ] **Step 4: Typecheck & Commit**

Run: `npm run typecheck`  
Commit: `feat(ninerouter): implement mini usage card component`

---

### Task 5: 9Router Dashboard Page (`/ninerouter/dashboard`)

**Files:**
- Create: `src/app/(dashboard)/ninerouter/dashboard/page.tsx`
- Test: `tests/ninerouter-dashboard-page.test.ts`

**Interfaces:**
- Produces: Trang `/ninerouter/dashboard` ghép 2 MiniUsageCard phía trên và 2 LiveConsoleTerminal phía dưới theo bố cục 2 cột side-by-side.

- [ ] **Step 1: Viết test contract cho page component**

Tạo `tests/ninerouter-dashboard-page.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Dashboard page file exists and imports components", () => {
  const content = fs.readFileSync("src/app/(dashboard)/ninerouter/dashboard/page.tsx", "utf8");
  assert.ok(content.includes("MiniUsageCard"), "Must render MiniUsageCard");
  assert.ok(content.includes("LiveConsoleTerminal"), "Must render LiveConsoleTerminal");
  assert.ok(content.includes("server-lan"), "Must configure server-lan");
  assert.ok(content.includes("server-vpn"), "Must configure server-vpn");
});
```

- [ ] **Step 2: Triển khai `src/app/(dashboard)/ninerouter/dashboard/page.tsx`**

Cấu trúc:
- Header: Tiêu đề `9Router Dual-Node Dashboard`, filter thời gian (`Today`, `24h`, `7d`, `30d`), nút Sync/Refresh.
- Top Row (Grid 2 cột):
  - Cột 1: `MiniUsageCard` cho Node LAN (`192.168.1.54:20128`).
  - Cột 2: `MiniUsageCard` cho Node VPN (`100.73.175.42:20128`).
- Bottom Row (Grid 2 cột):
  - Cột 1: `LiveConsoleTerminal` cho Node LAN.
  - Cột 2: `LiveConsoleTerminal` cho Node VPN.

- [ ] **Step 3: Chạy test xác nhận pass**

Run: `node --import tsx --test tests/ninerouter-dashboard-page.test.ts`  
Expected: PASS

- [ ] **Step 4: Commit**

Commit: `feat(ninerouter): assemble dual-node usage and live console dashboard page`

---

### Task 6: 9Router Proxies & Bindings Page (`/ninerouter/proxies`)

**Files:**
- Create: `src/components/ninerouter/account-bindings-table.tsx`
- Create: `src/components/ninerouter/proxy-pools-table.tsx`
- Create: `src/app/(dashboard)/ninerouter/proxies/page.tsx`
- Test: `tests/ninerouter-proxies-page.test.ts`

**Interfaces:**
- Produces: Trang `/ninerouter/proxies` side-by-side:
  - Cột trái: Quản lý gán Antigravity Accounts và xem proxy pool đang bind.
  - Cột phải: Quản lý Proxy Pools (bật/tắt, test ping latency, sửa, xóa, batch import, nút gán trực tiếp).

- [ ] **Step 1: Viết test contract cho proxies page**

Tạo `tests/ninerouter-proxies-page.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Proxies page integrates both bindings and pools tables", () => {
  const content = fs.readFileSync("src/app/(dashboard)/ninerouter/proxies/page.tsx", "utf8");
  assert.ok(content.includes("AccountBindingsTable"), "Must contain bindings table");
  assert.ok(content.includes("ProxyPoolsTable"), "Must contain proxy pools table");
});
```

- [ ] **Step 2: Triển khai `AccountBindingsTable` và `ProxyPoolsTable`**

- `AccountBindingsTable`:
  - Fetch `/api/ninerouter/nodes/:nodeId/connections`.
  - Hiển thị danh sách email account, switch On/Off, badge `Proxy #X`.
  - Chọn account để highlight và sẵn sàng nhận proxy gán từ cột phải.
- `ProxyPoolsTable`:
  - Fetch `/api/ninerouter/nodes/:nodeId/proxy-pools`.
  - Hiển thị ID rank, URL, toggle On/Off, nút test latency, gán nhanh vào account đang chọn.
  - Hỗ trợ đổi node LAN / VPN qua Node Selector ở header.

- [ ] **Step 3: Lắp ráp vào `src/app/(dashboard)/ninerouter/proxies/page.tsx`**

- [ ] **Step 4: Chạy test xác nhận pass**

Run: `node --import tsx --test tests/ninerouter-proxies-page.test.ts`  
Expected: PASS

- [ ] **Step 5: Typecheck & Commit**

Run: `npm run typecheck`  
Commit: `feat(ninerouter): implement side-by-side account bindings and proxy pools page`

---

### Task 7: Full System Verification, Smoke Proof & Polish

**Files:**
- Test: Chạy toàn bộ test suites (`npm run test:fleet`, `npm run typecheck`, `npm run lint`)
- Verify: Smoke test API endpoints thực tế tới `192.168.1.54:20128`

- [ ] **Step 1: Chạy typecheck và linter**

Run: `npm run typecheck && npm run lint`  
Expected: 0 errors

- [ ] **Step 2: Chạy unit/integration tests liên quan**

Run: `node --import tsx --test tests/ninerouter-*.test.ts`  
Expected: All tests pass

- [ ] **Step 3: Smoke test API endpoints thực tế**

Gửi request curl thử nghiệm kiểm tra `/api/ninerouter/nodes`, stats và proxy-pools để đảm bảo BFF hoạt động trơn tru.

- [ ] **Step 4: Final commit**

Commit: `feat(ninerouter): complete 9router modifier subsystem implementation`
