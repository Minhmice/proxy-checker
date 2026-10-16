# Fleet Lifecycle, WireGuard, Observability and Per-node Capacity

## Status and approved direction

The operator approved all five work areas on 2026-10-17: deleting broken nodes, reliable WireGuard management, current node activity, per-node serving capacity, and accurate device detection. Capacity means making each existing node serve connections better, not adding fleet scheduling or moving traffic between nodes. This specification records that approved design for review before implementation planning.

## Evidence

- `src/proxyfleet/api-router.ts:266-298` lists nodes, rotates tokens and returns details; no DELETE node handler exists. An isolated HTTP invocation using the real handler returned 404 and left the node and its endpoint intact.
- `src/proxyfleet/db.ts:166-237` defines cascading dependent records. `fleet_events` intentionally has no node foreign key and can preserve deletion audit history.
- `src/proxyfleet/db.ts:558-568` accepts CPU and memory inputs but does not persist either. The actual agent sends only online status and version (`agent/cmd/proxyfleet-agent/main.go:190-195`).
- Enrollment saves a WireGuard key and address, but `main.go:117-140` does not use the returned controller key/endpoint to configure a tunnel. The Linux installer installs tools and creates a directory but does not provision a WireGuard interface.
- Enrollment currently supplies a fallback server public key and localhost endpoint (`src/proxyfleet/enrollment.ts:47-55`). These are not proof of a usable overlay.
- `main.go:207-208` skips subsequent checks when configuration has not changed. Listener failures following deployment are warnings; the agent still reports applied.
- Node detail substitutes Linux/amd64 and agent version 0.1.0 when metadata is absent, and labels enabled endpoints Active without health evidence.
- `agent/internal/proxy/render.go:24-27` uses fixed DNS cache/timeouts and has no explicit connection capacity setting. The installer already specifies LimitNOFILE=65536.
- `syncFleetEndpointsToIntelligence` has no production caller in src; inventory integration is currently exercised by tests rather than the production synchronization cycle.
- Runtime inspection found a WireGuard tool and an unrelated running Windows tunnel service, but no local 10.77.0.* interface address. The existing tunnel must remain untouched. The live dashboard API at localhost:1300 refused connection during research; no remote worker throughput or tunnel behavior was verified.

## Boundaries and invariants

1. Agent liveness, configuration convergence, overlay reachability and proxy serving health remain separate axes. No heartbeat or successful config write implies healthy traffic.
2. Unknown is not zero or healthy. Measurements carry sample timestamps and become stale when heartbeat evidence expires under the existing 60-second liveness rule.
3. Keep controller identity and existing worker IDs, assigned addresses, credentials and configuration history across migration. Missing historical measurements stay null.
4. Controller remains a fleet inventory node. Its local runtime capability and worker status must be reported explicitly; database bootstrap alone is not evidence of a running proxy or tunnel.
5. Do not replace 3proxy, add cross-node scheduling, generate extra public IPs, introduce a remote shell, or inspect users' browsing destinations.
6. Backend remains responsible for proxy health auditing and database audit state. Fleet inventory synchronization joins the existing unified maintenance cycle, not a separate auditor routine.
7. No automatic machine reboot, bulk kernel tuning or mutation of unrelated WireGuard interfaces, routes or firewall policy.

## A. Node deletion and revocation

### Operator contract

Add Delete node to the nodes action menu and node detail page using existing shadcn dialog patterns. Confirmation displays the node name and count of affected endpoints, and warns that deletion cannot uninstall services on an unreachable machine. Protect the controller in the API as well as UI. Offline and failed workers remain deletable; being offline alone never triggers automatic deletion.

Use authenticated DELETE /api/fleet/nodes/:id. A completed removal returns 200; a durable removal awaiting network cleanup returns 202 with explicit pending cleanup state; a missing node returns 404; attempting to delete the controller returns 409. Admin authentication uses existing fleet admin rules.

### Lifecycle and consistency

- Durably record removal intent, revoke the node credential, hide the node/endpoints from active inventory and exclude them from desired fleet peer configuration before external cleanup. Removing a node cannot be undone by a later heartbeat.
- Retain a bounded removal record containing only node ID/name, overlay IP, public key, cleanup status and last cleanup error; no agent token or proxy password. This record reserves the IP while cleanup is pending and makes retry/restart recovery possible.
- Remove the peer from both the running and persisted ProxyFleet-owned controller tunnel. Failed or unavailable privilege/tool access is surfaced as pending, not silently treated as success. Never remove a peer on an unrelated tunnel.
- When peer removal is verified, transactionally delete the node and cascading endpoints, credentials, checks, interfaces, egresses and deployments; preserve a sanitized deletion audit event. Release the address only after cleanup completes.
- Cleanup reconciliation runs in the existing maintenance cycle and can be retried from the removal status UI. Repeated requests must not duplicate cleanup work or release an address early.
- Allocation excludes pending removals. Existing peer/address conflicts must stop reuse rather than being overwritten.
- Managed Proxy Intelligence inventory is unlinked by stable fleet endpoint identity. Deletion does not delete unrelated proxies with merely similar hostnames or IP addresses. Existing external/router links must be shown as remaining cleanup until their owned links are removed; do not claim remote cleanup succeeded after a swallowed error.

