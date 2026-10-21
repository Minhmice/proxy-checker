# Fleet Lifecycle, Observability and Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver safe broken-node deletion, owned WireGuard lifecycle, real activity/resource visibility, accurate device metadata and measured per-node 3proxy capacity improvements.

**Architecture:** Keep SQLite as the fleet source of truth, node-scoped agent authentication and separate liveness/configuration/overlay/proxy state. Persist removal intent before network changes, reconcile only owned resources, and extend the existing agent and unified maintenance cycle rather than adding another daemon. Retain 3proxy; tune it against measured per-node bottlenecks, not fleet scheduling.

**Tech Stack:** Node.js >=22 with node:sqlite and TypeScript/tsx, Next.js/React/shadcn, Go stdlib, installed WireGuard and 3proxy, Linux systemd/proc/sysfs and Windows native services/CIM.

**Spec:** `docs/superpowers/specs/2026-10-17-fleet-lifecycle-observability-capacity-design.md` (approved; design commit d054385).

## Global Constraints

- Capacity means making each existing node serve connections better, not adding fleet scheduling or moving traffic between nodes.
- Agent liveness, configuration convergence, overlay reachability and proxy serving health remain separate axes.
- Measurements carry sample timestamps and become stale when heartbeat evidence expires under the existing 60-second liveness rule.
- Keep controller identity and existing worker IDs, assigned addresses, credentials and configuration history across migration.
- Backend remains responsible for proxy health auditing and database audit state.
- Fleet inventory synchronization joins the existing unified maintenance cycle, not a separate auditor routine.
- No automatic machine reboot, bulk kernel tuning or mutation of unrelated WireGuard interfaces, routes or firewall policy.
- Private keys remain in restricted local storage, never browser/API responses or logs.
- Use persistent keepalive of 25 seconds for NAT traversal.
- After three consecutive failed active probes across normal agent cycles, attempt a bounded repair of only the owned interface/peer. Apply a five-minute recovery cooldown.
- Node tokens and desired-state credentials require HTTPS or a trusted encrypted overlay for remote transport.
- Preserve user's unrelated working-tree changes; do not stage whole directories or restore files. Exported symbol changes require LSP references before implementation.
- No speculative frontend redesign or new dependency; use installed shadcn Dialog/Button/Card/Table patterns. Frontend/code generation delegation follows configured 3.8 Flash Auto assignment when available; do not claim an unavailable model override happened.
- Do not run repeated builds/tests/formatters during parallel edits. Integrate first, then one combined check run and targeted real-surface smoke. Capture existing failures without trying to reconfirm user-reported failures.

## Delivery map and responsibilities

| Existing file | Responsibility after change |
| --- | --- |
| `src/proxyfleet/types.ts` | Canonical public device/runtime/overlay/removal/capacity contracts |
| `src/proxyfleet/db.ts` | Migrations, current snapshots, monotonic receipt, deletion/revocation transaction, IP reservations |
| `src/proxyfleet/api-router.ts` | Authenticated admin/agent boundary validation, deletion/status/retry/capacity endpoints |
| `src/proxyfleet/enrollment.ts` | Validated real overlay enrollment, atomic identity/IP/token issuance |
| `src/proxyfleet/pipeline-adapter.ts` | Stable endpoint ownership and active inventory synchronization |
| `src/server/server.ts` | Fleet dependencies, actual controller capability observation and maintenance wiring |
| `src/server/unified-sync-coordinator.ts` | Existing shared maintenance cycle, fleet cleanup and inventory maintenance |
| `src/server/proxy-intelligence-repository.ts` and `src/server/proxy-intelligence-db.ts` | Stable managed endpoint linkage and unlink state without deleting unrelated inventory |
| `agent/internal/controller/client.go` | Matching JSON wire types and node-authenticated requests |
| `agent/internal/config/config.go` | Durable keys/controller peer, capacity configuration and pending deployment report |
| `agent/cmd/proxyfleet-agent/main.go` | Responsive heartbeat/activity plus serialized desired-state application and periodic service checks |
| `agent/internal/proxy/render.go` and `deploy.go` | Validated capacity directives, safe application/rollback |
| `agent/internal/health/checker.go` | Bounded managed listener/service observations, not backend audit replacement |
| `scripts/install-agent.sh` | Runnable userland binary selection, actual executable service path, ordered service startup |
| `deploy/systemd/{3proxy,proxyfleet-agent}.service` and `deploy/wireguard/*.example` | Accurate deployment templates matching runtime ownership |
| `src/app/(dashboard)/nodes/page.tsx`, `nodes/[id]/page.tsx`, `monitoring/page.tsx`, `proxy-endpoints/page.tsx` | Deletion and truthful observed state on existing surfaces |
| `docs/deployment.md`, `docs/operations.md` | Exercised rollout, removal, recovery and benchmarking procedures |

