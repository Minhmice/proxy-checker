# Tailscale Fleet Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nhập Tailscale IP + SSH username/password, tự provision worker; kiểm tra cả expected public IP và IP trùng; node lỗi vẫn trong inventory nhưng proxies bị disable.

**Architecture:** Backend SSH qua tailnet có sẵn, giữ agent/3proxy và unified maintenance hiện tại. SQLite lưu identity, credentials mã hóa, trạng thái provision/public-IP/activation; transaction duy nhất quyết định quyền bật. Gate sai phải chặn desired listeners và mọi đường publish/pool/router, không chỉ UI.

**Tech Stack:** Node >=22, TypeScript, SQLite (`node:sqlite`), Next.js/shadcn, Go stdlib worker, systemd/nftables installer; thêm `ssh2` và `@types/ssh2` vì Node stdlib không hỗ trợ password SSH.

**Spec:** `docs/superpowers/specs/2026-10-21-tailscale-fleet-provisioning-design.md`

## Global Constraints

- Standard SSH over an existing Tailscale network; không tự cài Tailscale, không Tailscale SSH/password mixing.
- Không thay đổi unrelated Tailscale/`omp-pi`; không uninstall Tailscale khi xóa node.
- Node lỗi giữ nguyên identity trong inventory, proxies disabled; không force-delete để che lỗi.
- Expected public IPv4 tùy chọn, exact match; uniqueness luôn áp dụng với worker khác đang activation enabled, kể cả tạm offline; controller và pending removal không tính.
- Lookup fail, mismatch, duplicate, bootstrap/deployment/actual-forwarding fail: disable; không heartbeat nào tự bật lại.
- Public IP dùng `public_ip` hiện có; không thêm observed-IP field trùng nghĩa. Tailscale IPv4 `100.64.0.0/10` khác public IPv4 global-unicast.
- Public-IP observation chạy trên remote host bằng HTTPS; không tin observed IP do browser/heartbeat khai báo.
- Host fingerprint phải được xác nhận trước khi gửi password; pin lại mọi kết nối. Require non-default `FLEET_ENCRYPTION_KEY` trước lưu SSH secret.
- SSH password/token/proxy credential không xuất hiện trong argv, logs, JSON public, unit ExecStart hoặc browser storage. Root hoặc `sudo -n`; không giả định sudo password bằng SSH password.
- UI dùng shadcn, không redesign unrelated settings; frontend/code-generation giao 3.8 Flash Auto nếu model khả dụng, không âm thầm đổi model.
- Recheck/audit trong unified sync hiện tại; giữ backend làm audit. Router sync/account rotation vẫn concurrent.
- Không commit broad paths hay user edits. Commit từng task chỉ khi user yêu cầu; danh sách Files là phạm vi stage, không `git add src tests`.
- Đây là plan-only. Trước execution phải user review spec và chốt worker dùng để smoke. Không SSH mutate/live cutover trong bước lập plan.

## Evidence và phạm vi đã đọc

- `src/proxyfleet/enrollment.ts:16-115`: enrollment bắt buộc keys/endpoint WireGuard.
- `src/proxyfleet/db.ts:671-735,787-858`: bind theo wireguard_ip, enabled mặc định true; desired-state lấy endpoint enabled.
- `src/proxyfleet/runtime-api.ts:47-65`: handler thực tế bọc desired-state bằng WireGuard; `api-router.ts` còn duplicate desired-state/heartbeat routes. Cả hai phải thống nhất, không sửa nhầm route không được gọi.
- `src/proxyfleet/endpoint-audit.ts:8-60`: curl thực sự qua proxy, chưa so expected; tái dùng thay vì agent chỉ test port.
- `src/proxyfleet/pipeline-adapter.ts:44-71`: enabled endpoints được publish; early-return khi rỗng không đủ để thu hồi mappings cũ.
- `src/server/server.ts:134-166`: unified maintenance, controller bootstrap/runtime và pool cleanup; giữ lịch này.
- `agent/cmd/proxyfleet-agent/main.go:371-416,473-509`: guard/reconcile WireGuard; `agent/internal/config/config.go:13-27`, `controller/client.go:30-46` chứa saved/wire contracts cần migrate.
- Installer hiện dùng apt/systemd/nftables; auto-provision Linux amd64/arm64/armv7 có userland probe. Không giả claim Windows/OpenWrt auto-install. Giữ existing Windows development agent hoạt động.