## B. WireGuard lifecycle

### Ownership and configuration

Use a dedicated ProxyFleet-owned tunnel/interface and persisted configuration. Discover conflicts before setup: overlapping routes/subnets, occupied address, peer key reused with a different node, missing tools or insufficient permissions. Existing externally managed tunnels must not be adopted or overwritten automatically.

Controller settings contain the actual public endpoint, overlay subnet/address and owned interface identity; private keys remain in restricted local storage, never browser/API responses or logs. Derive the public key from real controller configuration. Missing/invalid setup blocks new WireGuard enrollment with an actionable error rather than returning the current fallback key or localhost endpoint. Validate keys, addresses, ports and subnet membership before use. Invoke fixed executables with argument arrays, never interpolated shells for untrusted input.

Linux uses installed WireGuard tools and systemd; Windows uses the installed WireGuard tunnel service and tools. The controller and worker must support their actual OS, not treat Windows tooling failure as successful Linux setup. Persist configuration atomically with restricted file permissions/ACLs, then reconcile owned peers after restart. Existing fleet nodes require explicit checked migration into the owned interface, with old configuration preserved for operator recovery. Never change the unrelated running Windows tunnel.

The worker persists the controller peer configuration received during enrollment and refreshes it through desired state for enrolled nodes. AllowedIPs stay scoped to the fleet overlay, not 0.0.0.0/0. Use persistent keepalive of 25 seconds for NAT traversal. Preserve system default Internet egress. MTU is a measured/validated setting; 1420 may be an initial value only when the actual path supports it, not an automatic fix for every failure.

### Observation and recovery

Report interface presence/state, peer presence, last successful handshake, RX/TX counters and an active controller-overlay probe. A stale handshake on an idle tunnel is not sufficient alone to declare failure. Failed probe, absent interface, stale/unknown handshake and missing tool permission must remain distinguishable.

After three consecutive failed active probes across normal agent cycles, attempt a bounded repair of only the owned interface/peer if local configuration and permissions permit. Apply a five-minute recovery cooldown and report each attempt/result. Repeated failure remains degraded and requires operator attention; it must not cause a tight restart loop, global network restart, key rotation or machine reboot. A simultaneous HTTP controller outage does not justify destructive local networking changes.

## C. Activity and measured runtime state

Extend the authenticated agent heartbeat with versioned nested device and runtime data rather than duplicate snake/camel field conventions. Validate structure, finite ranges, timestamps and bounded error text at the controller boundary. Persist the latest snapshot in SQLite plus bounded activity transition events, not one event per polling heartbeat.

Runtime snapshot includes:

- Current managed activity: idle, applying configuration, checking services, recovering overlay or error; started-at time and relevant revision/error.
- Host CPU utilization from successive OS CPU counter samples, memory available/total, host uptime and sample timestamp. Load average, where available, is separately named; it is never substituted for CPU percentage.
- Network byte counters and calculated rates with the measured interface/scope identified. Handle first sample, counter reset, reboot and elapsed-time changes without negative rates or fabricated zeros.
- 3proxy process/service state, enabled/listening endpoint counts and active established proxy connections attributable to managed listener ports. Do not count unrelated system sockets or TIME_WAIT as active proxy sessions.
- Overlay observations described above and most recent listener check results.

Use Go stdlib plus installed native OS facilities. Linux probes use /proc, device tree and sysfs; Windows uses native counters/CIM or fixed-argument commands with timeouts. Unsupported or inaccessible values are null with a reason, not placeholder data. Do not launch expensive system inventory commands every 15 seconds; collect static identity at startup and dynamic counters in normal cycles.

A slow configuration application must not make all activity appear idle: snapshot acquisition/heartbeat must remain responsive and publish applying state while the deployment is running, without overlapping deployments or uncontrolled polling concurrency. Use a single serialized application owner and bounded heartbeat/report operations. Preserve pending deployment report durability.

Continue service/listener checks even when desired revision is unchanged. Configuration applied means the accepted configuration operation completed; proxy healthy requires observed serving checks. A listener failure is surfaced independently and must not be rendered as healthy because a revision is applied. Backend audits test authenticated HTTP CONNECT/SOCKS forwarding and egress; a local TCP port check is not end-to-end proof.

