# Thiết kế: Nền tảng Phân tích Token & Tự động Gán Proxy Antigravity

- **Ngày tạo**: 2026-10-30
- **Trạng thái**: Chờ phê duyệt (Pending Approval)
- **Mục tiêu**: Tái định vị dự án thành công cụ chuyên biệt để quan sát, phân tích hiệu quả tiêu thụ token hàng ngày, đồng thời tự động điều phối và gán proxy cho các tài khoản Antigravity (Gemini OAuth) trên 9Router Raspberry Pi khi hết quota.

---

## 1. Bối cảnh & Mục tiêu Chuyển đổi

### 1.1 Vấn đề hiện tại
- Dự án ban đầu chứa nhiều module phân tán: quản lý cụm máy chủ worker (Fleet), cài đặt 3proxy daemon, mạng WireGuard mesh, agent viết bằng Go, và cơ chế đồng bộ đa router (Dual-Router).
- Toàn bộ hạ tầng proxy hiện tại đã được tinh gọn và định tuyến độc quyền qua máy chủ Raspberry Pi (`192.168.1.54:20128`).
- Giao diện bị phân mảnh giữa Overview chung và Dashboard 9Router riêng, menu điều hướng chứa nhiều trang không còn sử dụng hoặc là placeholder rỗng.

### 1.2 Mục tiêu mới
1. **Hợp nhất Dashboard**: Tích hợp số liệu tiêu thụ Token và trạng thái gán Proxy/Account vào một màn hình trung tâm duy nhất tại `/`.
2. **Quan sát & Phân tích Token Daily**: Hiển thị trực quan số lượng token (Prompt, Completion, Cached), chi phí thực tế ($), tỷ lệ hiệu quả và thống kê chi tiết theo từng model AI theo ngày (Today/24h/7D/30D).
3. **Tự động Gán Proxy (Auto-binding) & Xoay vòng Tài khoản**: Tự động phát hiện khi tài khoản Antigravity chạm ngưỡng quota session cài đặt, kích hoạt tài khoản dự phòng và gán proxy sống tối ưu nhất.
4. **Tối giản Thanh Điều hướng (Sidebar)**: Rút gọn menu còn 4 mục chuẩn: `Dashboard`, `Proxies`, `Bindings`, `Settings`.
5. **Dọn dẹp Triệt để Rác Hệ thống**: Xóa bỏ hoàn toàn code và dữ liệu thừa của Fleet, WireGuard, Go agent, 3proxy, và Dual-Router.

---

## 2. Kiến trúc Giao diện & Điều hướng (Frontend)

### 2.1 Cấu trúc Menu Điều hướng (Sidebar)
Thanh sidebar bên trái được thiết kế lại theo chuẩn shadcn, gồm 4 mục ngắn gọn:
- 📊 **Dashboard** (`/`): Màn hình điều khiển hợp nhất trung tâm.
- 🌐 **Proxies** (`/proxies`): Kho quản lý proxy, phân hạng latency, kiểm tra sức khỏe và import/export.
- 🔀 **Bindings** (`/bindings`): Xem chi tiết danh sách tài khoản Antigravity, proxy đang liên kết, và lịch sử xoay vòng (chuyển đổi từ `/ninerouter/proxies`).
- ⚙️ **Settings** (`/settings`): Cấu hình URL/khóa 9Router, ngưỡng xoay vòng quota, số lượng tài khoản chạy đồng thời, và mật khẩu bảo vệ.
- **Sidebar Footer**:
  - Widget tổng hợp Quota Antigravity (hiển thị % quota Gemini hiện tại, hover xem chi tiết).
  - Nút Đăng xuất (`Logout`).

### 2.2 Bố cục Màn hình Hợp nhất (`/` - Dashboard)
Màn hình Dashboard tích hợp 2 khu vực chức năng chính:

