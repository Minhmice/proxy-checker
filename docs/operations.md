# ProxyFleet Operations Manual

## 1. Node Lifecycle Operations

### Inspecting Node Status
- In the dashboard: Navigate to `/nodes` to see live status (`Online`, `Degraded`, `Offline`), public IP, WireGuard IP, and last heartbeat.
- Worker status becomes `Offline` after 60 seconds without a heartbeat; list, detail and status filters use the same server-derived status. The controller inventory node represents the live controller server.
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

## 2. Configuration Convergence & Deployment History

ProxyFleet decouples agent connection liveness from configuration convergence:
1. **Dual-Axis Status Model**:
   - **Agent Liveness**: `Online` / `Offline` derived from authenticated HTTP heartbeat (`last_heartbeat_at < 60s`), not proof of a WireGuard handshake. Deployment failures never mark an agent offline or disrupt heartbeat reporting.
   - **Configuration Convergence**: `Applied` (matches desired revision), `Pending` (newer target revision outstanding), `Failed` (deployment failure or rollback with stored error), or `Unknown` (legacy nodes with no historical deployment reports).
2. **Monotonic Revision Watermarks & Ordering**:
   - The controller enforces monotonic revision progression: reports older than the node's latest deployment watermark are acknowledged but rejected (`stale_revision`) without altering current state. Duplicate reports are acknowledged without inserting duplicate history.
   - At the same revision, an `applied` report supersedes a prior `failed` report (agent retry), but delayed failures cannot overwrite recorded success.
3. **Persistent Report Delivery**:
   - The agent persists unacknowledged deployment reports in `state.json` (`pending_report`). If the controller is unreachable or returns a server error, the agent retries delivery on subsequent cycles until acknowledged, preventing lost success or rollback reports across network partitions and restarts.
4. **Audit Trail**:
   - Each accepted deployment result writes an append-only record in `fleet_deployments` and records a lifecycle event in `fleet_events`. Operators can view recent convergence events and error alerts directly in `/nodes/[id]`.
---

## 3. Secret Rotation

1. To rotate proxy credentials:
   - Go to `/nodes/<ID>` or `/proxy-endpoints`.
   - Update username or password.
   - The controller encrypts the new password using AES-256-GCM and increments the revision.
   - The agent fetches the revision and updates `/etc/3proxy/3proxy.cfg`.
2. Existing working proxies remain functional during rotation; failures do not disrupt unaffected endpoints.

### Worker Authentication

- Enrollment consumes a one-time token and returns `agentToken` once. The agent stores it as `agent_token` in its restrictive state file; the controller stores only its SHA-256 hash.
- Heartbeat, desired-state and deployment-result require `Authorization: Bearer <agentToken>` scoped to the requested node. Dashboard credentials and node IDs alone are not worker authorization.
- Administrators rotate or provision a node token using authenticated `POST /api/fleet/nodes/<ID>/agent-token`. The response is `{nodeId, agentToken}`; rotation immediately invalidates the previous credential.
- Token rotation preserves node identity, endpoints and desired revision. Install the new token on the existing agent with `--agent-token`; see the deployment cutover instructions.
- Use HTTPS or a trusted encrypted overlay for enrollment and worker traffic. Never log tokens, paste them into issue reports, or send them over public plaintext HTTP.

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

### Manual Connectivity Checks

- `POST /api/proxies/check` tests the linked 9Router pool on the backend. Each completed proxy result writes one history record and updates verdict, counters and current check time in the same SQLite transaction.
- Unlinked proxies return `409` with instructions to push them to 9Router. Reported upstream transport failures and request failures return `502`. Neither case changes proxy health or creates a failed proxy-history entry.
- A failed proxy test clears current latency rather than retaining a stale successful measurement; its observed latency and failure reason remain in history. A successful test clears the prior error.
- `GET /api/proxies/history` returns the newest ten checks, including `errorMessage`. IP/ISP/UDP measurements unavailable from the connectivity test are not fabricated; UDP is `Unknown`, displayed as `UDP not measured`.