## File map và ownership

| Nhóm | Existing files | New files |
|---|---|---|
| Persistence/gate | `src/proxyfleet/{db,types,security}.ts` | `src/proxyfleet/public-ip-gate.ts`, `tests/fleet-public-ip-gate.test.ts` |
| SSH + jobs | `package.json`, `package-lock.json`, `src/server/server.ts`, `src/proxyfleet/api-router.ts` | `src/proxyfleet/tailscale-ssh.ts`, `src/proxyfleet/provisioning.ts`, `tests/fleet-provisioning.test.ts` |
| Wire contracts | `src/proxyfleet/{enrollment,runtime-api}.ts`, `agent/internal/{config/config,controller/client}.go`, `agent/cmd/proxyfleet-agent/main.go` | none |
| Host bootstrap | `scripts/install-agent.sh`, `deploy/systemd/{3proxy,proxyfleet-agent}.service` | none |
| Audit/publish | `src/proxyfleet/{endpoint-audit,pipeline-adapter}.ts`, `src/server/{proxy-intelligence-repository,pool-ranker,server}.ts` | none |
| UI | `src/components/nodes/{enroll-worker-wizard,node-context-menu,node-runtime-card,delete-node-dialog}.tsx`, nodes/list/detail, monitoring, proxy-endpoints, help/settings pages, `src/lib/{api,types,fleet-ui-utils}.ts` | none |
| Old settings | `src/server/app-config.ts`, `src/components/nodes/wireguard-settings.tsx`, `src/proxyfleet/wireguard.ts` | historical cleanup retained only where referenced |
| Docs | `README.md`, `.env.example`, `docs/{deployment,operations,node-proxy-lifecycle-architecture,proxyfleet-architecture}.md` | this spec/plan |

File lists are explicit target scope; use LSP references before exported-symbol changes, then grep remaining symbol/value copies. Never rename/collapse history as active Tailscale aliases.

## Task 1: Pure address/public-IP policy

**Files:** Create `src/proxyfleet/public-ip-gate.ts`, `tests/fleet-public-ip-gate.test.ts`.

**Produces:**

```ts
export type FleetPublicIpStatus = 'unknown' | 'verified' | 'expected_mismatch' | 'duplicate' | 'lookup_failed';
export type IpDecision = { status: FleetPublicIpStatus; reason: string | null };
export function validateTailscaleIpv4(value: string): string;
export function validatePublicIpv4(value: string): string;
export function evaluatePublicIp(input: {
  observed: string | null;
  expected: string | null;
  activePeerIps: readonly string[];
}): IpDecision;
```