```
+-----------------------------------------------------------------------------------+
| Top Bar: Tiêu đề Dashboard, Bộ chọn chu kỳ (Today | 24h | 7D | 30D), Nút Refresh   |
+-----------------------------------------------------------------------------------+
| KHU VỰC 1: PHÂN TÍCH TOKEN & CHI PHÍ THEO THỜI GIAN THỰC                          |
| +-----------------------------------------------+ +-------------------------------+ |
| | Dot-Matrix LED 5x7: Toggle giữa Token & Cost | | Thẻ Hiệu suất (Efficiency):   | |
| | Số lớn trực quan, chỉ số tăng trưởng xu hướng | | Completion/Prompt, Cache save | |
| +-----------------------------------------------+ +-------------------------------+ |
| | Bảng phân tích chi tiết mức tiêu thụ theo từng Model AI (Claude, GPT, Sol...)   | |
+-----------------------------------------------------------------------------------+
| KHU VỰC 2: TRẠNG THÁI TÀI KHOẢN & TỰ ĐỘNG GÁN PROXY                               |
| +-------------------------------------------------------------------------------+ |
| | Bảng danh sách Tài khoản Antigravity đang hoạt động (theo activeLimit):        | |
| | - Tên tài khoản & % Quota Gemini còn lại (thanh tiến trình màu)               | |
| | - Proxy đang gán kèm (IP:Port, Latency ms, Trạng thái sống)                    | |
| | - Trạng thái xoay vòng: Active / Scheduled Rotate / Reserve                   | |
| +-------------------------------------------------------------------------------+ |
+-----------------------------------------------------------------------------------+
```

### 2.3 Xóa bỏ các trang và Component thừa
- Xóa các route placeholder: `/cdk`, `/invoice`, `/referral`, `/reseller`, `/scraping`, `/wallet`.
- Xóa drawer cũ: `src/components/right-panel.tsx`.
- Xóa component cũ không còn sử dụng: `src/components/dual-router/dual-router-card.tsx`.
- Gỡ bỏ component hiển thị console log SSE khỏi trang chính để giao diện tập trung hoàn toàn vào dữ liệu phân tích.

---

## 3. Kiến trúc Backend & Cơ chế Auto-binding

### 3.1 Quy tắc Tự động Xoay vòng & Gán Proxy (Antigravity Rotator)
Quá trình tự động chạy định kỳ thông qua bộ điều phối `unified-sync-coordinator`:
1. **Đọc tham số từ Settings**:
   - `antigravitySessionThreshold`: Ngưỡng % session quota kích hoạt xoay vòng (lấy từ cấu hình `settings.json`, ví dụ $\le 20\%$).
   - `antigravityActiveLimit`: Số lượng tài khoản chạy đồng thời tối đa (lấy trực tiếp từ cấu hình `settings.json`, tuyệt đối không hardcode).
   - `antigravityRotateMinutes`: Chu kỳ quét kiểm tra định kỳ.
2. **Quy trình thực thi**:
   - **Bước 1 (Đánh giá)**: Truy vấn danh sách tài khoản từ 9Router, tính toán % quota session của Gemini (bỏ qua Claude và GPT).
   - **Bước 2 (Tắt tài khoản hết quota)**: Nếu quota session $\le$ ngưỡng cấu hình, tự động chuyển tài khoản sang trạng thái tắt (`deactivate`), ghi nhận turn và mốc thời gian vào `antigravity-rotation.sqlite3`.
   - **Bước 3 (Kích hoạt tài khoản thay thế)**: Lọc các tài khoản dự phòng có quota $>$ ngưỡng cấu hình, **ưu tiên tài khoản có thời gian reset gần nhất**, kích hoạt cho đến khi đủ số lượng `activeLimit`.
   - **Bước 4 (Tự động gán Proxy sống)**:
     - Với mỗi tài khoản đang kích hoạt, kiểm tra proxy được gán tương ứng trong `proxies.sqlite3`.
     - Nếu proxy vẫn sống (status `working`, latency tốt) $\rightarrow$ **Giữ nguyên proxy**, không xáo trộn.
     - Nếu proxy bị chết (`dead`) hoặc chưa có proxy $\rightarrow$ Tự động chọn proxy sống có latency thấp nhất từ pool active và cập nhật binding lên 9Router.

