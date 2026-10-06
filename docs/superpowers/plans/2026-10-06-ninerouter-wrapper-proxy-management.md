# 9Router Smart Wrapper & Proxy Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển đổi toàn bộ hệ thống từ việc tự chạy engine audit nội bộ sang một Smart Wrapper chuyên biệt điều khiển 9Router: dùng testPool định kỳ, xóa pool chết trên 9Router và lưu trong SQLite, hỗ trợ ghim bảo vệ (Pin/Protected), xóa vĩnh viễn (Hard delete), menu ngữ cảnh Shadcn ContextMenu, và chu kỳ đồng bộ gộp (Unified Maintenance Window) điều phối cùng Antigravity Rotator.

**Architecture:** Bỏ hoàn toàn subsystem Auditor (probes, scoring, ssrf, audit_jobs, Playwright tests). Giữ lại `playwright` package cho nhu cầu audit 9Router khi cần. Sử dụng SQLite `proxies` làm kho lưu trữ trung tâm mở rộng thêm các trường `is_pinned`, `tags`, `remote_id`, `router_state`, `removed_at`, `last_latency_ms`. Điều phối 9Router sync và Antigravity rotator thành 1 chu kỳ gộp duy nhất để không gây giật lag web 9Router, chỉ bù proxy cho tài khoản có proxy chết, kèm nút tối ưu theo tốc độ riêng biệt. Bảng danh sách proxy hỗ trợ menu chuột phải Shadcn ContextMenu đầy đủ chức năng.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node.js built-in SQLite (`node:sqlite`), Radix UI / Shadcn ContextMenu, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-10-06-ninerouter-wrapper-proxy-management-design.md`

## Global Constraints
- Node.js >= 22 (dùng `node:sqlite` experimental module, không thêm SQLite wrapper bên ngoài).
- Giữ nguyên `playwright` trong `package.json` devDependencies.
- Xóa sạch 100% mã nguồn trong `src/auditor/` và các bảng DB `proxy_audits`, `proxy_audit_risks`, `audit_jobs`, `proxy_diagnostics`.
- Rank rename trên 9Router bắt buộc thực hiện từ rank lớn nhất về rank 1 (rank 1 áp dụng cuối cùng).
- Tài khoản Antigravity chỉ được gán proxy mới khi proxy cũ bị chết; không tự ý đảo proxy khi đang sống trừ khi người dùng bấm nút tối ưu theo tốc độ.
- Proxy có `is_pinned = 1` không được phép xóa cứng trừ khi có cờ `force: true`.

---

### Task 1: Dọn dẹp Subsystem Auditor, Endpoints & DB Tables Cũ

**Files:**
- Delete:
  - `src/auditor/**` (toàn bộ thư mục)
  - `src/server/auditor-jobs.ts`
  - `src/server/detailed-checker.ts`
  - `src/lib/auditor-api.ts`
  - `scripts/proxy-audit.mjs`
  - `tests/auditor/**` (toàn bộ thư mục)
  - `tests/auditor-jobs.test.ts`
  - `tests/auditor-api.test.ts`
  - `tests/auditor-bulk-scheme.test.ts`
  - `tests/detailed-checker.test.ts`
  - `tests/proxy-audit-detail.test.ts`
  - `src/app/(dashboard)/auditor/page.tsx`
  - `src/app/(dashboard)/diagnostics/page.tsx`
  - `src/app/(dashboard)/intelligence/page.tsx`
- Modify:
  - `src/server/proxy-intelligence-db.ts`
  - `src/server/server.ts`
  - `package.json`

**Interfaces:**
- Produces: `migrateProxyIntelligence(db: DatabaseSync): void` (đã dọn các bảng audit cũ).

- [ ] **Step 1: Xóa các file mã nguồn và test của Auditor cũ**

```bash
# Xóa thư mục src/auditor và tests/auditor
rm -rf src/auditor tests/auditor
# Xóa server files, scripts, và client api auditor
rm -f src/server/auditor-jobs.ts src/server/detailed-checker.ts src/lib/auditor-api.ts scripts/proxy-audit.mjs
# Xóa các file test liên quan đến auditor
rm -f tests/auditor-jobs.test.ts tests/auditor-api.test.ts tests/auditor-bulk-scheme.test.ts tests/detailed-checker.test.ts tests/proxy-audit-detail.test.ts
# Xóa các redirect pages cũ
rm -f src/app/(dashboard)/auditor/page.tsx src/app/(dashboard)/diagnostics/page.tsx src/app/(dashboard)/intelligence/page.tsx
```

- [ ] **Step 2: Cập nhật migration trong `src/server/proxy-intelligence-db.ts` để drop các bảng audit cũ**

Chỉnh sửa `src/server/proxy-intelligence-db.ts`: Trong hàm `migrateProxyIntelligence`, xóa bỏ code tạo các bảng `proxy_audits`, `proxy_audit_risks`, `audit_jobs`, `proxy_diagnostics` và thay bằng lệnh:
```typescript
db.exec(`
  DROP TABLE IF EXISTS proxy_audits;
  DROP TABLE IF EXISTS proxy_audit_risks;
  DROP TABLE IF EXISTS audit_jobs;
  DROP TABLE IF EXISTS proxy_diagnostics;
`);
```

- [ ] **Step 3: Gỡ bỏ endpoint auditor trong `src/server/server.ts`**

Gỡ bỏ `handleAuditor`, `handleDiagnostics`, import `createAuditorJobManager`, import `createDiagnosticRunner`, và các routing `/api/auditor/*`, `/api/diagnostics/*`.

- [ ] **Step 4: Cập nhật `package.json`**

Gỡ bỏ `scripts.proxy-audit`, `scripts["test:auditor"]`, `scripts["test:integration"]`, và `bin["proxy-audit"]`. Giữ nguyên `playwright` trong `devDependencies`.

- [ ] **Step 5: Chạy typecheck và kiểm tra server tests**

Run: `npx tsc --noEmit`
Expected: 0 errors ở server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove proxy auditor subsystem and drop audit tables"
```

---

### Task 2: Schema SQLite Mới & Repository Methods cho Pin, Tag, Soft Delete & Hard Delete

**Files:**
- Modify: `src/server/proxy-intelligence-db.ts`
- Modify: `src/server/proxy-intelligence-repository.ts`
- Modify: `src/lib/types.ts`
- Test: `tests/proxy-pin-and-delete.test.ts`

**Interfaces:**
- Produces in `proxy-intelligence-repository.ts`:
  - `setPin(proxyKey: string, isPinned: boolean): Promise<boolean>`
  - `updateTags(proxyKey: string, tags: string[]): Promise<void>`
  - `recordTestResult(proxyKey: string, ok: boolean, latencyMs?: number, errorMessage?: string): Promise<void>`
  - `softDeleteFromRouter(proxyKey: string, errorMessage?: string): Promise<void>`
  - `hardDeleteProxy(proxyKey: string, force?: boolean): Promise<{ deleted: boolean; remoteId: string | null }>`
  - Mở rộng `UnifiedProxyItem` với các trường: `isPinned: boolean`, `tags: string[]`, `remoteId: string | null`, `routerState: 'active' | 'reserve' | 'removed' | 'unmanaged'`, `removedAt: number | null`, `lastLatencyMs: number | null`.

- [ ] **Step 1: Viết test cho Pin, Soft Delete và Hard Delete**

Tạo `tests/proxy-pin-and-delete.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("proxy repository supports pin, soft delete from router, and guarded hard delete", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pin-test-"));
  const dbPath = path.join(tmpDir, "proxies.sqlite3");
  const db = openProxyIntelligenceDb(dbPath);
  const repo = createProxyIntelligenceRepository(db);

  try {
    // 1. Import a test proxy
    await repo.importTextInventory("http://user:pass@1.2.3.4:8080", "test");
    const list = await repo.listUnifiedProxies({});
    assert.equal(list.proxies.length, 1);
    const proxy = list.proxies[0];
    assert.equal(proxy.isPinned, false);
    assert.equal(proxy.routerState, "unmanaged");

    // 2. Pin proxy
    const pinRes = await repo.setPin(proxy.proxyKey, true);
    assert.equal(pinRes, true);
    let updated = await repo.getProxy(proxy.proxyKey);
    assert.equal(updated?.isPinned, true);

    // 3. Record test failure and soft delete from router
    await repo.recordTestResult(proxy.proxyKey, false, undefined, "Connection timeout");
    await repo.softDeleteFromRouter(proxy.proxyKey, "Connection timeout");
    updated = await repo.getProxy(proxy.proxyKey);
    assert.equal(updated?.status, "dead");
    assert.equal(updated?.routerState, "removed");
    assert.ok(updated?.removedAt);
    assert.equal(updated?.lastError, "Connection timeout");

    // 4. Guarded hard delete: cannot delete pinned proxy without force
    await assert.rejects(
      async () => await repo.hardDeleteProxy(proxy.proxyKey, false),
      /is pinned/i
    );

    // 5. Force hard delete removes record completely
    const delRes = await repo.hardDeleteProxy(proxy.proxyKey, true);
    assert.equal(delRes.deleted, true);
    const afterDel = await repo.getProxy(proxy.proxyKey);
    assert.equal(afterDel, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node --import tsx --test tests/proxy-pin-and-delete.test.ts`
Expected: FAIL (các cột và phương thức chưa tồn tại).

- [ ] **Step 3: Cập nhật schema trong `src/server/proxy-intelligence-db.ts`**

Bổ sung vào `migrateProxyIntelligence`:
```typescript
db.exec(`
  ALTER TABLE proxies ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE proxies ADD COLUMN tags TEXT NOT NULL DEFAULT '';
  ALTER TABLE proxies ADD COLUMN remote_id TEXT;
  ALTER TABLE proxies ADD COLUMN router_state TEXT NOT NULL DEFAULT 'unmanaged';
  ALTER TABLE proxies ADD COLUMN removed_at INTEGER;
  ALTER TABLE proxies ADD COLUMN last_latency_ms INTEGER;
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS proxy_test_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_key TEXT NOT NULL,
    tested_at INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    error_message TEXT,
    FOREIGN KEY (proxy_key) REFERENCES proxies(proxy_key) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_proxy_test_history_key ON proxy_test_history(proxy_key, tested_at DESC);
`);
```
(Dùng try/catch hoặc `PRAGMA table_info` để an toàn nếu cột đã tồn tại).

- [ ] **Step 4: Cập nhật `src/server/proxy-intelligence-repository.ts`**

Cài đặt các hàm `setPin`, `updateTags`, `recordTestResult`, `softDeleteFromRouter`, `hardDeleteProxy`, và map các cột mới vào `UnifiedProxyItem`. Cập nhật `src/lib/types.ts` để đồng bộ interface.

- [ ] **Step 5: Chạy lại test để xác nhận pass**

Run: `node --import tsx --test tests/proxy-pin-and-delete.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/proxy-intelligence-db.ts src/server/proxy-intelligence-repository.ts src/lib/types.ts tests/proxy-pin-and-delete.test.ts
git commit -m "feat: add proxy pin, soft-delete, and hard-delete repository methods"
```

---

### Task 3: 9Router Healthcheck, Auto-Evict Proxy Chết & Auto-Rename theo Latency

**Files:**
- Modify: `src/server/pool-ranker.ts`
- Modify: `src/server/ninerouter-client.ts`
- Test: `tests/ninerouter-wrapper-sync.test.ts`

**Interfaces:**
- Consumes: `deps.testPool(remoteId)`, `deps.deletePool(remoteId)`, `deps.renamePool(remoteId, name)`, `repo.softDeleteFromRouter(proxyKey, err)`.
- Produces: `poolRanker.syncPools(): Promise<SyncResult>` (thực hiện: test -> xóa pool chết trên 9Router và soft-delete trong DB -> sắp xếp latency tăng dần -> rename từ rank cao nhất về rank 1).

- [ ] **Step 1: Viết test cho 9Router Sync với auto-evict và reverse-rank rename**

Tạo `tests/ninerouter-wrapper-sync.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { createPoolRanker } from "../src/server/pool-ranker.js";

test("syncPools evicts dead pool from 9router, soft-deletes in repo, and renames survivors in reverse rank order", async () => {
  const deletedRemoteIds: string[] = [];
  const renamedCalls: { remoteId: string; name: string }[] = [];
  const softDeletedKeys: string[] = [];

  const mockDeps = {
    listPools: async () => [
      { id: "p-fast", name: "Old 1", endpoint: "1.1.1.1:8080", protocol: "http", isActive: true },
      { id: "p-slow", name: "Old 2", endpoint: "2.2.2.2:8080", protocol: "http", isActive: true },
      { id: "p-dead", name: "Old 3", endpoint: "3.3.3.3:8080", protocol: "http", isActive: true },
    ],
    testPool: async (remoteId: string) => {
      if (remoteId === "p-dead") return { ok: false, elapsedMs: 5000, error: "Gateway timeout" };
      if (remoteId === "p-fast") return { ok: true, elapsedMs: 120 };
      if (remoteId === "p-slow") return { ok: true, elapsedMs: 450 };
      return { ok: false, elapsedMs: 0 };
    },
    deletePool: async (remoteId: string) => {
      deletedRemoteIds.push(remoteId);
    },
    setPoolActive: async () => {},
    renamePool: async (remoteId: string, name: string) => {
      renamedCalls.push({ remoteId, name });
    },
    onSoftDelete: async (key: string) => {
      softDeletedKeys.push(key);
    },
  };

  const ranker = createPoolRanker(mockDeps as any);
  await ranker.syncPools();

  // Dead pool must be deleted from 9router
  assert.deepEqual(deletedRemoteIds, ["p-dead"]);

  // Renaming must occur: p-fast (120ms) is rank 1, p-slow (450ms) is rank 2.
  // Reverse rank order: rank 2 is renamed FIRST, then rank 1.
  assert.equal(renamedCalls.length, 2);
  assert.deepEqual(renamedCalls[0], { remoteId: "p-slow", name: "2" });
  assert.deepEqual(renamedCalls[1], { remoteId: "p-fast", name: "1" });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node --import tsx --test tests/ninerouter-wrapper-sync.test.ts`
Expected: FAIL

- [ ] **Step 3: Cập nhật `src/server/pool-ranker.ts`**

Tích hợp `deletePool` khi `testPool` trả về `ok: false`, gọi callback soft-delete lưu vào SQLite DB (giữ nguyên record). Sắp xếp survivors theo latency tăng dần và gọi rename từ rank N về 1.

- [ ] **Step 4: Chạy lại test để xác nhận pass**

Run: `node --import tsx --test tests/ninerouter-wrapper-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/pool-ranker.ts tests/ninerouter-wrapper-sync.test.ts
git commit -m "feat: implement 9router health evict and latency-based reverse-rank rename"
```

---

### Task 4: Chu kỳ Đồng bộ Gộp (Unified Sync Window) & Điều phối Antigravity Rotator

**Files:**
- Create: `src/server/unified-sync-coordinator.ts`
- Modify: `src/server/antigravity-rotator.ts`
- Test: `tests/unified-sync-coordinator.test.ts`

**Interfaces:**
- Produces in `unified-sync-coordinator.ts`:
  - `runUnifiedSyncCycle(): Promise<UnifiedSyncReport>`: Chạy 1 chu kỳ gộp duy nhất (Sync 9Router -> Antigravity bù proxy chết -> hoàn tất).
- Produces in `antigravity-rotator.ts`:
  - `computeRotationPlan(connections, usageMap, usableProxies, options)`: Chỉ thay thế proxy cho tài khoản có proxy chết/mất, giữ nguyên 100% proxy của tài khoản đang sống.
  - `optimizeAccountsBySpeed(connections, rankedProxies)`: Sắp xếp tài khoản active và gán theo top rank latency.

- [ ] **Step 1: Viết test cho Unified Sync Coordinator & Antigravity policy**

Tạo `tests/unified-sync-coordinator.test.ts`:
```typescript
import test from "node:test";
import assert from "node:assert/strict";
import { computeRotationPlan, optimizeAccountsBySpeed } from "../src/server/antigravity-rotator.js";

test("antigravity rotator only replaces dead proxy during normal cycle, and assigns by speed when optimized", () => {
  const connections = [
    { id: "acc-1", email: "a1@test.com", isActive: true, proxyPoolId: "px-alive" },
    { id: "acc-2", email: "a2@test.com", isActive: true, proxyPoolId: "px-dead" },
  ];
  const usableProxies = [
    { id: "px-alive", name: "1", latencyMs: 100 },
    { id: "px-backup", name: "2", latencyMs: 200 },
  ];

  // 1. Normal rotation: acc-1 keeps px-alive, acc-2 gets px-backup
  const plan = computeRotationPlan(connections as any, new Map(), usableProxies as any, { activeLimit: 2 });
  const patch1 = plan.patches.find(p => p.id === "acc-1");
  const patch2 = plan.patches.find(p => p.id === "acc-2");
  assert.equal(patch1?.proxyPoolId, undefined); // Không đổi proxy của acc-1
  assert.equal(patch2?.proxyPoolId, "px-backup"); // Chỉ đổi proxy cho acc-2

  // 2. Optimize by speed: acc-1 gets rank 1 (px-alive), acc-2 gets rank 2 (px-backup)
  const speedPatches = optimizeAccountsBySpeed(connections as any, usableProxies as any);
  assert.equal(speedPatches.length, 2);
  assert.equal(speedPatches[0].proxyPoolId, "px-alive");
  assert.equal(speedPatches[1].proxyPoolId, "px-backup");
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node --import tsx --test tests/unified-sync-coordinator.test.ts`
Expected: FAIL

- [ ] **Step 3: Cài đặt `optimizeAccountsBySpeed` và cập nhật policy trong `src/server/antigravity-rotator.ts`**

Đảm bảo `computeRotationPlan` giữ nguyên `proxyPoolId` nếu proxy hiện tại vẫn nằm trong `usableProxies`. Cài đặt hàm `optimizeAccountsBySpeed`.

- [ ] **Step 4: Tạo `src/server/unified-sync-coordinator.ts`**

Kết nối `poolRanker.syncPools()` và `antigravityRotator.runRotation()` thành chuỗi thực thi liên hoàn trong 1 hàm `runUnifiedSyncCycle()`. Cung cấp cờ `isRunning` để tránh trùng lặp.

- [ ] **Step 5: Chạy lại test để xác nhận pass**

Run: `node --import tsx --test tests/unified-sync-coordinator.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/unified-sync-coordinator.ts src/server/antigravity-rotator.ts tests/unified-sync-coordinator.test.ts
git commit -m "feat: implement unified sync coordinator and antigravity speed optimizer"
```

---

### Task 5: Server API Endpoints & Client API cho Proxy Management

**Files:**
- Modify: `src/server/server.ts`
- Modify: `src/lib/api.ts`
- Test: `tests/proxy-management-api.test.ts`

**Interfaces:**
- Produces:
  - `POST /api/proxies/:key/test`: gọi `testPool` đơn lẻ.
  - `POST /api/proxies/:key/push-router`: tạo pool mới trên 9Router và gán `remote_id`.
  - `POST /api/proxies/:key/unlink-router`: xóa pool trên 9Router, chuyển `router_state = 'removed'` trong DB.
  - `PATCH /api/proxies/:key/pin`: toggle `is_pinned`.
  - `DELETE /api/proxies/:key`: xóa vĩnh viễn (yêu cầu `?force=true` nếu `is_pinned`).
  - `POST /api/ninerouter/sync-all`: trigger `runUnifiedSyncCycle()`.
  - `POST /api/antigravity/optimize-by-speed`: trigger `optimizeAccountsBySpeed()`.

- [ ] **Step 1: Viết test API hợp đồng cho các routes mới**

Tạo `tests/proxy-management-api.test.ts` kiểm tra HTTP status code và payload format cho các endpoint trên.

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `node --import tsx --test tests/proxy-management-api.test.ts`
Expected: FAIL (routes 404).

- [ ] **Step 3: Cài đặt các route handlers trong `src/server/server.ts`**

Bổ sung routing logic trong `server.ts` kết nối tới `proxyIntelligenceRepository`, `nineRouterClient`, `poolRanker`, và `unifiedSyncCoordinator`.

- [ ] **Step 4: Cập nhật client functions trong `src/lib/api.ts`**

Thêm:
- `testProxyViaRouter(key: string)`
- `pushProxyToRouter(key: string)`
- `unlinkProxyFromRouter(key: string)`
- `setProxyPin(key: string, pinned: boolean)`
- `hardDeleteProxy(key: string, force?: boolean)`
- `triggerUnifiedSync()`
- `triggerOptimizeAccountsBySpeed()`

- [ ] **Step 5: Chạy lại test để xác nhận pass**

Run: `node --import tsx --test tests/proxy-management-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/server/server.ts src/lib/api.ts tests/proxy-management-api.test.ts
git commit -m "feat: add api endpoints and client helpers for 9router wrapper management"
```

---

### Task 6: Shadcn ContextMenu & Giao Diện Quản Lý Proxies

**Files:**
- Create: `src/components/proxies/proxy-context-menu.tsx`
- Modify: `src/components/proxies/proxy-table.tsx`
- Modify: `src/app/(dashboard)/proxies/page.tsx`
- Modify: `src/components/proxies/proxy-selection-bar.tsx`

**Interfaces:**
- Produces: `ProxyContextMenu` bọc từng row của `ProxyTable`. Hiển thị badge Pin/Protected, cột Router Status, Latency (ms). Nút Toolbar "Sync & Kiểm tra toàn bộ" và "Tối ưu gán theo tốc độ".

- [ ] **Step 1: Tạo component `src/components/proxies/proxy-context-menu.tsx`**

Sử dụng Radix / Shadcn `ContextMenu`:
- Mục 1 (9Router): Test sức khỏe, Đẩy lên 9Router, Gỡ khỏi 9Router, Đổi tier, Đổi tên pool.
- Mục 2 (Quản lý App): Ghim bảo vệ (Protected) / Bỏ ghim, Quản lý Tag, Copy URL/cURL.
- Mục 3: Xóa vĩnh viễn (Hard delete - màu đỏ kèm icon `Trash2`).

- [ ] **Step 2: Cập nhật `src/components/proxies/proxy-table.tsx`**

- Bọc mỗi dòng table bằng `ProxyContextMenu`.
- Hiển thị badge icon `Pin` màu vàng bên cạnh endpoint nếu `proxy.isPinned === true`.
- Hiển thị badge Router Status: `Active` (xanh), `Reserve` (vàng), `Removed` (xám).
- Cột Latency hiển thị `proxy.lastLatencyMs ? `${proxy.lastLatencyMs}ms` : '—'`.
- Bỏ cột Privacy score.

- [ ] **Step 3: Cập nhật toolbar và dọn audit trong `src/app/(dashboard)/proxies/page.tsx`**

- Thêm 2 nút:
  - `<Button onClick={handleUnifiedSync}>Sync & Kiểm tra toàn bộ</Button>` (icon RefreshCw).
  - `<Button variant="outline" onClick={handleOptimizeSpeed}>Tối ưu gán theo tốc độ</Button>` (icon Zap).
- Gỡ bỏ `<AuditJobIndicator />` và các state audit liên quan.
- Thêm dialog xác nhận Hard Delete khi người dùng chọn xóa vĩnh viễn (cảnh báo đỏ nếu proxy đang được ghim).

- [ ] **Step 4: Chạy typecheck kiểm tra frontend**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/proxies/proxy-context-menu.tsx src/components/proxies/proxy-table.tsx src/app/(dashboard)/proxies/page.tsx src/components/proxies/proxy-selection-bar.tsx
git commit -m "feat: add shadcn context menu and updated proxy management ui"
```

---

### Task 7: Toàn diện Kiểm thử, Typecheck & Verification

**Files:**
- Run workspace validation

- [ ] **Step 1: Chạy typecheck toàn dự án**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 2: Chạy toàn bộ test suite của server & proxy**

Run: `node --import tsx --test tests/**/*.test.ts`
Expected: 100% tests pass.

- [ ] **Step 3: Chạy test agent Go**

Run: `go test ./...` trong thư mục `agent/`
Expected: 100% tests pass.

- [ ] **Step 4: Commit hoàn tất**

```bash
git commit --allow-empty -m "chore: verify 9router smart wrapper and proxy management suite"
```
