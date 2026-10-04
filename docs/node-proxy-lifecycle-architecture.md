# Node & Proxy Lifecycle Architecture: From VPS to Spawned Proxies

Tài liệu này tổng hợp toàn bộ hiện trạng UX, Backend APIs, Database models, Data Plane (3proxy) và cơ chế hình thành **Pool proxy riêng biệt (Node-Spawned Proxy Pool)** từ các máy VPS / Router kết nối vào Proxy Control Dashboard.

---

## 1. Tổng quan Luồng (End-to-End Flow)

```text
[ Người dùng / Admin ]
        │
        ├─ 1. Cung cấp VPS info (IP, Port, User, Pass)
        │     │
        │     ▼
        ├─ [ Controller UX: /nodes ]
        │     ├─ Sinh Enrollment Token (POST /api/fleet/enrollment-tokens)
        │     └─ Cung cấp lệnh tự động: curl -fsSL ... | sudo bash
        │
        ├─ 2. VPS Worker thực thi Installer (install-agent.sh)
        │     ├─ Nhận diện CPU (amd64, arm64, armv7) & OS (Ubuntu, Debian, Raspbian)
        │     ├─ Tải binary Go agent (proxyfleet-agent)
        │     ├─ Đăng ký Node vào Controller (POST /api/fleet/enroll)
        │     ├─ Nhận WireGuard IP (10.77.0.x) & Public Key
        │     └─ Kích hoạt systemd: 3proxy.service & proxyfleet-agent.service
        │
        ├─ 3. Tạo Proxy Endpoints (2 Proxies mỗi Node)
        │     ├─ Gọi API: POST /api/fleet/endpoints (Port 20001 HTTP, Port 20002 SOCKS5)
        │     ├─ Controller mã hóa AES-256-GCM mật khẩu, tăng revision
        │     ├─ Agent tự động poll Desired State (mỗi 15s)
        │     └─ Render /etc/3proxy/3proxy.cfg -> Reload 3proxy -> Mở port trên 10.77.0.x
        │
        └─ 4. Gom vào "Node-Spawned Proxy Pool"
              ├─ Định danh nguồn gốc: source = 'proxyfleet' (tách rời 9Router)
              ├─ Bảo mật SSRF: Cho phép quét nội bộ 10.77.0.0/24
              ├─ Đo kiểm tra trễ & IP Egress thực tế qua Safety Auditor
              └─ Xuất định dạng chuẩn: http://user:pass@10.77.0.x:port
```

---

## 2. Phần 1: Từ VPS (IP, Username, Password) thành Node

Hiện tại quy trình biến một máy chủ Linux thô thành Node trong hệ thống gồm:

### 2.1. Phía UX Dashboard (`/nodes`)
- **Giao diện bảng danh sách nodes:** Hiển thị Tên máy, Vai trò (`Controller + Worker` hoặc `Worker`), Trạng thái (`online`, `offline`), IP WireGuard (`10.77.0.x`), CPU/OS và thời gian Heartbeat gần nhất.
- **Modal "Enroll Worker Node":** 
  - Người dùng nhập tên node mong muốn (VD: `worker-vps-02`).
  - Giao diện sinh ra một **One-time Enrollment Token** có thời hạn (mặc định 15 phút, lưu hash SHA-256 trong database).
  - Tự động tạo câu lệnh cài đặt rút gọn 1 dòng:
    ```bash
    curl -fsSL http://<CONTROLLER_IP>:1300/install-agent.sh | sudo bash -s -- \
      --server http://<CONTROLLER_IP>:1300 \
      --token <ENROLLMENT_TOKEN> \
      --node-name "<NODE_NAME>"
    ```

### 2.2. Phía Backend API
1. **`POST /api/fleet/enrollment-tokens`**:
   - Xác thực: Basic Auth (`CONTROL_PASSWORD`).
   - Input: `{ "nodeName": "worker-002", "ttlMinutes": 15 }`.
   - Output: `{ "token": "flt_...", "expiresAt": 179... }`.
2. **`POST /api/fleet/enroll`**:
   - Được gọi bởi chính Go Agent trên VPS worker khi boot.
   - Input: Token, NodeName, WireguardPublicKey, OS, Arch, AgentVersion.
   - Backend kiểm tra hash token, cấp phát IP WireGuard tiếp theo (VD: `10.77.0.11`, `10.77.0.12`), lưu node vào bảng `fleet_nodes` với trạng thái ban đầu `online`.
