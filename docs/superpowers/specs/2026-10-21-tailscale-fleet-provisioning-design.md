# Tailscale Fleet Provisioning Design

## Status and approved requirements

User approved option A: standard SSH over an existing Tailscale network; no separate WireGuard overlay for new workers. User approved both public-IP checks: match expected public IP when supplied, and prevent duplicate active-worker egress. On failure, warn and retain the node with proxy activation disabled. This document records implementation decisions for review; no application implementation is authorized by the planning request.

## Operator flow

1. Enter Tailscale IPv4, SSH username/password and optional expected public IPv4. Node name defaults from authenticated remote hostname; SSH port defaults to 22 and controller URL is prefilled from server configuration, editable only when necessary.
2. Inspect SSH host fingerprint without sending a password. Show fingerprint for operator confirmation against trusted host information. Reconnect with that exact SHA256 fingerprint pinned before password authentication. Changed fingerprints stop login; never silently re-trust.
3. Create or reuse an inventory row uniquely bound to the Tailscale address, initially disabled. Authenticate, inspect remote identity/platform/permissions, verify the supplied address belongs to that host, and discover its direct public IPv4 over HTTPS.
4. Persist warning and stop before installing listeners if lookup fails, expected IP differs, or IP duplicates an activated worker. Keep the node and credentials available for explicit retry.
5. For eligible hosts, bootstrap the existing Go agent and 3proxy using Tailscale addresses, initially without active endpoints. Reserve activation in a SQLite transaction that rechecks the duplicate condition. Auto-activate on successful first provisioning; recovery after any warning requires explicit Verify & Activate.
6. When endpoints are requested, deploy only to the pinned Tailscale address. Verify actual authenticated forwarding through HTTP and SOCKS5 endpoints in the backend before publishing them to pools/router. Actual proxy exit must equal the verified direct public IPv4 and any supplied expectation. Failure disables the node/endpoints and withdraws published references; no deletion.

## Platform contract

Controller remains supported on Windows or Linux. Use `ssh2` in Node, plus its TypeScript declarations, because Node stdlib has no password SSH implementation. No shell password arguments, `sshpass`, browser SSH, or Tailscale SSH impersonation.

Worker bootstrap follows current real installer support: Debian/Raspbian/Ubuntu-style Linux with systemd, nftables, and amd64/arm64/armv7 userland. Probe before changing services; report unsupported hosts disabled, not falsely installed. Existing Windows agent development execution remains usable; do not advertise automatic Windows/OpenWrt provisioning without implementing their service managers. Tailscale and regular sshd must already be configured; no tailnet enrollment keys or Tailscale installation are introduced.

## Persistent state and API

- Keep existing `public_ip` as the observed public IPv4; do not add a second observed-IP field.
- Add `tailscale_ip` (unique, nullable for controller/legacy nodes), `expected_public_ip` (nullable), `public_ip_status`, `public_ip_checked_at`, `proxy_activation` and bounded activation reason.
- Public-IP status: `unknown`, `verified`, `expected_mismatch`, `duplicate`, `lookup_failed`.
- Provision status: `pending`, `installing`, `ready`, `failed`; durable error text is sanitized.
- SSH credentials and pinned fingerprint live in a node-owned table with cascading delete. Encrypt password using existing authenticated encryption; require a configured non-default fleet encryption key before accepting credentials. Public API exposes only `credentialsSet` and fingerprint.
- Admin operations: inspect SSH fingerprint, provision/retry node, verify-and-activate node, disable node. No API accepts a browser-supplied observed IP as proof.
- Node liveness (`online/offline/degraded`) remains separate from activation. An online node may be disabled; an offline node retains its activation reservation until explicitly disabled, preventing NAT duplication during transient loss.
- Endpoint rows are retained on warning and stored disabled. A direct `enabled: true` endpoint patch cannot override disabled node state.

## Public-IP rules