### 3.2 Dọn dẹp Kiến trúc Backend & Database
1. **Xóa hoàn toàn Subsystem Dual-Router**:
   - Xóa thư mục `src/server/dual-router/` (coordinator, scheduler, conflict manager, usage write-back).
   - Xóa route `/api/ninerouter/dual` khỏi `src/server/api/app.ts` và `src/server/api/types.ts`.
   - Xóa các test file liên quan: `tests/dual-router-*.test.ts`.
2. **Dọn dẹp Database Layer**:
   - Xóa bỏ hoàn toàn file `data/fleet.sqlite3` và bản lưu `backups/databases/fleet.sqlite3`.
   - Xóa khai báo bảng `fleet_managed_endpoints` trong `src/db/proxies/schema.ts` và đoạn code khởi tạo bảng này trong `src/server/proxy-intelligence-db.ts`.
   - Xóa các hàm mồ côi trong `src/server/proxy-intelligence-repository.ts` (`syncManagedFleetEndpoints`, `unlinkManagedFleetNode`, `cleanupPendingManagedFleetEndpoints`).
   - Xóa assert kiểm tra file `fleet.sqlite3` trong `scripts/db-preflight.ts` và `scripts/db-verify.ts`.
   - Giữ nguyên 2 database cốt lõi: `proxies.sqlite3` (kho proxy) và `antigravity-rotation.sqlite3` (lịch sử xoay vòng).
3. **Chuẩn hóa Server Runtime & Endpoint Telemetry**:
   - Server chỉ còn các nhóm route chính:
     - `/api/auth/*`: Xác thực đăng nhập.
     - `/api/settings/*`: Cấu hình hệ thống.
     - `/api/ninerouter/stats`: Thống kê telemetry token/chi phí tiêu thụ trong ngày.
     - `/api/antigravity/*`: Quản lý xoay vòng và ánh xạ tài khoản.
     - `/api/proxies/*`: Quản lý kho proxy, ranking và kiểm tra chất lượng.

---

## 4. Dọn dẹp Docker, CI/CD & Triển khai

1. **Dockerfile**:
   - Bỏ toàn bộ build stage liên quan đến Go `agent/`.
   - Bỏ lệnh cài đặt các gói hệ thống không cần thiết: `wireguard`, `3proxy`.
   - Giữ lại môi trường chuẩn Next.js + Node.js server.
2. **Docker Compose**:
   - Đổi tên service từ `proxyfleet` thành `proxy-checker` hoặc `ninerouter-companion`.
   - Xóa volume mount `/etc/wireguard`.
3. **CI/CD (`.github/workflows/quality.yml`)**:
   - Xóa bỏ các bước chạy test Go agent (`test:agent`), build agent (`build:agent`), acceptance scripts.
   - Chỉ giữ lại các bước: `typecheck`, `lint`, `format:check`, `test`.
4. **Deploy Scripts & Systemd**:
   - Xóa các file dịch vụ không còn chức năng: `deploy/systemd/3proxy.service`, `deploy/systemd/proxyfleet-agent.service`.
   - Cập nhật đường dẫn thư mục trong các file service còn lại từ `/opt/proxyfleet` thành đường dẫn ứng dụng phù hợp.

---

## 5. Kế hoạch Kiểm thử & Xác minh (Verification)

1. **Typecheck & Linting**:
   - `npx tsc --noEmit` hoàn thành không lỗi (0 error).
   - Biome lint/format sạch sẽ.
2. **Kiểm thử Tích hợp**:
   - Kiểm tra API thống kê `/api/ninerouter/stats` trả về đúng số token/chi phí hôm nay từ Pi Router.
   - Chạy test case mô phỏng: Hạ quota 1 tài khoản xuống $\le 20\%$, xác minh hệ thống tự động ngắt, bật tài khoản reset sớm nhất và gán proxy sống tối ưu.
   - Chạy toàn bộ test suites hiện hành (đã lọc các test của dual-router và fleet).
3. **Build Frontend**:
   - `npm run build` thành công, tạo đầy đủ các route tĩnh và SSR cho `/`, `/proxies`, `/bindings`, `/settings`, `/auth`.