3. **`GET /api/fleet/nodes` & `GET /api/fleet/nodes/:id`**:
   - Trả về danh sách nodes, lọc theo status, chi tiết phần cứng và các proxy endpoints trực thuộc.

### 2.3. Quy trình tự động hóa nếu dùng SSH (IP, User, Pass)
Khi có sẵn SSH `ip`, `username`, `password`:
- Không cần người dùng gõ lệnh bằng tay trên VPS.
- Backend/Script SSH trực tiếp vào máy đích qua Paramiko / SSH client.
- Chạy lệnh cài đặt `install-agent.sh`.
- Controller Host (`netnut2026`, `10.77.0.1`) tự động bootstrap node ID `controller-node-master` ngay khi khởi động (`role: "controller-worker"`), không cần bước enroll.

---

## 3. Phần 2: Từ Node Sinh Ra Proxies (Spawn 2 Proxies / Node)

Mỗi Node đại diện cho một máy chủ mạng có kết nối Internet. Để trích xuất khả năng proxy, hệ thống tạo ra các **Proxy Endpoints** cục bộ trên dải overlay `10.77.0.0/24`.

### 3.1. Thiết kế 2 Proxies mặc định cho mỗi Node
- **Proxy 1: HTTP CONNECT Proxy**
  - Cổng: `20001`
  - Địa chỉ: `10.77.0.x:20001`
  - Giao thức: `http` (HTTP CONNECT tunnel)
  - Xác thực: `username` + `password` riêng biệt
- **Proxy 2: SOCKS5 Proxy**
  - Cổng: `20002`
  - Địa chỉ: `10.77.0.x:20002`
  - Giao thức: `socks5` (hỗ trợ cả TCP & UDP associate)
  - Xác thực: `username` + `password` riêng biệt

### 3.2. Backend APIs điều khiển Endpoint
1. **`POST /api/fleet/endpoints`**:
   - Payload:
     ```json
     {
       "nodeId": "c3670b4a-1024-496c-b89e-1f93f887ab27",
       "protocol": "http",
       "listenIp": "10.77.0.11",
       "listenPort": 20001,
       "username": "user_node1_http",
       "password": "strong_random_password"
     }
     ```
   - Xử lý: Mật khẩu được mã hóa bằng AES-256-GCM qua `src/proxyfleet/security.ts`. Tạo bản ghi trong `fleet_proxy_endpoints`. Tăng `current_revision` của cấu hình.
2. **`POST /api/fleet/endpoints/:id/credentials/reveal`**:
   - Yêu cầu mật khẩu quản trị (`CONTROL_PASSWORD`).
   - Giải mã mật khẩu lưu trữ và hiển thị cho người vận hành.
3. **`GET /api/fleet/agent/desired-state?nodeId=...`**:
   - Go Agent trên VPS worker gọi API này định kỳ (mỗi 15s).
   - Nếu `revision > lastRevision`: Agent tải toàn bộ danh sách endpoints hợp lệ của máy mình.

### 3.3. Dưới VPS Worker (Data Plane 3proxy)
- Agent nhận JSON và tự động render file `/etc/3proxy/3proxy.cfg`:
  ```ini
  # Generated by proxyfleet-agent. DO NOT EDIT DIRECTLY.
  nserver 1.1.1.1
  nserver 8.8.8.8
  nscache 65536
  timeouts 1 5 30 60 180 1800 15 60

  users user_node1_http:CL:strong_pass1 user_node1_socks:CL:strong_pass2
  auth strong

  allow user_node1_http
  proxy -p20001 -i10.77.0.11
  flush

  allow user_node1_socks
  socks -p20002 -i10.77.0.11
  flush
  ```
- Agent thực hiện reload 3proxy (`systemctl reload-or-restart 3proxy`).
- **An toàn mạng:** 3proxy chỉ bind vào IP WireGuard `10.77.0.x`, firewall `nftables` chặn toàn bộ truy cập cổng 20000-39999 từ card mạng Internet công cộng (`eth0`), đảm bảo proxy không bao giờ bị lộ ra ngoài Internet để bị scan/abuse.

---

## 4. Phần 3: Pool Riêng Biệt cho Node Proxies ("Node-Spawned Pool")

Hệ thống có 2 nguồn proxy tách biệt nhau hoàn toàn:
1. **9Router Pool (`source: "9router"`):** Proxy mua ngoài / import từ hệ thống AI 9Router, cần test sống chết, rank độ trễ và loại bỏ proxy die.
2. **Node-Spawned Pool (`source: "proxyfleet"`):** Proxy do chính hạ tầng VPS của bạn tạo ra và làm chủ egress IP.