- [ ] Write deterministic behavior tests first. Test Tailscale lower/upper bounds, whitespace normalization, wrong family/private/non-global public address, null/malformed observation, mismatch before duplicate, optional expectation and duplicate. Use valid global fixture literals (e.g. `1.1.1.1`, `8.8.8.8`) without making network requests; reject documentation `203.0.113.0/24` as public input.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePublicIp, validateTailscaleIpv4 } from '../src/proxyfleet/public-ip-gate.js';
test('matching expectation still rejects duplicate active egress', () => {
  assert.equal(evaluatePublicIp({ observed: '1.1.1.1', expected: '1.1.1.1', activePeerIps: ['1.1.1.1'] }).status, 'duplicate');
  assert.equal(evaluatePublicIp({ observed: null, expected: null, activePeerIps: [] }).status, 'lookup_failed');
  assert.equal(validateTailscaleIpv4('100.64.0.0'), '100.64.0.0');
  assert.throws(() => validateTailscaleIpv4('100.128.0.1'));
});
```

- [ ] RED: `node --import tsx --test tests/fleet-public-ip-gate.test.ts`. Expected missing module/function; do not write implementation first.
- [ ] Implement with `net.isIPv4`, integer CIDR checks, explicit global-unicast exclusion ranges. Evaluation never treats empty observation as healthy. Gate produces status/reason only; provisioning/deployment readiness remains separate, so verified IP cannot prematurely enable node.
- [ ] GREEN: run whole new file. Actual runtime smoke: import and call gate in throwaway command; malformed/null/duplicate must produce non-verified statuses. Remove throwaway artifact.

## Task 2: Durable disabled inventory, migration and atomic activation

**Files:** `src/proxyfleet/{db,types,security}.ts`; tests `fleet-db.test.ts`, `fleet-state-safety.test.ts`; extend gate file types from Task 1.

**Schema:** Add `tailscale_ip TEXT UNIQUE` nullable, `expected_public_ip TEXT`, `public_ip_status TEXT NOT NULL DEFAULT 'unknown'`, `public_ip_checked_at INTEGER`, `proxy_activation TEXT NOT NULL DEFAULT 'disabled'`, activation reason, provision status/error. Keep `public_ip` observed address. Table `fleet_node_ssh` keyed node ID/FK cascade: username, encrypted password/salt/iv/tag, pinned SHA256 fingerprint, port. Public map exposes `credentialsSet` only.

**Produces repository methods:**

```ts
createTailscaleNode(input: { name: string; tailscaleIp: string; expectedPublicIp: string | null }): Promise<FleetNodeWithCamel>;
setNodeSshCredentials(nodeId: string, input: { username: string; password: string; port: number; hostKeyFingerprint: string }): Promise<void>;
getNodeSshCredentials(nodeId: string): Promise<{ username: string; password: string; port: number; hostKeyFingerprint: string } | null>;
recordProvisioningState(nodeId: string, input: { status: 'pending' | 'installing' | 'ready' | 'failed'; error: string | null }): Promise<void>;
recordPublicIpObservation(nodeId: string, observed: string | null): Promise<IpDecision>;
activateNode(nodeId: string): Promise<FleetNodeWithCamel>;
disableNode(nodeId: string, reason: string): Promise<void>;
```

- [ ] RED tests with real `:memory:` repo then file-backed two handles. Tests: encryption not plaintext; public list/detail never leaks; failures retain inventory; disabled node forces endpoint creation off/rejects enable patch; activation requires ready + fresh verified observation; two nodes same IP cannot both activate. Reopen DB preserves state/token/event history/controller; pending removal excluded from duplicate set. Run whole `fleet-db.test.ts fleet-state-safety.test.ts` before implementation.
- [ ] Migration must remove active `wireguard_ip NOT NULL` allocator dependency using SQLite table rebuild preserving all FKs/indexes and existing child rows. Legacy rows retain historical peer info in cleanup storage, not invented Tailscale IP. Mark legacy workers migration-required/disabled; controller role remains protected and local behavior intact. Validate `foreign_key_check` against migrated fixture and backup before live migration.
- [ ] `recordPublicIpObservation` runs gate against other activated non-removing worker rows within `BEGIN IMMEDIATE`; updates timestamp/public_ip/status, never enables by itself. `activateNode` rechecks readiness, observed/expected, duplicate/current revision transactionally, bumps desired revision and enables retained endpoint rows only when valid. Explicit stale/error status rejects, no browser proof.
- [ ] `disableNode` stores disabled state, sets all node endpoints disabled, increments revisions only on real change. All endpoint create/update/desired-state/list-enabled paths enforce node activation. Preserve raw endpoint rows and credentials for retry. Credential validation requires configured `FLEET_ENCRYPTION_KEY`; do not silently use default fallback for SSH secrets.
- [ ] GREEN: whole DB/state/gate modules; throwaway DB migration smoke proves legacy identity, indexes/FKs and activation race. No active aliases `wireguardIp = tailscaleIp`.

## Task 3: SSH transport and host bootstrap without secret leakage

**Files:** new `src/proxyfleet/tailscale-ssh.ts`, `tests/fleet-provisioning.test.ts`; modify installer, systemd units, package/lock, `.env.example`.

**Produces:**

```ts
export type SshTarget = { tailscaleIp: string; port: number };
export type SshCredentials = { username: string; password: string; hostKeyFingerprint: string };
export interface WorkerSsh {
  inspectHostKey(target: SshTarget): Promise<{ fingerprint: string }>;
  inspect(target: SshTarget, auth: SshCredentials): Promise<{ hostname: string; os: string; arch: string; publicIp: string | null }>;
  bootstrap(input: { target: SshTarget; auth: SshCredentials; nodeId: string; agentToken: string; controllerUrl: string }): Promise<void>;
  readPublicIp(target: SshTarget, auth: SshCredentials): Promise<string>;
}
```

- [ ] RED: one real local `ssh2.Server` fixture (test host key generated with Node crypto) covers correct password+pin, changed pin aborting before authentication, bad credentials, command deadline, oversized/malformed/failed public-IP response, output-secret redaction. Do not assert mock echoes or source text. Run whole provisioning test file.
- [ ] Add `ssh2` and `@types/ssh2` via package manager, then implement connection/command helper: fixed commands, closed streams on all exit/abort, bounded connect/command timeouts/output. Fingerprint inspection sends no password. Normal connections reject unpinned key before auth.
- [ ] Host preflight: verify supplied IP in `tailscale ip -4`/local interface, kernel versus userland architecture, supported Linux/systemd, `id -u` or `sudo -n true`, HTTPS controller reachability. Root or passwordless sudo only; failed preflight persists disabled error later in service.
- [ ] Installer consumes a private uploaded JSON/state file over SFTP or stdin; never embeds token/password in ExecStart/systemd args. Detect remote existing ProxyFleet identity and abort conflicts rather than adopt unrelated install. Same node retry is idempotent. Ship binary + verified checksum via pinned SSH; preserve prior working binary until execution/version check.
- [ ] Installer does not install WireGuard, generate keys or reference `wg-quick`. Tailscale listeners start empty, bind stored IP only. nftables scoped to owned table, `tailscale0`, allowlisted controller/router Tailscale sources and loopback; deny public access to managed range. Reject endpoint ports outside protected installer range unless firewall is updated atomically for that listener.
- [ ] Direct IP request: `curl -4 --noproxy '*' --proto '=https' --fail --silent --show-error --connect-timeout 3 --max-time 8 --max-filesize 1024 https://api.ipify.org`, clear proxy env; no user target/redirect credentials. Validate exactly one global IPv4. TLS verification stays on. No speculative failover subsystem.
- [ ] GREEN: whole transport file; `bash -n scripts/install-agent.sh`; controlled fixture exercises actual SSH authentication and remote command/SFTP contracts. Do not run installer on developer host.