UI uses existing shadcn components and compact fleet table conventions. Node detail shows activity, timestamps, resources, device identity, proxy/overlay status and sanitized timeline. Monitoring surfaces measured CPU/RAM/traffic rather than unverified reference cards. Refresh only while relevant views are mounted; reject stale responses and show sampled-at/stale labels. Enabled, Applied and Healthy have distinct wording. Retain existing revision convergence and credential reveal behavior.

## D. Accurate device detection

Collect hostname, OS family/distribution/version, kernel, hardware model/vendor, CPU model/core count, total memory, operating-system architecture and agent binary architecture separately. Raspberry Pi/SBC model comes from device tree; PC/VM model uses DMI or Windows system inventory. Normalize display names without losing original source values. Distinguish detected virtualization evidence from an unsupported guess; unknown model/virtualization stays unknown.

Installer must choose a runnable binary for userland architecture as well as kernel architecture, especially a 64-bit kernel with 32-bit ARM userland. Agent-reported runtime architecture does not alone prove physical CPU capabilities. Refresh device metadata at agent start and after upgrades, keeping the existing node identity. Do not use hostname, MAC, public IP or reported hardware serial as authentication or automatic deduplication. Keep private identifiers and secrets out of inventory responses.

## E. Per-node serving capacity

Start with measured baseline rather than raising every limit. Use current 3proxy version/runtime behavior to establish effective connection limit, file-descriptor limits, memory use and CPU/network bottleneck. Add explicit per-node connection ceiling and necessary 3proxy/service settings through desired state, with validation and safe application using the existing configuration deployment mechanism. Preserve operator overrides and prior working configuration on failure. Do not publish unbenchmarked capacity as a measured recommendation.

Connection ceiling must fit both OS descriptor budget and measured memory headroom; do not derive a claim of supported throughput from CPU count/RAM alone. Raise in controlled load steps and stop on sustained memory pressure, increased errors or degraded latency. Report saturation separately from agent liveness. No blanket sysctl, DNS cache or timeout increase without a measured cause. More endpoints sharing one egress do not create more bandwidth or exit IPs.

Benchmark is an explicit operator action against controlled traffic targets, not an automatic production load generator. Compare identical workloads before/after: concurrent sessions, completed throughput, p95 latency, error rate, RAM and descriptor usage. Test HTTP CONNECT and SOCKS where configured. Record machine identity, software/config versions and workload, and state the observed ceiling; no guaranteed percentage gain is specified.

## Integration and rollout

Affected code includes fleet repository/types/enrollment/API, Go agent controller/config/runtime/proxy components, installer and distributed binaries, fleet list/detail/monitoring/endpoints UI, and existing unified sync/inventory integration. Update controller and agents as one protocol cutover; do not silently accept absent measurements as healthy. Migration keeps prior identity, endpoints and applied revision; old agents show unavailable telemetry and unsupported capabilities until upgraded.

Implement and verify in this order: deletion/revocation; identity/runtime observation; owned WireGuard provisioning/reconciliation; measured 3proxy capacity. These are delivery slices of the full approved scope, not scope reductions. Update deployment/operations instructions only with behavior actually implemented and exercised.

## Acceptance and evidence

1. Through real HTTP handlers on an isolated database, deleting an offline worker revokes its old bearer token, removes its inventory/endpoints, retains audit, and protects the controller. Failed peer cleanup survives restart, remains visible and reserves the address until retry succeeds.
2. On actual Linux and Windows owned interfaces, provisioning and restart preserve peer configuration, leave unrelated tunnels untouched, and reject overlapping subnet/invalid key setup. Check data-plane reachability, not merely wg command exit.
3. Disable the owned tunnel while HTTP control remains reachable: Agent stays online; overlay becomes unhealthy with measured evidence; recovery is bounded and cooldown observed.
4. Stop 3proxy without changing desired revision: recurring observation identifies service/listener failure; prior applied revision is not mistaken for healthy traffic. Restore and observe recovery.
5. Exercise configuration application while heartbeat reporting continues: operator sees applying state and durable completion/failure. Out-of-order snapshots do not overwrite newer activity.
6. Compare resource measurements with native OS readings on real Windows and Linux workers. Idle first samples, reboot/counter reset, missing permissions and offline transitions display correctly.
7. Verify actual device identity on the installed PC and Raspberry Pi/SBC; test mixed ARM kernel/userland binary selection. Unknown identity never displays fabricated Linux/amd64/model/version.
8. Benchmark controlled HTTP CONNECT/SOCKS traffic before and after tuning; report actual limits and all throughput/latency/error/memory measurements. If access to a real node or controlled target is missing, that acceptance remains unverified, not passed by a mock.
9. Browser smoke covers deletion confirmation and pending cleanup, node activity/resources/device display, stale state, monitoring and endpoint health wording. Existing credential-reveal and convergence flows continue working.
10. Run affected existing Go/TypeScript contract checks once implementation is integrated; add durable behavior tests for revocation, cleanup/address invariants and measurement boundary cases, not copies of source text or mock forwarding.