### Safe Import & Export
- **Import Preview**: Parsing and validation preview lines, detected protocols, duplicates, and format errors without mutating SQLite.
- **Privileged Credential Export**: Plaintext credentials are excluded by default. Exporting credentials requires explicit confirmation (`confirmCredentials=yes`) and records a redacted audit log event.


### In-App Operations Help & Navigation

- The `/help` route provides an inline operational runbook covering proxy health definitions, 409/502 recovery procedures, pool synchronization concurrency, Antigravity session-only rotation rules, and worker service troubleshooting commands (`systemctl status proxyfleet-agent`, `journalctl -u proxyfleet-agent -f`).
- Secondary routes without active backend implementations (`/scraping`, `/cdk`, `/invoice`, `/referral`, `/reseller`, `/wallet`) render an honest un-implemented notice with dedicated escape navigation back to `/` (Overview) and `/proxies`.
- Control plane UI labels and actions across all management surfaces are standardized to English while preserving backend technical identifiers and data contracts.
---

## 6. Antigravity Account Rotation Policy

- **Metric Evaluated**: Automatic rotation evaluates **Gemini session quota only**. Claude, GPT, and weekly Gemini quotas are ignored for activation and deactivation decisions.
- **Exhaustion Threshold**: Accounts with Gemini session quota `<= antigravitySessionThreshold` (default `20%`) or an active `lastError` are deactivated.
- **Reserve Activation Threshold**: Reserve accounts are eligible for activation only when Gemini session quota is `> antigravitySessionThreshold`.
- **Reserve Priority**: Eligible reserves are ordered by earliest valid `resetAt` remaining time. Accounts with missing or invalid reset timestamps sort last, with account ID as a deterministic tie-breaker.
- **Proxy Integrity**: Existing healthy proxy assignments are preserved during routine rotation. Reassignment only occurs when a proxy is missing or dead, and snapshot state reports a new proxy only after 9Router acknowledges the update.
- **In-Flight Re-runs**: Concurrent rotation requests coalesce into the active cycle; if limits change while a cycle is running, rotation automatically executes a follow-up cycle so callers receive a snapshot reflecting current settings.

## Controlled Per-node Capacity Measurement

Do not infer device architecture from an operator-assigned name. Read-only inspection on the current worker identified **Raspberry Pi 5 Model B Rev 1.0**, Linux `aarch64`, 64-bit userland, despite the inventory name containing `arm7`.

Before tuning limits, inspect the actual service:

```bash
systemctl show 3proxy -p ActiveState -p SubState -p Result -p ExecMainStatus -p LimitNOFILE
systemctl cat 3proxy
```

An observed `203/EXEC` with literal `ExecStart=${PROXY_BIN}` is a service-generation failure, not exhausted node capacity. The installer must render the resolved executable path into the unit. Changing the installed service requires administrator privileges; do not repeatedly increase limits or reboot to hide this failure.

### Verified forwarding and benchmark boundaries

Authenticated HTTP CONNECT and SOCKS5 each completed 8/8 HTTPS requests through an isolated Pi instance. The verification target was reachable only through Pi-side forwarding; direct access from the benchmark host was rejected. This proves protocol forwarding, not a production throughput ceiling or WireGuard performance.

An earlier comparison of artificial `maxconn=2` and `maxconn=16` used a locally reachable target before the HTTPS-agent tunnel path was corrected. Those timings are not valid evidence of a capacity improvement and are intentionally not published here. Rerun identical workloads through the corrected benchmark against a controlled proxy-only target before tuning production limits. Record actual memory, descriptor, throughput, p95 latency and error counts; keep the last working configuration. Creating extra endpoints on one egress does not create bandwidth or public IPs.

Use `BENCHMARK_PROXY_URL` for credentials and an explicit HTTPS target with `--confirm-required`; never put proxy passwords into command-line arguments or disable TLS verification. An explicit connection ceiling is configuration, not measured hardware capacity. Unknown service descriptor/memory budget must not be presented as a safe recommendation.
