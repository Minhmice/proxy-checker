# ProxyFleet Production Deployment Guide

## 1. Overview

ProxyFleet runs as a centralized control plane (VPS #1 - Controller) managing remote proxy worker nodes (VPS #2..N - Workers) connected via a dedicated WireGuard private overlay network (`10.77.0.0/24`).

---

## 2. Controller setup

Requirements: Node.js >=22, SQLite persistent storage, WireGuard tools, an available `10.77.0.0/24` overlay subnet and administrator/root privilege for initial tunnel setup. Existing unrelated WireGuard tunnels (such as `omp-pi`) must remain untouched. Private keys and worker tokens need restricted local storage; remote controller traffic needs HTTPS or trusted encrypted transport.

1. In Settings, save ProxyFleet WireGuard controller address `10.77.0.1/24`, owned interface `proxyfleet`, and actual publicly reachable `<host>:51820`. Inspect route conflicts first. The UI refuses other owned names/subnets until IP allocator supports them.
2. Run **Set up owned tunnel** explicitly with administrator/root permission. Do not paste a static `wg0.conf` or adopt a pre-existing interface. Setup must derive the real public key, persist the owned peer configuration and show actual native status. Failed tool/permission/peer checks stay visible; do not treat a generated key as tunnel readiness.
3. For existing workers, select each trusted worker in Settings and invoke explicit peer migration. The controller keeps existing node ID, address and credentials; unselected workers remain unapproved. Check actual handshake, overlay probe and authenticated proxy forwarding before relying on an endpoint. Controller agent liveness is distinct from tunnel/proxy readiness.

No production WireGuard interface was created during development: local Windows process is not elevated; Pi SSH user has no passwordless sudo. Native setup/reboot persistence still requires administrator verification on target hosts.

### Optional external telemetry

Beszel is not required for fleet device/runtime reports. The native agent measures resources directly. If Beszel is separately installed, verify it independently; do not infer that hub health proves tunnel or proxy health.

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
   - Detects kernel and userland separately and chooses a runnable `amd64`, `arm64` or `armv7` binary before replacing the installed executable.
   - Installs `3proxy`, WireGuard tools and nftables, then registers the worker with a one-time token.
   - Renders the actual resolved 3proxy executable into its systemd unit, not literal `${PROXY_BIN}`.
   - Restricts managed proxy ports to loopback and ingress on the owned `proxyfleet` interface.
   - Starts the agent. The agent provisions the approved overlay before applying a new overlay-bound proxy configuration; default proxy limits are not raised automatically.

---

## 4. Verification Checklist

1. **Dashboard Check**: Navigate to `/nodes` on the controller. The new worker node must display as `ONLINE`.
2. **WireGuard Overlay**: Ping `10.77.0.11` from the controller:
   ```bash
   ping -c 3 10.77.0.11
   ```
3. **Endpoint Creation**: On the node details page `/nodes/<ID>`, click **Add Endpoint**. Configure an HTTP CONNECT listener on port `20001`.
4. **Health Check**: Inspect Agent, Configuration, Tunnel and Proxy axes separately. A recorded `Applied` revision is not an authenticated forwarding check. The backend records actual proxy audit results, and unavailable/expired measurements stay unknown/stale.

## 5. Worker Authentication Cutover

Update controller source and the distributed Go binaries together. This release intentionally rejects anonymous agent requests; do not deploy the controller alone and assume old workers will keep polling.

New enrollment returns a node-scoped `agentToken`; the new binary persists it in `/etc/proxyfleet/state.json` with mode `0600`. Existing nodes retain their identity, WireGuard keys, endpoints and `last_revision`; they need a newly provisioned token, not another enrollment.

For each existing worker:

1. Install the matching updated `proxyfleet-agent` binary and stop its service before credential provisioning.
2. From an authenticated administrator session, send `POST /api/fleet/nodes/<NODE_ID>/agent-token`. Save the response's `agentToken` privately; it is returned only once and invalidates any old node token.
3. On the worker, run the new binary with the existing state directory and `--agent-token`, using a temporary shell variable rather than a literal token in shell history:

   ```bash
   sudo systemctl stop proxyfleet-agent
   read -rsp 'Node agent token: ' AGENT_TOKEN; printf '\n'
   sudo /usr/local/bin/proxyfleet-agent --config-dir /etc/proxyfleet --agent-token "$AGENT_TOKEN"
   ```

   Once the agent logs that it is running with the existing node ID, stop the foreground process with Ctrl+C, then run:

   ```bash
   unset AGENT_TOKEN
   sudo systemctl start proxyfleet-agent
   ```

   The one-time provisioning invocation exposes the credential briefly in process arguments to privileged local observers; do not provision on an untrusted host. Do not store the token in a world-readable systemd unit or print the API response in logs.

4. Confirm authenticated heartbeats and a newer desired revision arrive. Missing/incorrect credentials fail closed; a worker missing `agent_token` reports the admin provisioning route instead of silently creating another node.

Controller migration seeds each existing node's desired revision above historical timestamps so agents with timestamp-sized `last_revision` continue receiving changes. Subsequent revisions are durable counters. Never reset `last_revision` or delete the worker state to work around migration.

Transport must use HTTPS or a trusted encrypted WireGuard/Tailscale overlay; node tokens and desired-state proxy passwords must not cross public plaintext HTTP.

## 6. Device/runtime upgrade and removal

Run the matching agent `--diagnostics` for read-only host inspection without controller credentials or privileged network changes. It prints detected hardware/OS/binary architecture and two samples; first CPU/network rate is unknown until a delta exists. Never publish node state files, tokens or WireGuard private keys.

Keep the existing agent state directory when replacing binaries. Deletion through Nodes revokes the node credential and hides its inventory immediately; cleanup may return `202` pending while peer/external references cannot be verified. The pending cleanup view keeps Retry and the last error. The old overlay IP stays reserved until cleanup completes. Deleting a database node cannot uninstall a daemon on an unreachable host. Controller deletion is blocked.

For an isolated application smoke, `APP_DATA_DIR`, `APP_CONFIG_PATH` and `PORT` select separate storage/config/port. Use the same encryption key when seeding and running that isolated instance. These controls do not grant native networking privileges.