Create only these focused runtime units where existing files lack the responsibility:

- `src/proxyfleet/node-removal.ts`: durable removal orchestration, not generic jobs framework.
- `src/proxyfleet/wireguard.ts`: validated controller tunnel ownership, command execution, persistent peer reconciliation and native controller observation.
- `agent/internal/device/device.go`, `device_linux.go`, `device_windows.go`: device inventory using build-tagged native readers.
- `agent/internal/telemetry/telemetry.go`, `telemetry_linux.go`, `telemetry_windows.go`: dynamic sample collection and reset-safe rate calculation.
- `agent/internal/wireguard/wireguard.go`, `wireguard_linux.go`, `wireguard_windows.go`: worker owned interface provisioning, observation and bounded recovery.
- `src/components/nodes/delete-node-dialog.tsx`: shared operator deletion confirmation/status, using existing Dialog primitives.
- `scripts/fleet-capacity-benchmark.mjs`: explicit operator-run, authenticated controlled-target load scenario; no production autorun.

Do not split or rewrite the whole repository class. Use current naming conventions; add nested new contracts, not another duplicate camel/snake public view.

## Shared wire contracts

Define these in types.ts and matching Go structs before independent worker/UI implementation. JSON numbers unavailable on a platform are null, not omitted zero values. Static device payload is submitted at agent startup/refresh; snapshot is submitted every normal heartbeat. Existing basic heartbeat clients can remain recognized as old capability reports without fabricating runtime data.

```ts
export interface FleetDeviceInfo {
  schemaVersion: 1;
  hostname: string;
  osFamily: string;
  osVersion: string | null;
  kernel: string | null;
  osArch: string | null;
  agentArch: string;
  model: string | null;
  vendor: string | null;
  cpuModel: string | null;
  logicalCpus: number | null;
  memoryTotalBytes: number | null;
  virtualization: string | null;
  sources: Record<string, string>;
}
export interface FleetOverlayObservation {
  state: 'healthy' | 'unhealthy' | 'unknown';
  interfacePresent: boolean | null;
  peerPresent: boolean | null;
  lastHandshakeAt: number | null;
  probeOk: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  error: string | null;
  lastRecoveryAt: number | null;
}
export interface FleetRuntimeSnapshot {
  schemaVersion: 1;
  sessionId: string;
  sequence: number;
  sampledAt: number;
  uptimeSeconds: number | null;
  activity: {
    kind: 'idle' | 'applying' | 'checking' | 'recovering' | 'error';
    startedAt: number;
    revision: number | null;
    error: string | null;
  };
  cpuPercent: number | null;
  loadAverage1m: number | null;
  memoryAvailableBytes: number | null;
  memoryTotalBytes: number | null;
  network: {
    interfaceName: string | null;
    scope: 'overlay' | 'egress' | 'unknown';
    rxBytes: number | null;
    txBytes: number | null;
    rxBytesPerSecond: number | null;
    txBytesPerSecond: number | null;
  };
  proxy: {
    state: 'running' | 'stopped' | 'unknown';
    enabledEndpoints: number;
    listeningEndpoints: number | null;
    activeConnections: number | null;
    checkedAt: number | null;
    error: string | null;
  };
  overlay: FleetOverlayObservation;
  unavailable: Record<string, string>;
}
export interface FleetCapacitySettings { maxConnections: number | null }
export interface FleetWireGuardDesired {
  interfaceName: string;
  addressCidr: string;
  controllerPublicKey: string;
  controllerEndpoint: string;
  allowedIps: string[];
  persistentKeepaliveSeconds: 25;
  mtu: number | null;
}
export interface FleetRemovalRecord {
  nodeId: string;
  nodeName: string;
  wireguardIp: string;
  publicKey: string | null;
  status: 'pending' | 'completed';
  lastError: string | null;
  requestedAt: number;
  completedAt: number | null;
}
```

Extend node GET responses with device/runtime/capacity and server-computed runtimeReceivedAt; derive stale from server receipt time, not agent wall clock. Monotonic runtime acceptance uses session ID + sequence. Serialize heartbeat submission per agent process; authenticate a new telemetry session at startup, retiring its previous session so delayed old requests cannot restore old activity. Heartbeat liveness still updates even if a duplicate snapshot is ignored. Sequence is a positive safe integer; snapshot timestamps permit clock skew without determining receipt order. Bind telemetry session to node token; runtime session state is reset on credential revocation.

Extend desired-state response with `wireguard: FleetWireGuardDesired | null` and `capacity: FleetCapacitySettings`, independent of whether proxy revision changes; missing overlay configuration is unknown/unavailable, never a fake usable peer. Private keys remain local. Capacity updates increase desired revision atomically like endpoint updates.