## Task 4: Durable orchestration and single enrollment/desired-state contract

**Files:** new `src/proxyfleet/provisioning.ts`; `src/proxyfleet/{api-router,enrollment,runtime-api}.ts`, `src/server/server.ts`, agent client/config/main and matching tests.

**Consumes:** repository Task 2, `WorkerSsh` Task 3.

**Produces:**

```ts
export interface ProvisionRequest {
  name?: string; tailscaleIp: string; sshPort?: number;
  username: string; password: string; hostKeyFingerprint: string;
  expectedPublicIp?: string; controllerUrl: string;
}
export interface ProvisioningService {
  provision(input: ProvisionRequest): Promise<{ nodeId: string }>;
  retry(nodeId: string): Promise<void>;
  verifyAndActivate(nodeId: string): Promise<FleetNodeWithCamel>;
  disable(nodeId: string): Promise<void>;
}
```

Admin routes: `POST /api/fleet/ssh/host-key` (target only), `POST /api/fleet/nodes/provision`, `POST /api/fleet/nodes/:id/provision/retry`, `POST /api/fleet/nodes/:id/verify-and-activate`, `POST /api/fleet/nodes/:id/disable`. Provision returns 202 plus node ID; existing GET nodes/detail exposes durable progress/reason, never password. Admin auth/body limits before any connection; no arbitrary command endpoint.