- Use IPv4 explicitly for direct lookup and through-proxy audit; validate as global unicast IPv4. Reject private, loopback, link-local, multicast, reserved/test-network and Tailscale addresses as public observations/expectations.
- Direct lookup runs on the SSH host, never controller egress and never Tailscale peer endpoint metadata. Disable proxy environment variables for the direct request. Bound TLS-verified requests, redirects, output size and duration; use fixed allowlisted HTTPS targets, not arbitrary browser URLs.
- Optional expected IP is exact IPv4, not CIDR. Without it, the directly observed IP becomes the comparison baseline for proxy forwarding; uniqueness still applies.
- Duplicate means equal observed IPv4 of another non-removing worker with activation enabled. Only new/recovering conflicting node is blocked; never evict an already-active owner. Two concurrent activations are serialized by SQLite's immediate transaction/conditional uniqueness, not by a global runtime mutex.
- When an active worker changes IP, fails lookup, mismatches expectation, or fails actual forwarding verification: disable immediately in DB, increment desired revision, send empty desired listeners, exclude from sync/pool selection, unbind router references through existing backend cleanup, and retain the warning. Unreachable remote host removal cannot be claimed; pending withdrawal remains visible.
- Automatic first provisioning activation is allowed only after direct verification and successful bootstrap. Explicit recovery requires fresh verification; a heartbeat alone never clears warnings or enables proxies.
- Rechecks/audits belong to existing unified sync maintenance. Do not create a separate scheduler or serialize router sync and account rotation.

## SSH and installer boundaries

Use fixed remote commands and validated inputs; stream configuration/tokens through SSH stdin or SFTP files with mode 0600. Never place secrets in command arguments, returned URLs, journal unit arguments, local storage or error logs. SSH and sudo authentication are distinct: allow root or non-interactive sudo, otherwise retain disabled node with actionable permission error; do not assume SSH password equals sudo password.

Verify host identity and worker-to-controller reachability before service mutations. Agent can reach controller via configured Tailscale URL. Verify binary checksum from controller and correct userland architecture before replacement. Bootstrap retries reuse node identity and credentials; they cannot create a second enrollment/node. Controller restart mid-provision leaves durable failed/pending disabled state and requires explicit resume.

Firewall admits managed proxy ports only on tailscale0 from authorized controller/router Tailscale addresses and loopback. Route consumers such as 9router must join or route through the tailnet; a controller-only successful request does not prove 9router reachability. Never open listeners on public 0.0.0.0. Preserve unrelated firewall tables and Tailscale services.

## Migration and historical cleanup

Migrate every active fleet caller: enrollment, desired state, DB validation, agent saved state/client structs, telemetry labels, dashboard nodes/detail/monitoring/endpoints/help/settings, installer/systemd, pipeline and docs. Use tailscale_ip in public active contracts; no `wireguardIp` alias for a Tailscale address.

Existing WireGuard worker rows cannot acquire invented Tailscale addresses. Preserve identity, encrypted endpoint credentials, deployment/event history; mark migration-required and disable routing until operator supplies verified transport. Keep controller inventory protected and operational; nullable tailscale_ip is not a reason to delete it or forbid its existing local operation.

Retain WireGuard tombstone data and narrowly scoped owned-peer cleanup for historical removals, including absence verification. Do not erase historical peer reservations or touch unrelated tunnel omp-pi. Remove active WireGuard setup UI, reconciliation and enrollment paths after caller migration; historical cleanup is not a compatibility enrollment mode. Never uninstall Tailscale during decommission. This scope does not add a new remote host-uninstall product; keep UI truthful about controller removal versus host services.

## Acceptance evidence

1. Provision real disposable Tailscale/SSH Linux worker; pin key, detect architecture/public IP, install, retain one inventory identity across retry, authenticated HTTP and SOCKS5 forwarding work over tailnet.
2. Expected mismatch, duplicate, malformed/failed IP lookup, SSH/key/permission/bootstrap failure: node remains listed, disabled, no routing/pool publication. An existing active duplicate owner stays active.
3. Existing active-IP change revokes endpoint serving configuration and router eligibility; direct endpoint mutation cannot bypass gate. Two SQLite handles racing same IP cannot both activate.
4. Whole affected TS/Go modules pass, full npm suite/typecheck/lint/build pass; actual UI keyboard/password clearing and warning/retry transitions inspected in browser.
5. Isolated restart/migration preserves identity, controller and cleanup reservations. Unrelated Tailscale/omp-pi/firewall state unchanged. Live hosts are never changed without explicit execution approval and verified target.

## Non-goals

No Tailscale installation/tailnet administration, no public proxy exposure, no new independent scheduler, no automatic selection/rotation by IP, no auto-delete on failure, no new remote-uninstall subsystem. IPv6-only worker support requires a separate product decision; current worker/lookup behavior is IPv4-based.