---

### Task 1: Durable removal, revoked credentials and reserved addresses

**Files:** Modify types.ts, db.ts, api-router.ts, enrollment.ts; create node-removal.ts; extend `tests/fleet-db.test.ts`, `tests/fleet-agent-auth.test.ts`, `tests/fleet-api.test.ts`; update operations.md only after smoke.

**Interfaces:**

```ts
// FleetRepository additions
requestNodeRemoval(nodeId: string): Promise<FleetRemovalRecord>;
getNodeRemoval(nodeId: string): Promise<FleetRemovalRecord | null>;
listPendingNodeRemovals(): Promise<FleetRemovalRecord[]>;
recordNodeRemovalError(nodeId: string, message: string): Promise<void>;
completeNodeRemoval(nodeId: string): Promise<FleetRemovalRecord>;
// node-removal.ts
createNodeRemovalService(deps: {
  repo: FleetRepository;
  removeOwnedPeer: (record: FleetRemovalRecord) => Promise<void>;
  unlinkManagedEndpoints: (nodeId: string) => Promise<void>;
}): {
  remove(nodeId: string): Promise<FleetRemovalRecord>;
  retryPending(): Promise<void>;
};
```

- [ ] Add behavioral regression covering token rejection immediately after removal intent, exclusion from node/desired-state/active endpoint listings, controller protection and preserved unrelated nodes. Use isolated SQLite, the actual handler, and existing admin auth helpers. Assert this sequence:

```ts
await repo.setNodeAgentToken(worker.id, 'worker-token');
const removal = await repo.requestNodeRemoval(worker.id);
assert.equal(removal.status, 'pending');
assert.equal(await repo.verifyNodeAgentToken(worker.id, 'worker-token'), false);
assert.equal(await repo.getNodeDesiredState(worker.id), null);
assert.equal((await repo.listNodes()).some(n => n.id === worker.id), false);
assert.notEqual(await repo.getNextWireguardIp(), worker.wireguard_ip);
```

- [ ] Implement `fleet_node_removals` with node ID primary key, node name/IP/key, pending/completed, timestamps and bounded error; add internal lookup of pending endpoints for owned-link cleanup without exposing them as active inventory. Transactionally reject controller deletion with 409, null token hash and runtime session, save removal intent, and write audit. Public get/list operations must exclude pending nodes while removal GET remains readable.
- [ ] Keep dependent rows until completion so cleanup can resolve ownership. `completeNodeRemoval` verifies a pending intent, deletes with foreign keys enabled and writes sanitized audit in one transaction, preserving completed tombstone without IP reservation. Address allocator excludes active nodes plus pending removals. Make issuing/consuming token, allocation, node insert and credential issuance transactional; allocation cannot race two enrollments onto one address. Roll back token consumption on failure.
- [ ] Implement service using durable intent before callbacks. Peer/link cleanup errors persist pending status, reserve address and return status rather than swallowing errors. Completion runs only after both callbacks succeed. Serialize duplicate removal/retry per node, with durable state remaining authoritative after restart.
- [ ] Add authenticated DELETE `/api/fleet/nodes/:id`, GET `/api/fleet/node-removals`, GET `/api/fleet/node-removals/:id`, POST `/api/fleet/node-removals/:id/retry`. List returns `{ removals: FleetRemovalRecord[] }` from pending intents. DELETE returns 200 completed or 202 pending, controller 409, missing 404, unauthenticated 401. Parse exact path segments; do not let existing GET prefix route swallow admin subresources.
- [ ] Smoke real HTTP handler against memory DB with unavailable peer cleanup: observe 202, old token 401, no active inventory entry; reopen a temporary persistent DB and retry successful cleanup, observe 200, freed address and preserved audit. No production deletion. During integration run the listed existing fleet suites; do not add source-text/wiring tests.
- [ ] After smoke, document deletion versus remote uninstall and pending status. Commit only task-owned changed files when their behavior is verified.

### Task 2: Owned endpoint inventory and unified maintenance integration

**Files:** Modify pipeline-adapter.ts, proxy-intelligence-db.ts, proxy-intelligence-repository.ts, unified-sync-coordinator.ts, server.ts; extend `tests/fleet-pipeline-integration.test.ts` and `tests/unified-sync-coordinator.test.ts`.

**Interfaces:** Consume removal service above. Produce `removeOwnedPeer` in Task 6; before that, missing configured ownership must fail visibly, not a successful no-op. Extend the actual repository with:

```ts
syncManagedFleetEndpoints(rows: Array<{
  nodeId: string; endpointId: string; proxyUrl: string;
}>): Promise<number>;
unlinkManagedFleetNode(nodeId: string): Promise<void>;
```

