# Google Proxy Pre-Flight Health Check & In-Flight Quota Fallback Implementation Plan

> SUPERSEDED — Do not execute these tasks. The approved architecture requires strict TLS, route-specific evidence, router-local conditional binding, and retry inside 9Router before downstream commitment, not console-log replay. See [the replacement design](../specs/2026-10-25-google-proxy-audit-and-inflight-rebind-design.md); its written-spec review precedes a new implementation plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ngăn chặn triệt để lỗi `403 Forbidden` / `Antigravity quota API access forbidden` trên các tài khoản Antigravity bằng cách probe tính tương thích Google của Proxy trước khi gán và tự động re-bind proxy sạch in-flight ngay khi phát hiện log 403 từ 9Router console stream.

**Architecture:** 
1. **Google Pre-flight Probe**: Xây dựng module probe HTTP chuyên dụng qua proxy tới Google Cloud Code endpoint (`https://cloudcode-pa.googleapis.com` / `https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels`). Tích hợp cờ `googleBlocked: boolean` vào `PoolRecord` và database `proxies.sqlite3`. Cập nhật `getUsableProxies` để loại trừ hoàn toàn các proxy bị Google chặn khỏi danh sách gán cho Antigravity.
2. **In-Flight 403 Watcher & Runtime Re-bind**: Tạo worker SSE stream ngầm lắng nghe `GET /api/translator/console-logs/stream` từ 9Router. Khi phát hiện pattern `ERROR 403` hoặc `[AUTH] <email> locked modelLock_... for 120s [403]`, watcher ngay lập tức đánh dấu proxy hiện tại là `googleBlocked` và gọi hàm re-bind account sang clean proxy tức thời mà không cần đợi chu kỳ sync định kỳ.

**Tech Stack:** Node.js (v20+), TypeScript, SQLite (Drizzle ORM / sqlite3), native fetch & child_process / socks-proxy-agent / http-proxy-agent, Hono API routes, Node test runner (`node:test`).

**Spec:** docs/superpowers/specs/2026-10-25-google-proxy-audit-and-inflight-rebind.md

## Global Constraints
- Tuân thủ nguyên tắc thiết kế shadcn UI và theme Obsidian Flame (`#131318`, `#23232C`, `#FF5B22`).
- Toàn bộ test phải pass 100% (`npm test`), không làm vỡ các hợp đồng đa-master của 9Router.
- Giới hạn tối đa 2 accounts / proxy, không gán 2 account active cùng lúc lên 1 proxy.
- Proxy audit không được làm chậm chu kỳ sync thường; probe Google chạy song song với timeout tối đa 5000ms.

---

### Task 1: Module Google Pre-Flight Probe

**Files:**
- Create: `src/server/google-probe.ts`
- Test: `tests/google-probe.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GoogleProbeResult {
    ok: boolean;
    googleBlocked: boolean;
    status: number | null;
    elapsedMs: number;
    errorMessage?: string;
  }
  export function probeProxyGoogleCompatibility(
    proxyUrl: string,
    options?: { timeoutMs?: number; targetUrl?: string }
  ): Promise<GoogleProbeResult>;
  ```

- [ ] **Step 1: Viết test failing cho `probeProxyGoogleCompatibility`**

Tạo `tests/google-probe.test.ts` kiểm tra các trường hợp:
- Khi endpoint Google trả về 200/204: `googleBlocked === false, ok === true`.
- Khi endpoint Google trả về 403 Forbidden: `googleBlocked === true, ok === false, status === 403`.
- Khi proxy gặp lỗi transport (ECONNREFUSED / timeout): `googleBlocked === false, ok === false, errorMessage != null`.

- [ ] **Step 2: Chạy test để xác nhận test FAIL**

Run: `node --import tsx --test tests/google-probe.test.ts`
Expected: FAIL (Cannot find module `src/server/google-probe.ts`).

- [ ] **Step 3: Triển khai `src/server/google-probe.ts`**

Sử dụng `curl` subprocess (hoặc dispatcher an toàn không rò rỉ credential trong log) tương tự `endpoint-audit.ts` để gửi request test qua proxy tới:
`https://cloudcode-pa.googleapis.com` (hoặc `https://www.google.com/generate_204`).
Parse HTTP response code:
- Mã 403/401: gắn cờ `googleBlocked = true`.
- Mã 200/204: `ok = true, googleBlocked = false`.
- Lỗi kết nối / timeout: `ok = false, googleBlocked = false`.

- [ ] **Step 4: Chạy test để xác nhận test PASS**

Run: `node --import tsx --test tests/google-probe.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/google-probe.ts tests/google-probe.test.ts
git commit -m "feat(proxy): implement google pre-flight compatibility probe"
```

---

### Task 2: Tích hợp `googleBlocked` vào `PoolRecord` và `poolRanker`

**Files:**
- Modify: `src/server/pool-ranker.ts:50-100,450-490`
- Modify: `src/server/server.ts:192-200`
- Test: `tests/pool-ranker-google.test.ts`

**Interfaces:**
- Consumes: `probeProxyGoogleCompatibility` từ `src/server/google-probe.ts`.
- Produces: `PoolRecord.googleBlocked?: boolean` và lọc trong `getUsableProxies`.

- [ ] **Step 1: Viết test failing cho `poolRanker` khi phát hiện Google 403**

