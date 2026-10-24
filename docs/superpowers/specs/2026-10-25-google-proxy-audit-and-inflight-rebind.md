# Google Proxy Pre-Flight Health Check & In-Flight Quota Fallback Spec

> SUPERSEDED — Do not implement this draft. Its Cloud Armor attribution, Google 204 eligibility probe, blanket 403 blacklist, and console-watcher recovery assumptions were not validated. The current design is [Google Cloud Code Proxy Safety and Antigravity Recovery](2026-10-25-google-proxy-audit-and-inflight-rebind-design.md).

## 1. Problem Statement
1. Khi các proxy trong 9Router được kiểm tra thông qua endpoint thông thường (`/api/proxy-pools/:id/test`), chúng chỉ kiểm tra tính kết nối TCP/HTTP cơ bản. Các IP Datacenter (như DigitalOcean London, Singapore) vẫn pass bài test này nhưng bị Google Cloud Armor chặn mã lỗi HTTP 403 Forbidden khi truy cập Google Cloud Code PA (`daily-cloudcode-pa.googleapis.com` / `cloudcode-pa.googleapis.com`).
2. Hậu quả: Tài khoản Antigravity khi bị gán nhầm vào proxy này sẽ bị khóa tính năng quota (`Antigravity quota API access forbidden. Chat may still work.`) và khi stream sinh mã sẽ dính lỗi `[403]: Forbidden`, khiến 9Router kích hoạt khóa model 120s (`modelLock_gemini-3.8-flash-high for 120s`).

## 2. Requirements & Architecture
### A. Google Pre-Flight Health Check
- Mỗi proxy trước khi đưa vào nhóm gán cho Antigravity phải được probe trực tiếp tới Google Cloud Code / 204 endpoint.
- Nếu trả về HTTP 403 Forbidden: gắn cờ `googleBlocked: true`.
- Module `antigravityRotator` chỉ lấy các proxy có `googleBlocked !== true`.

### B. In-Flight Quota Fallback (Runtime Re-bind)
- Lắng nghe sự kiện real-time qua SSE `/api/translator/console-logs/stream`.
- Khi bắt được log tài khoản bị 403:
  1. Đánh dấu proxy đang gán cho tài khoản đó vào danh sách đen `googleBlocked`.
  2. Tự động đổi proxy của tài khoản sang proxy sạch khác.
  3. Kích hoạt tài khoản dự phòng thay thế ngay lập tức để không gián đoạn luồng làm việc.