- [ ] Add isolated behavior coverage: fleet-owned endpoint removed from active inventory while a separately imported proxy sharing its IP survives; change endpoint credentials without creating an unrelated stale fleet identity. Do not identify ownership solely by text proxy URL/source.
- [ ] Add mapping keyed by `(fleet_node_id, fleet_endpoint_id)` with link to existing intelligence proxy identity, migration keeping prior inventory intact. Link an existing matching proxy as shared, not exclusively owned: removal detaches the fleet relation and preserves any non-fleet source/usage. Historical rows without provable endpoint ownership remain untouched and are surfaced for operator review.
- [ ] Reuse existing import and unlink mechanisms; detach router/account references only when owned removal has actually succeeded. Keep failed external cleanup pending and report exact bounded reason. Maintain shared-proxy concurrency and existing account proxy-assignment policy; never reorder/reassign accounts to optimize speed during routine cleanup.
- [ ] Add one fleet maintenance dependency to existing unified coordinator. Run fleet cleanup/inventory maintenance within that cycle, with router sync and Antigravity rotation still concurrent. Use all-settled reporting or equivalent so fleet cleanup failure does not silently prevent the other existing work. Do not add intervals or a mutex serializing router and rotator.

```ts
fleetMaintenance?: () => Promise<{ pendingRemovals: number; syncedEndpoints: number }>;
```

- [ ] Wire actual production repository/services in server.ts; call cleanup then sync currently active endpoints, persist ownership and audit in backend. Route scoped managed endpoints through the existing backend audit entry rather than an agent-only healthy flag; never globally permit private targets for untrusted imports.
- [ ] Smoke isolated actual repositories and HTTP admin removal with one shared and one fleet-only proxy. Observe surviving unrelated row, withheld address on cleanup failure and completion on recovery. Existing unified sync remains independently triggerable manually.
- [ ] Document real production integration and commit verified task files only.

### Task 3: Device inventory, correct architecture and runtime measurement

**Files:** Create agent device/telemetry packages listed above; modify controller/client.go, config.go, main.go, types.ts, db.ts, api-router.ts and installer; extend config/client tests, create `agent/internal/device/device_test.go`, `agent/internal/telemetry/telemetry_test.go`, `tests/fleet-runtime.test.ts`.

**Interfaces:** Device package exports `Detect() Info`; telemetry exports `NewCollector() *Collector`, `(*Collector).Sample(ctx context.Context, managedPorts []int) Snapshot`. Define Info/Snapshot fields matching shared contracts, without importing main. Add repo `recordNodeDevice(nodeId: string, device: FleetDeviceInfo): Promise<void>`, `startRuntimeSession(nodeId: string, sessionId: string): Promise<void>`, `recordNodeRuntime(nodeId: string, runtime: FleetRuntimeSnapshot): Promise<{ accepted: boolean }>`; API POST `/api/fleet/agent/runtime-session` authenticates node token before binding session. Heartbeat validates/stores optional nested device/runtime data.

- [ ] Add fixture-driven behavioral tests for missing/permission-denied model, Pi model null-terminator stripping, first CPU sample null, zero CPU after valid idle samples, counter reset, network interface switch and repeated/out-of-order session samples. CPU fixture:

```go
// 100 total ticks, 70 idle ticks between samples means 30% utilization.
previous := cpuCounters{Total: 1000, Idle: 700}
current := cpuCounters{Total: 1100, Idle: 770}
value := cpuPercent(previous, current)
if value == nil || *value != 30 { t.Fatalf("want 30%%, got %v", value) }
```

Define `cpuCounters` and `cpuPercent` privately inside telemetry package; return nil when totals regress or do not advance. Parse `/proc/stat` CPU aggregate excluding guest double counting. Never derive utilization from `/proc/loadavg`.