### 4.1. Cấu trúc Adapter & Đồng bộ Pool
File `src/proxyfleet/pipeline-adapter.ts` cung cấp hàm cầu nối:
- `syncFleetEndpointsToIntelligence(fleetRepo, intelRepo)`:
  - Lấy tất cả endpoint đang bật (`enabled: true`) từ bảng `fleet_proxy_endpoints`.
  - Giải mã mật khẩu tương ứng.
  - Chuẩn hóa thành chuỗi:
    ```text
    http://user_node1_http:pass1@10.77.0.11:20001
    socks5://user_node1_socks:pass2@10.77.0.11:20002
    http://ctrl_user:ctrl_pass@10.77.0.1:20002
    ```
  - Nạp vào bảng `proxy_intelligence` với `source = 'proxyfleet'`.

### 4.2. Khác biệt khi đo kiểm và Audit
- Proxy ngoài (`9router`) bị cấm trỏ vào IP nội bộ (chống SSRF).
- Proxy từ Node (`proxyfleet`) được gắn cờ `allowedPrivateIps: ["10.77.0.0/24"]` cho phép Safety Auditor kết nối qua đường hầm WireGuard để kiểm tra:
  - Cổng có mở không?
  - Xác thực user/pass đúng không?
  - **Egress IP thực tế ra Internet là gì?** (Kiểm tra xem proxy có đi đúng qua card mạng của VPS đó không, hay bị rò rỉ qua VPS khác).
  - Độ trễ phản hồi (latency ms).

---

## 5. Tóm tắt Database Model Hiện Có

```text
┌────────────────────────────────────────────────────────┐
│                      fleet_nodes                       │
├────────────────────────────────────────────────────────┤
│ id (TEXT PK)                                           │
│ name (TEXT)                                            │
│ role (TEXT: 'controller-worker' | 'worker')            │
│ status (TEXT: 'online' | 'offline' | 'degraded')       │
│ public_ip (TEXT NULL)                                  │
│ wireguard_ip (TEXT UNIQUE, e.g. 10.77.0.1, 10.77.0.11) │
│ os, arch, agent_version                                │
│ last_heartbeat_at (INTEGER)                            │
└──────────────────────────┬─────────────────────────────┘
                           │ 1
                           │
                           │ N
┌──────────────────────────▼─────────────────────────────┐
│                 fleet_proxy_endpoints                  │
├────────────────────────────────────────────────────────┤
│ id (TEXT PK)                                           │
│ node_id (TEXT FK -> fleet_nodes.id)                    │
│ protocol (TEXT: 'http' | 'socks5')                     │
│ listen_ip (TEXT, e.g. 10.77.0.1)                       │
│ listen_port (INTEGER, e.g. 20001, 20002)               │
│ username (TEXT)                                        │
│ credential_ref (TEXT)                                  │
│ enabled (INTEGER 1/0)                                  │
│ current_revision (INTEGER)                             │
└──────────────────────────┬─────────────────────────────┘
                           │ 1
                           │
                           │ 1
┌──────────────────────────▼─────────────────────────────┐
│                fleet_proxy_credentials                 │
├────────────────────────────────────────────────────────┤
│ id (TEXT PK)                                           │
│ endpoint_id (TEXT FK)                                  │
│ username (TEXT)                                        │
│ encrypted_password (TEXT - AES-256-GCM)                │
│ salt (TEXT)                                            │
└────────────────────────────────────────────────────────┘
```

---

## 6. Đề xuất các bước tiếp theo khi cần mở rộng UI

1. **Thêm nút "Batch Spawn (2 Proxies)" trên trang Node (`/nodes/[id]`):**
   - 1 click tự động tạo luôn 1 HTTP port `20001` + 1 SOCKS5 port `20002` với mật khẩu ngẫu nhiên cho node đó.
2. **Trang chuyên biệt "Node Proxy Pool" (`/proxies/fleet`):**
   - Chỉ hiển thị các proxy do chính nodes sinh ra.
   - Nút **"Export Working List"** để copy nhanh toàn bộ danh sách `http://user:pass@10.77.0.x:port` hoặc IP công cộng tương ứng đưa vào các bot/tool cào dữ liệu.
3. **Thêm API SSH Auto-Provision:**
   - Người dùng chỉ cần paste danh sách `IP:Port:User:Pass`, backend tự kết nối SSH và chạy script enroll biến VPS thành node và spawn ngay 2 proxy.
