# ProxyFleet Production Deployment Guide

## 1. Overview

ProxyFleet runs as a centralized control plane (VPS #1 - Controller) managing remote proxy worker nodes (VPS #2..N - Workers) connected via a dedicated WireGuard private overlay network (`10.77.0.0/24`).

---

## 2. Controller VPS Setup (VPS #1)

### Requirements
- Ubuntu 24.04 or 22.04 LTS
- Node.js >= 22.0.0
- WireGuard (`wireguard`, `wireguard-tools`)
- PostgreSQL 16 (or local persistent storage)
- Reverse proxy (Caddy or Nginx) with HTTPS
- Beszel Hub (:8090)

### Step 1: WireGuard Hub Configuration
1. Generate keypair:
   ```bash
   umask 077
   wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key
   ```
2. Create `/etc/wireguard/wg0.conf`:
   ```ini
   [Interface]
   Address = 10.77.0.1/24
   ListenPort = 51820
   PrivateKey = <CONTROLLER_PRIVATE_KEY>
   ```
3. Enable and start:
   ```bash
   systemctl enable --now wg-quick@wg0
   ```

### Step 2: Beszel Hub Installation
Install and run Beszel Hub binary or systemd service on `127.0.0.1:8090`:
```bash
# Binary install
curl -sL "https://github.com/henrygd/beszel/releases/latest/download/beszel_$(uname -s)_$(uname -m).tar.gz" | tar -xz -C /usr/local/bin beszel
```

### Step 3: Controller Service Setup
1. Clone repository to `/opt/proxyfleet`:
   ```bash
   git clone <REPO_URL> /opt/proxyfleet
   cd /opt/proxyfleet
   npm ci
   npm run build
   ```
2. Install systemd service from `deploy/systemd/proxy-control-dashboard.service`:
   ```bash
   cp deploy/systemd/proxy-control-dashboard.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now proxy-control-dashboard
   ```
3. Verify status:
   ```bash
   curl -I http://127.0.0.1:1300/api/health
   ```

---

## 3. Worker Node Setup (VPS #2)

### Automated Single-Command Installation
1. From the Controller Dashboard, go to `/nodes` and click **Enroll Worker**. Enter a node name (e.g. `worker-001`) to generate an enrollment token.
2. Run the generated command on the worker VPS as root:
   ```bash
   curl -fsSL https://<CONTROL_DOMAIN>/install-agent.sh | sudo bash -s -- \
     --server https://<CONTROL_DOMAIN> \
     --token <ENROLLMENT_TOKEN> \
     --node-name "worker-001"
   ```
3. The installer automatically:
   - Detects architecture (`amd64`, `arm64`, `armv7`).
   - Installs `3proxy`, `wireguard`, `nftables`, `jq`, `curl`.
   - Downloads and installs `proxyfleet-agent`.
   - Generates local WireGuard keys and registers with the controller.
   - Restricts proxy ports (20000-39999) to the WireGuard subnet (`10.77.0.0/24`).
   - Enables and starts `3proxy.service` and `proxyfleet-agent.service` under systemd.

---

## 4. Verification Checklist

1. **Dashboard Check**: Navigate to `/nodes` on the controller. The new worker node must display as `ONLINE`.
2. **WireGuard Overlay**: Ping `10.77.0.11` from the controller:
   ```bash
   ping -c 3 10.77.0.11
   ```
3. **Endpoint Creation**: On the node details page `/nodes/<ID>`, click **Add Endpoint**. Configure an HTTP CONNECT listener on port `20001`.
4. **Health Check**: Verify that `proxyfleet-agent` deploys the configuration to `/etc/3proxy/3proxy.cfg` and reports `healthy`.
