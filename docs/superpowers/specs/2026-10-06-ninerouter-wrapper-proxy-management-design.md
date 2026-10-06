# Thiết kế Kiến trúc: 9Router Smart Wrapper & Quản lý Proxy Tinh gọn

- **Ngày lập**: 2026-10-06
- **Trạng thái**: Chờ duyệt (Pending Review)
- **Mục tiêu**: Loại bỏ toàn bộ subsystem Proxy Auditor nội bộ, tinh gọn codebase thành một smart wrapper chuyên biệt điều khiển 9Router với cơ chế ghim bảo vệ (Pin/Protected), dọn dẹp proxy chết (Soft delete khỏi 9Router nhưng lưu trong app), xóa vĩnh viễn (Hard delete), menu ngữ cảnh Shadcn (ContextMenu), và chu kỳ đồng bộ gộp (Unified Maintenance Window) điều phối cùng Antigravity Rotator.

---

## 1. Bối cảnh & Mục tiêu

### 1.1 Vấn đề hiện tại
- Subsystem Proxy Auditor tự phát triển (gồm các probe SSRF, TLS, content integrity, scoring, reputation, background audit jobs, hàng loạt bảng DB `proxy_audits`, `audit_jobs`, v.v.) chiếm lượng code khổng lồ, phức tạp hóa luồng vận hành và gây trùng lặp với khả năng healthcheck có sẵn của 9Router (`testPool`).
- Việc chạy song song hai chu kỳ độc lập giữa Proxy Sync và Antigravity Rotator khiến 9Router phải hứng nhiều request cùng lúc rải rác trong ngày, gây giật lag và nguy cơ race condition khi rotator gán trúng proxy đang bị sync gỡ bỏ.
- Chưa có cơ chế bảo vệ (Pin/Tag) đối với các proxy tự tạo (custom proxy), dẫn đến nguy cơ bị tự động dọn dẹp mất dấu.
- Thao tác quản lý proxy trên giao diện phân tán, thiếu menu chuột phải trực quan để tương tác tức thì.

### 1.2 Mục tiêu kiến trúc
1. **Dọn sạch Auditor**: Xóa bỏ 100% mã nguồn auditor nội bộ, test suites và bảng DB liên quan. Giữ lại `playwright` trong `package.json` để phục vụ audit/kiểm tra 9Router khi cần.
2. **9Router Thin Wrapper**: Dùng trực tiếp API 9Router (`POST /api/proxy-pools/:id/test`) để kiểm tra sức khỏe và đo độ trễ (latency).
3. **Cơ chế Soft Delete & Lưu trữ**: Khi proxy chết và bị 9Router deactivate, app tự động gọi API xóa pool khỏi 9Router để giải phóng slot, nhưng **lưu lại đầy đủ cấu hình trong SQLite** kèm lỗi và thời gian để người dùng có thể sửa và đẩy lại lên 9Router.
4. **Cơ chế Ghim bảo vệ (Protected / Pin)**: Cho phép tag hoặc ghim các proxy tự tạo để không bao giờ bị auto-delete dọn rác, có badge nhận diện rõ ràng.
5. **Rename theo tốc độ**: Proxy sống được xếp hạng theo latency tăng dần (nhanh nhất = số 1, lần lượt đến 2, 3...) và đổi tên trên 9Router theo thứ tự từ rank cao nhất về rank 1 (để rank 1 áp dụng cuối cùng).
6. **Chu kỳ Đồng bộ Gộp (Unified Maintenance Window)**: Chạy dồn toàn bộ tác vụ (healthcheck, đo tốc độ, xóa pool chết, rename, và gán lại proxy chết cho Antigravity) vào một lượt duy nhất. Xong lượt là hệ thống nghỉ ngơi hoàn toàn.
7. **Quy tắc gán Antigravity**: Chỉ gán proxy mới cho tài khoản có proxy bị chết; giữ nguyên 100% proxy của các tài khoản đang sống. Bổ sung nút riêng: "Tối ưu gán theo tốc độ" khi người dùng muốn chủ động sắp xếp lại.
8. **Shadcn ContextMenu**: Tích hợp menu chuột phải trên bảng danh sách proxy hỗ trợ toàn bộ hành động: check sức khỏe, đổi tier, đẩy lên/gỡ khỏi 9Router, ghim/bỏ ghim, đổi tên, copy, và xóa vĩnh viễn (Hard delete).