Tạo `tests/pool-ranker-google.test.ts`:
- Mock `probeProxyGoogleCompatibility`: trả về `googleBlocked: true` cho `proxy-bad` và `googleBlocked: false` cho `proxy-good`.
- Sau khi ranker chạy, pool `proxy-bad` có `googleBlocked: true`.
- Kiểm tra hàm `getUsableProxies` không chứa `proxy-bad`.

- [ ] **Step 2: Chạy test để xác nhận test FAIL**

Run: `node --import tsx --test tests/pool-ranker-google.test.ts`
Expected: FAIL (`googleBlocked` chưa tồn tại trên `PoolRecord`).

- [ ] **Step 3: Cập nhật `src/server/pool-ranker.ts` và `src/server/server.ts`**

1. Mở rộng interface `PoolRecord` trong `src/server/pool-ranker.ts`:
   Thêm `googleBlocked?: boolean;`
2. Trong vòng lặp health check của `poolRanker`:
   Sau khi `deps.testPool` pass HTTP cơ bản, nếu có cấu hình `deps.probeGoogle`, gọi probe song song. Nếu trượt với 403, set `googleBlocked = true`.
3. Trong `src/server/server.ts`:
   Cập nhật filter trong `getUsableProxies()` của `antigravityRotator`:
   ```ts
   .filter((p) => p.status === "usable" && Boolean(p.remoteId) && !p.googleBlocked)
   ```

- [ ] **Step 4: Chạy lại toàn bộ test pool ranker**

Run: `node --import tsx --test tests/pool-ranker-google.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/pool-ranker.ts src/server/server.ts tests/pool-ranker-google.test.ts
git commit -m "feat(pool-ranker): tag googleBlocked proxies and exclude from antigravity usable pools"
```

---

### Task 3: In-Flight Console Stream Watcher & Runtime Re-bind

**Files:**
- Create: `src/server/inflight-403-watcher.ts`
- Modify: `src/server/server.ts`
- Test: `tests/inflight-403-watcher.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InFlightWatcherDeps {
    routerUrl: string;
    authPassword?: string;
    onAccountBlocked: (email: string, reason: string) => Promise<void> | void;
  }
  export function createInFlight403Watcher(deps: InFlightWatcherDeps): {
    start(): void;
    stop(): void;
    readonly isStreaming: boolean;
  };
  ```

- [ ] **Step 1: Viết test failing cho `parseConsoleLogEvent`**

Tạo `tests/inflight-403-watcher.test.ts`:
- Test phân tích dòng log SSE:
  `[16:56:55] ⚠️ [AUTH] metavocab@gmail.com locked modelLock_gemini-3.8-flash-high for 120s [403]`
  $\rightarrow$ trích xuất `{ email: "metavocab@gmail.com", error: "403 Forbidden" }`.
- Test phân tích dòng log SSE:
  `[16:56:55] 🟣 ✗ ERROR 403 · antigravity/gemini-3.8-flash-high · URL: ...streamGenerateContent... [403]: Forbidden`
  $\rightarrow$ trích xuất sự kiện 403.
- Test kích hoạt callback `onAccountBlocked`.

- [ ] **Step 2: Chạy test để xác nhận test FAIL**

Run: `node --import tsx --test tests/inflight-403-watcher.test.ts`
Expected: FAIL (`createInFlight403Watcher` chưa được định nghĩa).

- [ ] **Step 3: Triển khai `src/server/inflight-403-watcher.ts`**

Kết nối tới `GET /api/translator/console-logs/stream` qua fetch SSE:
- Đọc stream chunk-by-chunk với regex phát hiện 403 và tên tài khoản.
- Debounce 500ms chống spam trùng lặp cho cùng một email.
- Khi match, kích hoạt `deps.onAccountBlocked(email, reason)`.
- Tự động reconnect với exponential backoff (2s $\rightarrow$ 10s) nếu kết nối SSE bị ngắt.

- [ ] **Step 4: Tích hợp watcher vào `src/server/server.ts`**

Khi khởi động server:
- Khởi chạy watcher kết nối tới các 9Router nodes.
- Callback `onAccountBlocked`:
  1. Ghi log cảnh báo `logActivity("warn", ...)`
  2. Gọi `antigravityRotator.autoRepairForbidden()` tức thì để unbind proxy hỏng và gán proxy sạch.
  3. Kích hoạt chu kỳ rotation ngắn để đưa account dự phòng lên thế chỗ slot bị khóa.

- [ ] **Step 5: Chạy test để xác nhận test PASS**

Run: `node --import tsx --test tests/inflight-403-watcher.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/inflight-403-watcher.ts src/server/server.ts tests/inflight-403-watcher.test.ts
git commit -m "feat(antigravity): add in-flight 403 watcher and real-time proxy re-bind"
```

---

### Task 4: Regression Test & Verification Toàn Diện

**Files:**
- Test: `npm test`
- Verification: Verify trên 9Router thực tế LAN (`192.168.1.54:20128`).

- [ ] **Step 1: Chạy toàn bộ test suite dự án**

Run: `npm test`
Expected: Tất cả các suite (bao gồm dual-router, rotator, watcher, probe) đều PASS 100%.

- [ ] **Step 2: Smoke test API endpoint `/api/antigravity/auto-repair-forbidden`**

Gửi request kiểm tra endpoint hoạt động trả về JSON hợp lệ (`{ ok: true, repaired: 0, accounts: [] }`).

- [ ] **Step 3: Commit hoàn thành**

```bash
git commit --allow-empty -m "chore: verify google pre-flight probe and in-flight re-bind plan"
```