- [ ] Linux: read os-release, proc kernel/CPU/memory/uptime, device tree model or DMI vendor/product; distinguish userland/os/binary architecture and evidence. Resolve actual egress/overlay interface names, sample net/dev counters and count ESTABLISHED entries attached to managed listen ports in tcp/tcp6, not remote-port matches or all sockets. Unsupported/inaccessible fields carry reasons. Do not expose DMI serial/machine UUID.
- [ ] Windows: fixed native/CIM collection with command timeout and noninteractive invocation; query manufacturer/model/OS/architecture/CPU/physical RAM and native CPU/network counters. Inspect managed services/processes and Get-NetTCPConnection scoped to local managed listener ports. Static queries run at startup only; dynamic collection is bounded and cannot block the heartbeat indefinitely. Missing permission yields unknown, not fallback Linux readings.
- [ ] Installer selects executable based on userland as well as `uname -m`, validates binary invocation with `--version` before replacing existing binary, and preserves state. Cover 64-bit ARM kernel with 32-bit userland. Render resolved `${PROXY_BIN}` into systemd ExecStart rather than current quoted heredoc literal, quote node/server args safely, and fail clearly if required executables are absent.
- [ ] DB migrations add nullable device/latest runtime JSON, receipt timestamp and active session/sequence state; existing revisions untouched. Validate schema version 1, finite CPU 0..100, nonnegative safe byte/count values, known activity enums, JSON size <=32 KiB, error <=2048 chars and source/reason maps <=32 entries with <=256-char values. Reject invalid payload atomically, update liveness independently only for valid authenticated requests. Ignore old session/sequence snapshots without replacing data. Retired sessions cannot register again with the same node token; bound session history by rotating token only through existing explicit credential provisioning, not deleting replay protection arbitrarily.
- [ ] Receive startup device data over authenticated calls for existing agents; no forced re-enrollment. Distinguish no metadata from old compatibility fields. Store server receipt timestamp for stale derivation; do not compare remote wall clocks for ordering.
- [ ] Smoke actual new agent against isolated controller and inspect stored measured data. Compare native CPU/memory/model readings on current Windows host; run real Linux probes on enrolled worker when reachable. Report missing OS verification explicitly; fixture parsing alone is not hardware proof.
- [ ] Update device/architecture rollout instructions and commit verified task files.

### Task 4: Responsive activity and ongoing proxy service observation

**Files:** Modify main.go, health/checker.go, controller/client.go, config.go, telemetry package; extend main_test.go and fleet-runtime.test.ts.

**Interfaces:** Consume runtime snapshot/session and capacity/overlay desired state. Keep deployment `ReportDeploymentResult` durability; use one application worker with a bounded latest desired-state queue, one heartbeat sender and immutable snapshot copies protected by mutex. No concurrent mutation of State, pending report or client token.

- [ ] Define activity transitions in code and behavior test: application of revision N publishes applying before deployment finishes; heartbeat remains available; final error/success and revision match the actual operation. Duplicate desired state does not start a second apply. Two agent goroutines must not overwrite pending result state during save.
- [ ] Extract serialized apply from runCycle. Main observation loop collects/sends snapshots at normal interval; application worker owns configuration state writes and reports through channels. Use context cancellation for graceful shutdown, bounded request timeout, session sequence increment and wait for owned goroutines to stop. Do not let a slow deploy delay liveness for >=60 seconds.
- [ ] Refresh enabled managed ports from desired state, observe 3proxy service/process and listeners each cycle even when revision unchanged. Record timestamps and unavailable/error states. Local TCP check is listener evidence only. Backend forwarding audit remains authoritative for end-to-end health.
- [ ] Keep configuration convergence semantics: successful accepted config apply may remain Applied when serving later fails, but proxy state must read stopped/unhealthy independently. A failed apply keeps prior applied revision. Pending deployment acknowledgements persist and retry without duplicating audit.
- [ ] Emit activity event only on meaningful transition/revision/error change, sanitize credentials, cap per-node recent activity retention at 200 transitions while keeping lifecycle/security audit. Do not truncate historical deletion/deployment events as part of activity retention.
- [ ] Smoke actual agent process against isolated HTTP controller, delay application and observe applying snapshots, then stop managed proxy and observe health change with unchanged desired revision. Restore proxy and observe recovery. Exercise race detector once integrated: `go test -race ./...` where supported.
- [ ] Document observed state meanings after smoke and commit verified files.

### Task 5: Truthful operator surfaces and deletion controls

**Files:** Create delete-node-dialog.tsx; modify nodes/page.tsx, nodes/[id]/page.tsx, monitoring/page.tsx and proxy-endpoints/page.tsx; use existing API client conventions in src/lib/api.ts and types.ts where needed.

**Interfaces:** Consume DELETE/status/retry APIs, device/runtime/capacity contracts and server receipt time. No new separate UI status inference of healthy from revision or enabled flag.