---

## 2. Kế hoạch Dọn dẹp Mã nguồn (Cleanup Scope)

### 2.1 File & Thư mục xóa bỏ hoàn toàn
- `src/auditor/**`: Toàn bộ parser, probes, scoring, reputation, transport, cli, browser.
- `src/server/auditor-jobs.ts`: Background jobs quản lý audit.
- `src/server/detailed-checker.ts`: Diagnostics runner nội bộ cũ.
- `scripts/proxy-audit.mjs`: Script CLI proxy-audit.
- `src/lib/auditor-api.ts`: API client cũ cho auditor.
- `tests/auditor/**`: Toàn bộ 11 test suites của auditor engine.
- `tests/auditor-jobs.test.ts`, `tests/auditor-api.test.ts`, `tests/auditor-bulk-scheme.test.ts`, `tests/detailed-checker.test.ts`, `tests/proxy-audit-detail.test.ts`.
- `src/app/(dashboard)/auditor/page.tsx`, `src/app/(dashboard)/diagnostics/page.tsx`, `src/app/(dashboard)/intelligence/page.tsx`: Các trang redirect mồ côi.

### 2.2 Endpoint cần gỡ trong `src/server/server.ts`
- Gỡ bỏ toàn bộ router `/api/auditor/*` (`handleAuditor`).
- Gỡ bỏ router `/api/diagnostics/*` (`handleDiagnostics`).
- Gỡ bỏ các endpoint check validity đơn lẻ phụ thuộc auditor engine.

### 2.3 Package.json & Scripts
- **Giữ lại**: `playwright` (dùng cho tác vụ kiểm tra/audit 9Router tự động khi cần).
- **Gỡ bỏ scripts**: `test:auditor`, `test:integration`, `proxy-audit`.

---

## 3. Cấu trúc Dữ liệu & SQLite Schema

### 3.1 Dọn bảng audit cũ
Thực thi migration tự động trong `src/server/proxy-intelligence-db.ts`:
```sql
DROP TABLE IF EXISTS proxy_audits;
DROP TABLE IF EXISTS proxy_audit_risks;
DROP TABLE IF EXISTS audit_jobs;
DROP TABLE IF EXISTS proxy_diagnostics;
```

### 3.2 Bổ sung cột cho bảng `proxies`
Bảng `proxies` là kho dữ liệu (source of truth) duy nhất trong SQLite:
```sql
ALTER TABLE proxies ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proxies ADD COLUMN tags TEXT NOT NULL DEFAULT '';
ALTER TABLE proxies ADD COLUMN remote_id TEXT;
ALTER TABLE proxies ADD COLUMN router_state TEXT NOT NULL DEFAULT 'unmanaged'; -- 'active' | 'reserve' | 'removed' | 'unmanaged'
ALTER TABLE proxies ADD COLUMN removed_at INTEGER;
ALTER TABLE proxies ADD COLUMN last_latency_ms INTEGER;
```

### 3.3 Bảng ghi nhận lịch sử kiểm tra nhanh `proxy_test_history`
Lưu vết các lần `testPool` từ 9Router phục vụ theo dõi độ ổn định:
```sql
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
```

---

## 4. Vòng đời Proxy & Hoạt động 9Router Wrapper

### 4.1 Quy trình Healthcheck & Soft Delete
1. Hệ thống gọi `nineRouterClient.testPool(remoteId)` (`POST /api/proxy-pools/:id/test`).
2. **Nếu thành công (`ok === true`)**:
   - Cập nhật SQLite: `status = 'usable'`, `last_latency_ms = elapsedMs`, `latency_ms = elapsedMs`, tăng `successes`, `checked_at = Date.now()`.