- [ ] RED whole API/enrollment/integration modules plus provisioning service tests: no auth means no network; input invalid means no mutation; failed lookup/mismatch/duplicate keeps one disabled row, no installer; failed bootstrap keeps row, no activation; retry same IP reuses ID; process restart leaves interrupted job disabled; empty/malformed runtime heartbeat cannot override gate.
- [ ] Persist node+credentials first, then preflight/direct observation. Single-flight per node guards concurrent retries; no global scheduler/mutex. Durable `installing` jobs on restart become explicit failed/interrupted with retry action; no fake completion. Direct gate must pass before bootstrap; fresh gate check and successful ready state required for activation after bootstrap. Recheck removed/disabled identity after each await; late success cannot recreate/activate decommissioned node.
- [ ] Controller registers authoritative node ID/token and writes agent state over pinned SSH before service starts. Remove public worker enrollment/token allocation routes and old wizard path, rather than maintain second public enrollment contract; agent initial state is provisioned, not independently creating another node. Never trust remote-supplied identity/public-IP as activation evidence.
- [ ] Collapse duplicate heartbeat/desired-state handlers into single effective runtime route. Desired-state no longer includes WireGuard; preserves session/token/revision semantics and disabled node empty listeners. Controller local endpoint handling remains operational and role-protected.
- [ ] Go saved state uses `TailscaleIP`; retain node ID, token, pending report, revision and server URL. One-time state migration reads old state only to preserve identity, not synthesize IP; provision writes verified transport. Remove runtime WireGuard field/keys/RecordWireGuardCycle/hasOverlayProxy and key generation from active path, preserve capacity/deployment retry/device telemetry. Windows dev mode still runs diagnostics/version/agent with supplied state.
- [ ] GREEN: full `fleet-api.test.ts`, `fleet-enrollment.test.ts`, `fleet-agent-auth.test.ts`, `fleet-agent-integration.test.ts`, provisioning tests and `go test ./...` in `agent`. Tests for intentionally removed enrollment API should migrate to new consumer behavior, never weaken existing auth/revision assertions.

## Task 5: Backend forwarding audit, revocation and unified maintenance

**Files:** `src/proxyfleet/{endpoint-audit,pipeline-adapter,db}.ts`, `src/server/{server,proxy-intelligence-repository,pool-ranker}.ts`; `tests/fleet-pipeline-integration.test.ts`, `tests/unified-sync-coordinator.test.ts`, provisioning tests; use existing router fixture conventions.

**Consumes:** activation DB and `WorkerSsh.readPublicIp`; effective active endpoints are node-enabled + endpoint-enabled + successful current authenticated audit/deployment, never a TCP-open result alone.

- [ ] RED behavior tests: both HTTP/SOCKS5 authenticated forwarding match direct/expected IP; auth error/timeout/mismatch disables; previously published endpoints lose pool eligibility and references; empty active endpoint list still withdraws mappings; one disabled node does not remove shared imported proxy identity; audit completion from older revision cannot re-enable changed node. Run whole pipeline/sync files.
- [ ] Extract reusable actual curl audit path from existing endpoint-audit; force IPv4 HTTPS. Candidate endpoints can exist solely for validation before publication. Store actual proxy exit; compare against verified remote baseline and optional expectation. Never mark healthy on empty IP. Keep audit on backend, not browser or agent CheckPort.
- [ ] Disable/revoke writes DB state before external cleanup; send empty desired listeners and mark proxy rows ineligible before router I/O. Use existing unlink/remote pool unbind/delete and pending cleanup retry; failures remain explicit, never mark remote withdrawal complete. Preserve shared manually imported mappings.
- [ ] Wire remote-direct recheck and endpoint audit into existing unified maintenance; no second recurring loop. IP change/lookup failure disables and records warning, never automatically resumes after warning. First provision can activate, subsequent recovery uses explicit verify-and-activate with current observation/transaction checks.
- [ ] Pool ranker/account assignment must not select disabled/withdrawal-pending fleet endpoints even when old remoteId exists. Verify 9router host can reach tailnet addresses; reject publication if only controller can reach.
- [ ] GREEN full pipeline/coordinator files and integration smoke via real controlled proxy fixture; observe actual exit response and withdrawal state, not source/mocked forwarding assertions.