- [ ] Reuse existing Dialog/Input/Button for destructive confirmation naming node and endpoint count. Show pending cleanup and retry; protect controller action server-side and client-side. After 202 remove active node from table but keep accessible removal status feedback; after refresh show pending removals in an existing nodes surface, fetched via authenticated GET `/api/fleet/node-removals` backed by `listPendingNodeRemovals`. Abort requests on unmount; preserve non-abort error handling.
- [ ] Replace detail defaults Linux/amd64/0.1.0 with actual metadata or Unknown. Show hardware model, OS/kernel, OS versus binary architecture, RAM/CPU capacity and detection sources compactly; do not label node from hostname heuristics.
- [ ] Render independent Agent, Configuration, Tunnel and Proxy status with text and timestamps. Rename endpoint Active to Enabled unless real health evidence qualifies a separate Healthy label. Preserve credential reveal, endpoint creation and convergence history.
- [ ] Node detail activity/resource card shows current activity/revision/start/error; CPU%, RAM used/total calculated from non-null values, active established connections, network scope/rates and uptime. Old snapshot stays visible as Stale; absent measurement is an em dash/Unknown, never 0%. Replace unmeasured Beszel/overlay reference cards in monitoring with measured fleet observations, not a second telemetry backend.
- [ ] Poll only mounted fleet views at existing interval (15 seconds) using local stable dependencies; stop on unmount and reject stale results. Render only state changes, no per-frame timers. For long application, current activity updates without a manual page reload.
- [ ] Browser smoke actual isolated dashboard: offline worker delete dialog, controller protection, cleanup failure/retry, unknown device, 0% valid CPU versus absent sample, stale heartbeat, applying configuration, unchanged revision with stopped proxy, credential reveal and small-screen controls. Capture visual proof and close browser tabs. No new permanent UI source-text tests.
- [ ] Update operations UI descriptions and commit verified changed files.

### Task 6: Owned controller/worker WireGuard provisioning and recovery

**Files:** Create controller wireguard.ts and Go wireguard package; modify enrollment.ts, db.ts, types.ts, api-router.ts, app-config.ts, server.ts, settings/page.tsx, main.go/config.go/client.go, installer and deployment templates. Add `tests/fleet-wireguard.test.ts` and `agent/internal/wireguard/wireguard_test.go`. Read existing app-config normalization/listener/whitelist patterns before changing settings.

**Interfaces:**

```ts
export interface FleetWireGuardSettings {
  interfaceName: string;
  controllerAddressCidr: string;
  publicEndpoint: string;
  listenPort: number;
  mtu: number | null;
}
createFleetWireGuardManager(settings: FleetWireGuardSettings): {
  preflight(): Promise<{ publicKey: string; observation: FleetOverlayObservation }>;
  reconcilePeers(peers: Array<{ nodeId: string; publicKey: string; address: string }>): Promise<void>;
  removePeer(record: FleetRemovalRecord): Promise<void>;
  observe(): Promise<FleetOverlayObservation>;
};
```

The manager also exposes `setup(): Promise<{ publicKey: string; observation: FleetOverlayObservation }>` for explicit administrator-triggered provisioning. GET `/api/fleet/wireguard` returns sanitized configuration/observation; POST `/api/fleet/wireguard/setup` performs preflight and creates only the owned tunnel; POST `/api/fleet/wireguard/migrate` accepts explicit existing node IDs and rejects any conflicting address/key before reconciliation. All three routes require existing admin authentication. Runtime observation reads never provision or modify networking.

Go package exports `NewManager(configDir string) *Manager`, `(*Manager).Reconcile(ctx context.Context, desired controller.WireGuardDesired, privateKey string) error`, `(*Manager).Observe(ctx context.Context) Observation`, `(*Manager).Recover(ctx context.Context) error`. Observation uses contract-equivalent fields. Manager holds failure count and lastRecoveryAt; persist cooldown through restart so service restart cannot defeat limits.