3. **Nếu thất bại (`ok === false`)**:
   - 9Router tự deactivate pool.
   - App gọi `nineRouterClient.deletePool(remoteId)` để xóa pool trên 9Router, giải phóng slot.
   - Cập nhật SQLite:
     - `status = 'dead'`
     - `router_state = 'removed'`
     - `remote_id = NULL`
     - `removed_at = Date.now()`
     - `last_error = failureMessage`
     - Tăng `failures`, `checked_at = Date.now()`.
   - **Đối với proxy có `is_pinned = 1`**: Vẫn xóa pool trên 9Router để nhường chỗ cho proxy hoạt động, nhưng record trong SQLite được đánh dấu badge `Protected (Offline)` kèm nút hành động "Đẩy lại lên 9Router" (Push to 9Router) để tái kích hoạt ngay khi người dùng chỉnh sửa xong proxy.

### 4.2 Xếp hạng và Đổi tên theo Tốc độ (Auto-Rename)
1. Lấy danh sách toàn bộ proxy sống (`status = 'usable'`) có mặt trên 9Router.
2. Sắp xếp danh sách theo `latency_ms` tăng dần (thấp nhất = vị trí số 1).
3. Đổi tên các pool theo cú pháp rank: `1`, `2`, `3`, ...
4. **Quy tắc thực thi**: Gọi API đổi tên theo thứ tự từ rank cao nhất về rank 1 (ví dụ từ `20` -> `19` -> ... -> `1`) để pool nhanh nhất luôn là thao tác cuối cùng được áp dụng, tránh xung đột tên.

### 4.3 Thao tác Xóa hẳn (Hard Delete)
- Endpoint: `DELETE /api/proxies/:key` (hỗ trợ xóa đơn lẻ và hàng loạt qua batch).
- Ràng buộc: Nếu proxy có `is_pinned = 1`, API yêu cầu cờ `force: true`. Giao diện hiển thị Modal xác nhận cảnh báo proxy đang được bảo vệ.
- Thực thi:
  1. Nếu proxy đang có `remote_id` trên 9Router: gọi `nineRouterClient.deletePool(remote_id)`.
  2. Thực thi `DELETE FROM proxies WHERE proxy_key = ?` trong SQLite (cascade xóa sạch lịch sử).

---

## 5. Chu kỳ Đồng bộ Gộp & Điều phối Antigravity Rotator

### 5.1 Chu kỳ Đồng bộ Gộp (Unified Maintenance Window)
- Thay thế hai chu kỳ chạy độc lập hiện tại bằng một vòng điều phối hợp nhất `UnifiedSyncCoordinator`.
- Tần suất: Chạy định kỳ theo cấu hình `settings.nineRouterSyncMinutes` (mặc định 30 phút) hoặc kích hoạt tức thì khi người dùng bấm nút **"Sync & Kiểm tra toàn bộ"** trên giao diện.
- **Tiến trình thực thi trong 1 chu kỳ**:
  ```mermaid
  sequenceDiagram
    participant App as UnifiedSyncCoordinator
    participant 9R as 9Router API
    participant DB as SQLite DB
    participant AG as Antigravity Rotator

    App->>9R: 1. Healthcheck: testPool() toàn bộ proxy
    9R-->>App: Kết quả latency / failure
    App->>9R: 2. Xóa pool chết (deactivated) khỏi 9Router
    App->>DB: Cập nhật status='dead', router_state='removed' (giữ nguyên config)
    App->>9R: 3. Đổi tên proxy sống theo rank latency (rank lớn về rank 1)
    App->>AG: 4. Kích hoạt kiểm tra tài khoản Antigravity
    AG->>9R: Query quota & cập nhật connection (CHỈ thay thế cho tài khoản có proxy chết)
    AG-->>App: Hoàn tất gán tài khoản
    App-->>App: 5. Nghỉ ngơi toàn diện, không lag nền
  ```

