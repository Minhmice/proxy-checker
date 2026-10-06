# ProxyFleet Architecture Specification

## 1. System Overview

ProxyFleet extends the existing `minhmiceProxy` Next.js proxy control dashboard into a centralized proxy infrastructure management platform, controlling remote Ubuntu proxy nodes (and future ImmortalWrt/OpenWrt routers) via a lightweight Go agent, WireGuard private overlay network, 3proxy data-plane, and Beszel hardware monitoring.

```text
                     PROXY CONTROL / PROXYFLEET
                              VPS #1
                               24/7
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
   Next.js Dashboard       Controller API          Beszel Hub
   (:1300 via Caddy)       (/api/fleet/*)          (:8090)
        │                       │                        │
   PostgreSQL / DB         Agent Control             Monitoring
   (fleet tables)          (desired state)               │
        │                       │                        │
   9Router integration     WireGuard Hub (wg0)           │
   (pool ranker/auditor)   (10.77.0.1/24)                │
        │                       │                        │
        └───────────────────────┼────────────────────────┘
                                │
                         Private WG network (UDP 51820)
                                │
                    ┌───────────▼───────────┐
                    │       VPS #2          │
                    │    Proxy Worker       │
                    │                       │
                    │ proxyfleet-agent (Go) │
                    │ 3proxy (data-plane)   │
                    │ beszel-agent          │
                    │ WireGuard (10.77.0.11)│
                    │ nftables              │
                    │ iproute2              │
                    └───────────┬───────────┘
                                │
                              WAN
                                │
                            Internet
```

## 2. Separation of Concerns

- **Data-Plane**: `3proxy` exclusively handles proxy network traffic (HTTP CONNECT and SOCKS5). No custom SOCKS/HTTP implementations.
- **Node Control-Plane**: `proxyfleet-agent` (written in Go) manages local systemd services, desired-state 3proxy config generation, atomic reloads, rollback on error, policy routing, and layered health telemetry.
- **Fleet Control-Plane**: Next.js controller API and Dashboard manage node inventory, proxy endpoint definitions, desired configuration revisions, enrollment tokens, health aggregation, and integration with 9Router and the Safety Auditor.
- **Infrastructure Monitoring**: `Beszel` monitors CPU, RAM, Disk, Load, and Host Network metrics. `proxyfleet-agent` avoids duplicating host OS metrics and focuses strictly on proxy health, egress IP, and latency.

## 3. Data Model & Database Schema

The existing SQLite storage (`data/proxies.sqlite3`) and JSON files (`data/settings.json`, `data/pool-state.json`) are preserved for full backward compatibility. Fleet infrastructure state is housed in a durable relational schema (PostgreSQL for production; abstracted via a clean repository layer):

### Tables:
1. `fleet_nodes`: `id` (UUID), `name`, `status` (`online`, `offline`, `degraded`), `public_ip`, `wireguard_ip`, `os`, `arch`, `agent_version`, `created_at`, `updated_at`.
2. `fleet_node_interfaces`: `id`, `node_id` (FK), `name` (e.g. `eth0`), `mac_address`, `ipv4_address`, `ipv6_address`, `is_default`, `status`.
3. `fleet_egresses`: `id`, `node_id` (FK), `interface_id` (FK), `name`, `source_ip`, `gateway_ip`, `routing_table_id`, `expected_public_ip`.
4. `fleet_proxy_endpoints`: `id`, `node_id` (FK), `protocol` (`http`, `socks5`), `listen_ip`, `listen_port`, `egress_id` (FK), `username`, `credential_ref`, `enabled`, `current_revision`, `created_at`, `updated_at`.
5. `fleet_proxy_credentials`: `id`, `endpoint_id` (FK), `username`, `encrypted_password`, `salt`, `rotated_at`.
6. `fleet_node_heartbeats`: `id`, `node_id` (FK), `wireguard_handshake_at`, `cpu_usage`, `memory_usage`, `active_proxies_count`, `received_at`.
7. `fleet_health_checks`: `id`, `endpoint_id` (FK), `node_id` (FK), `status` (`healthy`, `degraded`, `offline`, `route_leak`, `auth_error`, `timeout`, `configuration_error`), `exit_ip`, `latency_ms`, `error_message`, `checked_at`.
8. `fleet_deployments`: `id`, `node_id` (FK), `revision`, `config_digest`, `status` (`pending`, `applied`, `failed`, `rolled_back`), `error_message`, `applied_at`, `created_at`.
9. `fleet_enrollment_tokens`: `token_hash`, `node_name`, `expires_at`, `consumed_at`, `created_at`.
10. `fleet_events`: `id`, `node_id`, `endpoint_id`, `event_type`, `level`, `payload_json`, `created_at`.

## 4. Agent Architecture (Go)

- Binary: Single static binary `proxyfleet-agent`, zero runtime CGO dependencies (`CGO_ENABLED=0`).
- Cross-compilation targets: `linux/amd64`, `linux/arm64`, `linux/arm` (v7 for OpenWrt).
- Lifecycle:
  1. **Enrollment**: Reads `--token` and `--server`, generates local WireGuard keypair, enrolls with controller, securely receives node identity and WG config.
  2. **Heartbeat Loop**: Ticks every 15s to controller `/api/fleet/agent/heartbeat`. Reports 3proxy process state, interface addresses, and proxy port connectivity. Controller marks offline after 60s timeout.
  3. **Configuration Deployment**: Desired state polled or delivered via revision sequence. Validates candidate 3proxy configuration, tests with local binary or dry-run, atomic replace, reloads 3proxy via systemd, verifies connectivity. Automatically rolls back to last known good configuration on failure.
  4. **Layered Health Checking**:
     - Layer 1: Process running (`systemctl is-active 3proxy`).
     - Layer 2: TCP listener bound and accepting.
     - Layer 3: Authenticated test request through proxy verifies Internet reachability, measures latency, inspects exit public IP against expected egress, and detects route leaks.

## 5. Network & Security Architecture

1. **Overlay Network**: WireGuard `10.77.0.0/24`. Controller at `10.77.0.1`, worker nodes assigned `/32` peers starting at `10.77.0.11`.
2. **Access Isolation**:
   - 3proxy listeners default to binding the WireGuard IP (`10.77.0.x`), never open public `0.0.0.0`.
   - Controller agent API endpoints require token/mTLS authentication.
   - Admin APIs and PostgreSQL are never exposed to the public Internet.
   - `nftables` ensures only authorized WireGuard traffic reaches proxy listeners.
3. **Secret Redaction**:
   - Zero credentials in table views or query params.
   - Credentials encrypted at rest using AES-256-GCM.
   - Sanitized structured JSON logging across controller and agent.

## 6. Pipeline Integration

- Managed `ProxyEndpoint` items can be selected into:
  1. **Diagnostics**: Reuses `src/server/detailed-checker.ts` and `src/auditor/probes/`.
  2. **Safety Auditor**: Reuses `src/auditor/api.ts` `checkProxy` with `allowPrivateTargets: true` explicitly authorized for the registered WireGuard endpoint. Non-destructive: audits never mutate node state.
  3. **Ranking & 9Router Publication**: When a managed endpoint passes audits and is authorized for publication, it enters the pool ranker pipeline alongside 9Router pools with full source provenance tracking (`source: "proxyfleet"`).