- [ ] Add boundary tests: invalid base64 key/decoded length, duplicate peer IP/key, endpoint host/port parsing including bracketed IPv6, overlapping subnet, foreign interface, missing privileges/tool, handshake idle but successful active probe, three consecutive failures and cooldown across process restart. Command behavior fixtures must test parsed outcome/state changes, not exact incidental argv formatting alone.
- [ ] Persist validated controller settings in existing configuration schema/PUT whitelist/public settings response, never private key. Default dedicated interface name `proxyfleet`, overlay 10.77.0.0/24 only if conflict-free. Setup is explicit admin action using actual tools; fail preflight with required privilege/subnet fix instead of inventing credentials. Controller private key generated locally, mode 0600/Linux or restricted Windows ACL. Publish public key only derived from actual key.
- [ ] Implement fixed executable argument arrays with timeout; Linux write owned configuration atomically and reconcile kernel via wg tooling/systemd, Windows install/manage only WireGuardTunnel$proxyfleet with restricted config ACL and public status inspection. Existing tunnel ownership requires matching persisted marker; never adopt wg0/other tunnel by name alone. Inspect configs without logging private/preshared keys or raw `wg show ... dump` output.
- [ ] Persist-before/apply convergence: reconcile only active node peers; /32 allowed IP per node. On command failure keep desired peer state pending and expose error; do not assume shell exit is connectivity proof. Reapply owned persisted state after service/controller restart. Prevent address allocation or completed deletion if unknown peer collision remains.
- [ ] Replace enrollment fake key/localhost fallback with manager preflight. Return actual desired peer metadata and persist in worker state; refresh enrolled worker desired overlay regardless of proxy revision. Worker writes restricted config, preserves default Internet route, allowed overlay only and keepalive 25. Linux systemd orders 3proxy after owned WireGuard readiness; Windows agent observes/provisions corresponding owned service. Partial enrollment retains pending setup state and a recoverable authenticated worker identity instead of consuming another enrollment token on every retry.
- [ ] Poll real interface, peer, handshake, counters and active overlay controller probe. Repair only owned interface after three failed cycles, minimum five-minute cooldown, report attempt/result and remain degraded after failure. Missing controller HTTP must not cascade into repeated local repairs. MTU override validates 1280..9000 and is not increased automatically without path evidence.
- [ ] Connect deletion `removeOwnedPeer` to this real manager; unavailable tool/ownership evidence keeps pending. Retain IP reservation until both runtime and persisted configuration no longer contain peer. Completed deleted token cannot resurrect a peer.
- [ ] Add explicit migration/setup UI under existing Settings using shadcn and authenticated configuration routes; display subnet conflicts, insufficient permissions and real setup status. Existing fleet nodes keep ID/IP/key and require checked migration, not automatic takeover of unrelated adapters. Show controller observation separately from bootstrap liveness.
- [ ] Smoke actual Linux and Windows owned tunnel: enroll fresh isolated node, verify authenticated proxy forwarding across overlay; restart and verify persistence; disable only owned tunnel while HTTP remains up, observe status separation and cooldown recovery. Confirm pre-existing Windows tunnel config/service/route untouched. Do not execute network mutation without an isolated subnet/interface and admin permissions; obtain missing prerequisite instead of claiming tests proved native operation.
- [ ] Update all deployment templates and docs with actual owned interface, permissions, keys, migration/rollback and Windows commands. Build/distribute matching agent binaries after integration, not source-only rollout. Commit verified task files.

### Task 7: Measured per-node 3proxy capacity and controlled benchmark

**Files:** Modify capacity contracts/repository/API, render.go/deploy.go, main.go/client.go, installer/systemd templates, node detail UI; create capacity benchmark script; extend render_test.go, deploy_test.go and fleet-runtime.test.ts.

**Interfaces:** Authenticated PATCH `/api/fleet/nodes/:id/capacity` accepts `{maxConnections: number|null}`. Null preserves engine default, not fabricated auto-capacity. Repo `updateNodeCapacity(nodeId: string, settings: FleetCapacitySettings): Promise<FleetNodeWithCamel>` validates node and increments desired revision transactionally. Change renderer to `RenderConfig(endpoints []controller.ProxyEndpointConfig, capacity controller.CapacitySettings) (string, string, error)` and migrate every caller found through references. Go CapacitySettings uses pointer for nullable maxConnections.

- [ ] Measure installed 3proxy version, current effective max connections, actual process/system FD limit and memory on target node before changing defaults. Confirm semantics of maxconn for multiple listeners in that installed version; label per-service versus aggregate accurately. Do not assume maxconn is a fleet total if engine applies it per listener. Capture baseline workload/target metadata without proxy secrets.
- [ ] Add behavior tests: invalid noninteger/zero/negative/oversized setting rejected without revision mutation; accepted limit changes desired revision and digest, same setting does not redeploy; render directives affect actual configured service scope. Rollback keeps prior running configuration on application error.
- [ ] Implement explicit maxconn setting only when configured, placed according to actual installed engine semantics. Validate configured connection ceiling against descriptor headroom and measured memory budget; expose unavailable budget instead of pretending proof. Account for both inbound and outbound sockets and per-listener multiplication when applicable. Do not automatically raise LimitNOFILE beyond existing 65536 or sysctls without observed exhaustion. Settings rollback must cover service limit and proxy config together.
- [ ] Node detail capacity controls show configured versus observed limit, saturation evidence and last measured benchmark; never infer usable throughput from CPU count alone. Backend rejects unsafe/unsupported requested settings with actionable evidence.
- [ ] Implement opt-in benchmark script taking proxy URL from environment (not logged), controlled HTTPS target, concurrency, request count, bounded duration and explicit confirmation flag. Refuse missing target/confirmation, cap total work, no retries, mask credentials in errors. Exercise HTTP CONNECT with Node net/tls, SOCKS5 authentication/CONNECT as configured, and real HTTPS responses; do not benchmark only listener accept. Expose one documented CLI command per protocol. Output completed requests/bytes, throughput, p95 latency and failure count plus sampled resource/FD snapshot from actual controller telemetry. Do not scrape browsing destinations or invoke external random targets by default.
- [ ] Raise load in controlled steps on same target/node/config version; stop on sustained memory pressure, CPU saturation, FD exhaustion, rising errors or unacceptable p95 degradation. Document observed before/after ceiling with workload and stop criteria. Increase settings only when benchmark demonstrates benefit. More endpoints never count as more public IPs or bandwidth.
- [ ] Smoke real HTTP CONNECT and SOCKS traffic through tuned node, revert setting and verify prior behavior. If required worker/target access is unavailable, finish code checks but keep measured capacity acceptance explicitly blocked; do not replace benchmark with mocks or promise a gain.
- [ ] Update operations capacity procedure with actual results and commit verified files.