### 5.2 Cơ chế Gán Proxy cho Tài khoản Antigravity
1. **Chế độ tự động trong chu kỳ gộp**:
   - Quét danh sách tài khoản active.
   - Nếu proxy hiện tại của tài khoản vẫn đang `usable`: **Giữ nguyên 100%**, tuyệt đối không đảo proxy.
   - Nếu proxy hiện tại của tài khoản bị chết (`dead` hoặc không còn trong danh sách active): Chọn 1 proxy sống khả dụng từ pool để thay thế (đảm bảo không trùng proxy giữa 2 tài khoản active).
2. **Nút bấm thủ công "Tối ưu gán theo tốc độ" (Optimize Accounts by Speed)**:
   - Nằm trên toolbar giao diện.
   - Khi người dùng bấm: Sắp xếp các tài khoản active theo thứ tự ưu tiên và gán lần lượt các proxy có latency tốt nhất (rank 1, 2, 3...) từ 9Router.

---

## 6. Thiết kế Giao diện & Shadcn ContextMenu

### 6.1 Bảng Danh sách Proxy (`ProxyTable`)
- Bỏ cột "Privacy Score" và cột điểm số audit cũ.
- Bổ sung cột:
  - **Trạng thái / Bảo vệ**: Badge `Protected` (icon Pin màu vàng/xanh) nếu `is_pinned = 1`.
  - **9Router Status**: `Active` (xanh), `Reserve` (vàng), `Removed` (xám kèm thời gian đã gỡ).
  - **Độ trễ (Latency)**: Hiển thị ms đo được gần nhất từ 9Router.
- Tương tác: Nhấp chuột phải vào bất kỳ dòng nào sẽ mở **Shadcn ContextMenu**.

### 6.2 Chi tiết Shadcn ContextMenu
```
+---------------------------------------------+
|  [⚡] Kiểm tra sức khỏe (9Router test)      |
|  [🚀] Đẩy lên 9Router / Đồng bộ lại         |
|  [🛑] Gỡ khỏi 9Router (Giữ trong app)       |
|  [🔄] Đổi Tier (Active <-> Reserve)         |
|  [✏️] Đổi tên pool                          |
|---------------------------------------------|
|  [📌] Ghim bảo vệ (Protected) / Bỏ ghim     |
|  [🏷️] Quản lý Tag...                        |
|  [📋] Sao chép (URL / IP:Port / cURL)       |
|  [👤] Xem tài khoản Antigravity liên kết    |
|---------------------------------------------|
|  [🗑️] Xóa vĩnh viễn (Hard delete)          |
+---------------------------------------------+
```

### 6.3 Header Toolbar
- Nút **"Sync & Kiểm tra toàn bộ"** (Chạy ngay 1 Unified Maintenance Cycle).
- Nút **"Tối ưu gán theo tốc độ"** (Chỉ chạy khi chủ động bấm để đảo proxy tài khoản theo rank tốc độ).
- Nút **"Thêm Proxy"** / **"Import"** / **"Export"**.

---

## 7. Chiến lược Kiểm thử & Xác minh (Verification)

1. **Unit Tests**:
   - Test `UnifiedSyncCoordinator`: Đảm bảo thứ tự thực thi đúng chuỗi (test -> dọn pool chết -> rename từ rank cao về rank 1 -> gán bù proxy cho Antigravity).
   - Test `antigravityRotator`: Đảm bảo chỉ thay thế proxy cho tài khoản có proxy chết; kiểm tra hàm gán tối ưu theo tốc độ khi được gọi thủ công.
   - Test `proxy-intelligence-repository`: Đảm bảo ghim `is_pinned`, soft-delete khỏi router, và chặn hard-delete nếu chưa force.
2. **API & Integration Tests**:
   - Test các endpoint ContextMenu: `POST /api/proxies/:key/test`, `POST /api/proxies/:key/push-router`, `POST /api/proxies/:key/unlink-router`, `PATCH /api/proxies/:key/pin`, `DELETE /api/proxies/:key`.
3. **Workspace Check**:
   - `npx tsc --noEmit` đạt 0 lỗi TypeScript.
   - Toàn bộ test suite chạy pass (loại bỏ các file test auditor cũ).
