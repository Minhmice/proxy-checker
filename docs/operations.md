# ProxyFleet Operations Manual

## 1. Node Lifecycle Operations

### Inspecting Node Status
- In the dashboard: Navigate to `/nodes` to see live status (`Online`, `Degraded`, `Offline`), public IP, WireGuard IP, and last heartbeat.
- On the worker node via CLI:
  ```bash
  systemctl status proxyfleet-agent
  journalctl -u proxyfleet-agent -f
  ```

### Restarting Services
- Restart agent:
  ```bash
  sudo systemctl restart proxyfleet-agent
  ```
- Restart 3proxy data plane:
  ```bash
  sudo systemctl restart 3proxy
  ```

---

## 2. Configuration Rollback & Desired State

ProxyFleet uses desired-state reconciliation.
1. The controller increments the configuration revision for each change.
2. The agent fetches candidate configurations, validates directives, and writes a temporary configuration file.
3. If `3proxy` fails to reload or starts in an erroneous state, the agent immediately restores `/etc/3proxy/3proxy.cfg.bak` and reports `failed` with the error trace to `/api/fleet/agent/deployment-result`.
4. The dashboard records the failure event in `/events`.

---

## 3. Secret Rotation

1. To rotate proxy credentials:
   - Go to `/nodes/<ID>` or `/proxy-endpoints`.
   - Update username or password.
   - The controller encrypts the new password using AES-256-GCM and increments the revision.
   - The agent fetches the revision and updates `/etc/3proxy/3proxy.cfg`.
2. Existing working proxies remain functional during rotation; failures do not disrupt unaffected endpoints.

---

## 4. Disaster Recovery & Node Replacement

If a worker node is destroyed:
1. Revoke the old node in the dashboard.
2. Spin up a new VPS.
3. Issue a new single-use enrollment token from `/nodes`.
4. Run the installer script on the new VPS. The controller automatically assigns the next available WireGuard IP (`10.77.0.x`).
5. Re-assign proxy endpoints as desired.

---

## 5. Proxy Operations Console (`/proxies`)

The unified `/proxies` console replaces fragmented proxy management with an integrated operations workspace.

### Status Model & Terminology
- **Healthy** (`working`): Proxy is currently usable with a valid exit node or passed latest audit.
- **Regressed** (`regressed`): Formerly usable/verified proxy that has failed its latest check (zombie proxy).
- **Never verified** (`dead`): Unreachable proxy that has never recorded a successful check.
- **Router Pool Tier**: `Active` (top ranked, routable on 9Router), `Reserve` (warm backup), or `—` (unassigned).

### Authentication & Security
- **Session Authentication**: The web dashboard authenticates via `POST /api/auth/login` and receives an `HttpOnly`, `SameSite=Lax` session cookie.
- **Handler-Level Auth Guards**: Sensitive APIs (`/api/proxies/*`, `/api/intelligence/*`, `/api/settings/proxy-export`) enforce authentication directly in their route handlers.
- **No Raw Password in Browser**: Plaintext passwords are not stored in browser storage or transmitted in query parameters.

### Audit & Measurement Capabilities
- **5 Security Scores**: Overall Safety, Transport Security, Privacy, Reputation, Reliability.
- **Explainable Reasoning**: Detailed audit findings with typed reason codes and severity (`critical`, `warning`, `info`).
- **Explicit Probe Statuses**: Probes return `PASS`, `WARN`, `FAIL`, `UNSUPPORTED`, `SKIPPED`, or `ERROR`. Unsupported probes (e.g. UDP on HTTP proxies) do not penalize reliability or mark the proxy as failed.
- **Background Audit Jobs**: Bulk audits execute via worker pools with progress tracking, cancellation support, and restart hydration (`interrupted` status on server restart).

### Safe Import & Export
- **Import Preview**: Parsing and validation preview lines, detected protocols, duplicates, and format errors without mutating SQLite.
- **Privileged Credential Export**: Plaintext credentials are excluded by default. Exporting credentials requires explicit confirmation (`confirmCredentials=yes`) and records a redacted audit log event.