## Task 6: Shadcn operator flow and every active copy migration

**Files:** wizard/context/runtime/delete components; `src/app/(dashboard)/nodes/page.tsx`, `nodes/[id]/page.tsx`, `monitoring/page.tsx`, `proxy-endpoints/page.tsx`, `help/page.tsx`, affected settings section; `src/lib/{api,types,fleet-ui-utils}.ts`; existing runtime schemas/controller observer as needed.

- [ ] Trace LSP references of `FleetNodeRecord`, desired/runtime shapes, wireguard fields and API methods before changing exported symbols. List all callers, including nodes quick-create/detail, monitoring, context-menu copy, pending cleanup display and controller runtime.
- [ ] Replace wizard token/command generation with IP/user/password, optional expected IP and host fingerprint inspection/confirmation. Auto hostname/default port/controller URL; advanced overrides only where needed. Keep password ephemeral, clear submit success/dialog close, never localStorage.
- [ ] Show actual/expected IP, provision stage, separate heartbeat/activation badge and reason. `Verify & Activate` performs server check, no client-only enabled toggle; mismatch/duplicate retains row and disabled endpoint details. Root/unsupported host errors actionable; never success toast for still-pending operation.
- [ ] Update all endpoint create/copy/display paths to Tailscale address, not legacy alias. Distinguish controller local address and worker transport. Hide activation affordance for protected controller; keep controller inventory.
- [ ] Replace active WireGuard-only telemetry/errors/settings copy with truthful Tailscale connectivity. Preserve historical cleanup display and ownership warnings; remove false claims that host uninstall is retrying when no such service exists.
- [ ] Browser smoke actual 390px/desktop form, keyboard labels/focus, key confirmation/password clearing, progress, all blocked states and retry success. No permanent source-text/wording tests; delete obsolete wording checks, keep real formatting behavior tests. Run existing affected test files, not only new tests.

## Task 7: Cutover, historical cleanup, binaries and operations

**Files:** historical `src/proxyfleet/{wireguard,node-removal,db,types}.ts`, runtime API/settings/server active wiring; `src/server/app-config.ts`; `src/components/nodes/wireguard-settings.tsx`; agent WireGuard imports; docs/units/bin files named below.

- [ ] Reference search and classify every `wireguard_ip`, `wireguard_public_key`, `serverWireguard`, `10.77.`, `hasOverlayProxy`, `WireGuard setup`, `wg-quick@proxyfleet`, overlay approval symbol across src/agent/scripts/deploy/tests/docs. Use tool grep/LSP; not shell grep. Keep only historical migrations/owned cleanup, remove active setup/enrollment/reconcile/re-export/shim code.
- [ ] Legacy worker migration cannot infer tailnet IP; disable until explicit verified SSH reprovision on same identity. Preserve owned peer metadata/reservations in durable tombstones. Tailscale-only removal bypasses irrelevant WireGuard setup; historical peer removal still requires verified ownership/absence. Test both complete modules `fleet-wireguard.test.ts`, `fleet-wireguard-absence.test.ts`, API/DB removal suites, and controller guard.
- [ ] Keep unrelated host services/interfaces intact; old ProxyFleet artifacts removed only with ownership proof and verified replacement service. Do not delete whole `/etc/wireguard` or nftables ruleset. Historical uninstall remains separate and truthful.
- [ ] After all tests, rebuild distributed agent binaries from same source version, not stale committed artifacts:

```powershell
Push-Location agent
$env:GOOS='linux'; $env:GOARCH='amd64'; go build -o ../bin/proxyfleet-agent-linux-amd64 ./cmd/proxyfleet-agent
$env:GOARCH='arm64'; go build -o ../bin/proxyfleet-agent-linux-arm64 ./cmd/proxyfleet-agent
$env:GOARCH='arm'; $env:GOARM='7'; go build -o ../bin/proxyfleet-agent-linux-armv7 ./cmd/proxyfleet-agent
$env:GOOS='windows'; $env:GOARCH='amd64'; Remove-Item Env:GOARM -ErrorAction SilentlyContinue
go build -o ../bin/proxyfleet-agent.exe ./cmd/proxyfleet-agent
Remove-Item Env:GOOS,Env:GOARCH -ErrorAction SilentlyContinue
Pop-Location
```

Check each build exit before proceeding; publish SHA256 from binaries. Exercise Windows `--version`/`--diagnostics`, Linux binary on real disposable worker with matching userland; don't claim all cross-built binaries runtime-verified.
- [ ] Update README, env example, deployment/operations/architecture docs: normal SSH vs Tailscale SSH, secret key, host pin, reachability (including router), supported hosts, duplicate NAT, disabled recovery, migration/backup, actual uninstall boundary. No documentation claims beyond exercised smoke.

## Final verification and acceptance

Run once after integration, no simultaneous peer edits/formatters:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
Push-Location agent
go test ./...
Pop-Location
bash -n scripts/install-agent.sh
node --import tsx --test tests/fleet-wireguard.test.ts tests/fleet-wireguard-absence.test.ts tests/fleet-db.test.ts tests/fleet-state-safety.test.ts tests/fleet-api.test.ts tests/fleet-agent-integration.test.ts tests/fleet-pipeline-integration.test.ts tests/fleet-provisioning.test.ts tests/fleet-public-ip-gate.test.ts
```

- [ ] Failures are investigated, not tests weakened/pinned to new wording; whole affected modules run, not only expected-to-flip case. User edits remain untouched; if existing check fails, report exact blocker and evidence.
- [ ] Actual disposable tailnet smoke with approved host: record pinned fingerprint, userland arch, observed direct IPv4; install no-WireGuard worker; create authenticated HTTP and SOCKS5, actual forwarding exit matches, backend publishes only verified results.
- [ ] Repeat mismatch, duplicate against existing activated worker, lookup timeout, wrong password/host key, unsupported OS/sudo and bootstrap failure: node remains, disabled, no active pool assignment; active owner unchanged.
- [ ] Recovery, IP-change recheck, restart mid-provision, concurrent activation via two DB handles, late network completion after decommission, endpoint enable bypass and router cleanup failure exercised. Observe honest pending cleanup when remote stop/unbind cannot be confirmed.
- [ ] Browser surface proof then close tab. Compare unrelated `omp-pi`, Tailscale and firewall configuration before/after read-only; no host secrets in captured output.
- [ ] Consistency gate: LSP references + grep every active/historical matching symbol; no duplicate enrollment/desired handler, no old bind-IP alias, no unchecked endpoint mutation/publish path.
- [ ] Scope gate: review only task-owned diff; settings redesign/other concurrent work unchanged. Production scope is transport, gate, activation/revocation, required migration and docs, not unrelated rotator/watchdog/auditor changes.
- [ ] Completion report lists observed commands/outcomes, real-host versus fixture verification, unsupported platform limit and explicit blockers. Never claim physical host uninstall, router reachability or runtime binary coverage without proof.

## Dependency order and execution choice

Tasks 1–2 define shared contracts; Task 3 SSH transport can proceed independently once types stabilize. Task 4 integrates 2+3; Task 5 requires 2+4; Task 6 uses finalized API/fields and may run beside backend integration with one contract owner. Task 7 and final acceptance run after integration. Do not split shared DB/API edits across agents without explicit ownership.

Recommended execution: same-session task-by-task, independent SSH/backend/UI slices only after contracts are fixed. Alternative: separate session using executing-plans with checkpoints. User must review linked spec/plan before code execution; plan creation itself runs no production mutation, install or live provisioning.