### Task 8: Integrated rollout and full acceptance

**Files:** Update deployment.md/operations.md plus existing `scripts/proxyfleet-acceptance.mjs` where runtime protocol changed; no source-wiring assertion tests. Distributed binaries: existing linux-amd64/arm64/armv7 and Windows agent under bin/.

- [ ] Inspect all changed public symbols with available LSP references and migrate callers/types/tests. Keep enrollment tokens, node tokens, runtime sessions, metadata, desired capacity and overlay protocol mutually compatible for the matching release. Old workers explicitly show unavailable capability until upgraded; no dummy healthy state.
- [ ] Integrate changes, then run once as appropriate:

```text
npm run typecheck
node --import tsx --test tests/fleet-*.test.ts tests/unified-sync-coordinator.test.ts
# In agent/:
go test ./...
go test -race ./...  # Windows amd64 or another supported native target
# Repository root:
npm run build
```

Use repo cwd arguments rather than shell cd. Do not re-run unrelated user-reported failures for confirmation. Fix regressions attributable to this work and exercise changed path after each necessary correction.

- [ ] Build actual binaries from agent/ with Go target environment: GOOS=linux GOARCH=amd64; linux/arm64; linux/arm GOARM=7; windows/amd64. Use platform-correct environment setup, preserve executable names. Run native `--version` and actual agent enrollment/heartbeat smoke. Cross-compilation alone does not prove Linux/ARM behavior.
- [ ] Browser smoke actual app for all Task 5 scenarios plus WireGuard setup status and capacity edit. Verify auth and credential reveal without printing secrets. Close managed browser tabs and remove only throwaway fixtures/services created by this work.
- [ ] Exercise specification acceptance 1..10. Record commands/observed results, pending environment prerequisites and measured benchmark data. Do not claim native tunnel, device model or throughput verified from parser tests.
- [ ] Update deployment migration instructions to preserve node state and roll back proxy/tunnel configuration without touching unrelated resources. Include Linux and Windows permission requirements, old agent upgrade, pending deletion retry and unavailable/stale telemetry meanings.
- [ ] Request review of behavior/security deltas (revocation, shell/command inputs, private key files, SSRF scope, unrelated tunnel preservation). Integrate evidence-backed review changes, not unrelated cleanup. Commit only verified implementation-owned files.

## Dependency and execution map

Tasks 1 and 2 form the lifecycle slice. Task 3 defines measured identity/runtime; Task 4 makes that state responsive; Task 5 exposes lifecycle plus observations. Task 6 closes real network ownership and deletion peer cleanup, then Task 7 tunes the data plane with real observations. Task 8 verifies the full approved result.

Parallelism is limited to disjoint responsibilities after shared contracts are fixed: native device/telemetry readers versus backend persistence; native Linux/Windows WireGuard operations versus UI status; isolated benchmark client versus capacity API integration. Repository class, API router and main.go each have one integration owner. Never assign two agents to edit them concurrently. Read-only broad research uses scout; avoid delegation for trivial mechanical changes. Parent retains top-level design and final native/browser evidence.

## Inline plan self-review

- Spec A is covered by Tasks 1, 2, 5, 6: revocation before cleanup, durable pending state, IP reservations, controller guard, external ownership and audit preservation.
- Spec B is covered by Task 6 and Task 8: real two-platform owned provisioning, restart persistence, conflict validation, overlay observation, conservative recovery and unrelated tunnel protection.
- Spec C is covered by Tasks 3, 4, 5: measured resources/activity, responsive reports, monotonic sequence/session, periodic services, backend audit and stale/unknown presentation.
- Spec D is covered by Tasks 3 and 5: hardware/OS/binary distinctions, Pi/PC/VM evidence, userland-aware installer and no fabricated UI defaults.
- Spec E is covered by Task 7: explicit limits tied to observed constraints, controlled real traffic, before/after metrics, no fleet scheduling or blanket tuning.
- Acceptance is covered by per-task real smokes and Task 8; unavailable real worker/network/target access is an explicit outstanding prerequisite rather than a passing claim.
- New function/type signatures are defined in shared contracts or their producer task; no alternate names for the same wire field. Capacity renderer callsites migrate together.
