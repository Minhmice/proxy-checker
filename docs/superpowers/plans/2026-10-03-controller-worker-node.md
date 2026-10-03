# Controller-Worker Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register the controller host (VPS #1) as a first-class `controller-worker` node in ProxyFleet inventory capable of hosting managed proxy endpoints alongside worker nodes.

**Architecture:** Add `role` column to `fleet_nodes` table with backward-compatible defaults. Add idempotent `bootstrapControllerNode` method to FleetRepository. Update API routes and UI components to display node roles and isolate controller-worker proxy endpoints. Configure local agent and 3proxy services on VPS #1 to report via `127.0.0.1:1300` and bind to `10.77.0.1`.

**Tech Stack:** TypeScript, Node.js (v22), SQLite (`better-sqlite3`), Next.js App Router, Tailwind CSS, shadcn UI, systemd, 3proxy.

**Spec:** `docs/superpowers/specs/2026-10-03-controller-worker-node-design.md`

## Global Constraints

- Preserve backward compatibility with existing worker nodes: Raspberry Pi `worker-001` ID `c3670b4a-1024-496c-b89e-1f93f887ab27` and IP `10.77.0.11` must remain intact.
- Controller node must use fixed overlay IP `10.77.0.1` and role `controller-worker`.
- Controller bootstrap must be strictly idempotent: running it repeatedly must not create duplicate nodes or alter existing endpoints.
- Managed proxy endpoints on controller host must default to binding `10.77.0.1`, never unrestricted `0.0.0.0`.
- Never print or commit secrets, tokens, WireGuard private keys, or passwords.
- No automated aggressive watchdog reboots or Wake-on-LAN configurations.
- All systemd services (`proxy-control-dashboard`, `3proxy`, `proxyfleet-agent`) must be decoupled with independent failure recovery.

---

### Task 1: Extend Fleet DB Schema and Repository with Node Role and Idempotent Bootstrap

**Files:**
- Modify: `src/proxyfleet/types.ts`
- Modify: `src/proxyfleet/db.ts`
- Test: `tests/fleet-db.test.ts`

**Interfaces:**
- Produces:
  - `FleetNodeRole = "controller-worker" | "worker"`
  - `FleetNodeRecord.role: FleetNodeRole`
  - `FleetRepository.bootstrapControllerNode(input: BootstrapControllerNodeInput): Promise<FleetNodeWithCamel>`
- Consumes: Existing SQLite connection and migration logic in `src/proxyfleet/db.ts`

- [ ] **Step 1: Write the failing test**
Add a test in `tests/fleet-db.test.ts` verifying that `migrate()` adds `role`, existing nodes default to `"worker"`, and `bootstrapControllerNode()` idempotently creates and preserves the controller-worker node:

```typescript
test("fleet repository supports node role and idempotent controller bootstrap", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-role-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();

    // 1. Regular worker node creation defaults to role "worker"
    const worker = await repo.createNode({
      id: "node-worker-01",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
    });
    assert.equal(worker.role, "worker");

    // 2. Idempotent controller-worker bootstrap
    const ctrl1 = await repo.bootstrapControllerNode({
      id: "controller-node-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
      os: "Linux",
      arch: "x86_64",
    });
    assert.equal(ctrl1.role, "controller-worker");
    assert.equal(ctrl1.wireguardIp, "10.77.0.1");

    // 3. Second bootstrap call must return same node without duplicating
    const ctrl2 = await repo.bootstrapControllerNode({
      id: "controller-node-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
      os: "Linux",
      arch: "x86_64",
    });
    assert.equal(ctrl2.id, ctrl1.id);

    const allNodes = await repo.listNodes();
    assert.equal(allNodes.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/fleet-db.test.ts`
Expected: FAIL with compilation or assertion error on `role` or `bootstrapControllerNode`.

- [ ] **Step 3: Implement schema migration and repository method**
In `src/proxyfleet/types.ts`:
```typescript
export type FleetNodeRole = "controller-worker" | "worker";

export interface FleetNodeRecord {
  id: string;
  name: string;
  role: FleetNodeRole;
  status: FleetNodeStatus;
  public_ip: string | null;
  wireguard_ip: string;
  wireguard_public_key: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  last_heartbeat_at: number | null;
  created_at: number;
  updated_at: number;
}
```

In `src/proxyfleet/db.ts`:
Update migration to add `role TEXT NOT NULL DEFAULT 'worker'` column if missing.
Add `BootstrapControllerNodeInput` interface:
```typescript
export interface BootstrapControllerNodeInput {
  id?: string;
  name?: string;
  wireguardIp?: string;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
}
```
Implement `bootstrapControllerNode(input: BootstrapControllerNodeInput): Promise<FleetNodeWithCamel>`:
```typescript
async bootstrapControllerNode(input: BootstrapControllerNodeInput): Promise<FleetNodeWithCamel> {
  const existing = this.db.prepare(
    "SELECT * FROM fleet_nodes WHERE role = 'controller-worker' OR wireguard_ip = '10.77.0.1' LIMIT 1"
  ).get() as Record<string, unknown> | undefined;

  if (existing) {
    return this.mapNode(existing)!;
  }

  const id = input.id || "controller-node-master";
  const name = input.name || "controller-001";
  const wireguardIp = input.wireguardIp || "10.77.0.1";
  const now = Date.now();

  this.db.prepare(`
    INSERT INTO fleet_nodes (
      id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, last_heartbeat_at, created_at, updated_at
    ) VALUES (?, ?, 'controller-worker', 'online', NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    wireguardIp,
    input.os || null,
    input.arch || null,
    input.agentVersion || null,
    now,
    now,
    now
  );

  return (await this.getNode(id))!;
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/fleet-db.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/proxyfleet/types.ts src/proxyfleet/db.ts tests/fleet-db.test.ts
git commit -m "feat(fleet-db): add node role and idempotent controller bootstrap"
```

---

### Task 2: Expose Node Role in API Router and Trigger Controller Bootstrap on Startup

**Files:**
- Modify: `src/proxyfleet/api-router.ts`
- Modify: `src/server/server.ts`
- Test: `tests/fleet-api.test.ts`

**Interfaces:**
- Consumes: `repo.bootstrapControllerNode`, `node.role`
- Produces: `role` field in `GET /api/fleet/nodes` and `GET /api/fleet/nodes/:id` responses

- [ ] **Step 1: Write the failing test**
Add a test in `tests/fleet-api.test.ts` verifying that `GET /api/fleet/nodes` includes `role: "controller-worker"` and `role: "worker"`:

```typescript
test("GET /api/fleet/nodes returns node roles for both controller and worker", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-role-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");
  const repo = createFleetRepository({ sqlitePath: dbPath });

  try {
    await repo.migrate();
    await repo.bootstrapControllerNode({
      id: "ctrl-01",
      name: "controller-001",
      wireguardIp: "10.77.0.1",
    });
    await repo.createNode({
      id: "worker-01",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
      role: "worker",
    });

    const handler = createFleetApiHandler({
      repo,
      verifyAuth: () => true,
    });

    const { req, res } = createMockRequestResponse("GET", "/api/fleet/nodes", {
      authorization: "Basic " + Buffer.from("admin:pass").toString("base64"),
    });

    const handled = await handler(req, res, "/api/fleet/nodes");
    assert.equal(handled, true);
    assert.equal(res.statusCode, 200);

    const body = res.body as { nodes: Array<{ id: string; role: string }> };
    assert.equal(body.nodes.length, 2);
    const ctrlNode = body.nodes.find((n) => n.id === "ctrl-01");
    assert.equal(ctrlNode?.role, "controller-worker");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/fleet-api.test.ts`
Expected: FAIL if `role` is omitted or unhandled.

- [ ] **Step 3: Update api-router and server startup**
In `src/proxyfleet/api-router.ts`:
Ensure node serialization maps `role` from database record to JSON payload.

In `src/server/server.ts`:
Trigger `bootstrapControllerNode` during server startup right after migration:
```typescript
await fleetRepo.migrate();
await fleetRepo.bootstrapControllerNode({
  name: "controller-001",
  wireguardIp: "10.77.0.1",
  os: process.platform,
  arch: process.arch,
  agentVersion: "0.1.0",
}).catch((err) => console.error("Controller node bootstrap failed:", err));
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- tests/fleet-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/proxyfleet/api-router.ts src/server/server.ts tests/fleet-api.test.ts
git commit -m "feat(fleet-api): expose node role and auto-bootstrap controller node"
```

---

### Task 3: Update Dashboard UI with Node Role Formatting and Badges

**Files:**
- Modify: `src/lib/fleet-ui-utils.ts`
- Modify: `src/app/(dashboard)/nodes/page.tsx`
- Modify: `src/app/(dashboard)/nodes/[id]/page.tsx`
- Modify: `src/app/(dashboard)/monitoring/page.tsx`
- Test: `tests/fleet-ui-contract.test.ts`

**Interfaces:**
- Produces: `formatFleetNodeRole(role?: string): { label: string; badgeVariant: "default" | "secondary" | "outline" }`
- Consumes: `FleetNodeRecord.role`

- [ ] **Step 1: Write the failing test**
In `tests/fleet-ui-contract.test.ts`, add:

```typescript
test("fleet ui utils formats node role accurately", () => {
  const ctrl = formatFleetNodeRole("controller-worker");
  assert.equal(ctrl.label, "Controller + Worker");
  assert.equal(ctrl.badgeVariant, "default");

  const worker = formatFleetNodeRole("worker");
  assert.equal(worker.label, "Worker");
  assert.equal(worker.badgeVariant, "secondary");

  const fallback = formatFleetNodeRole(undefined);
  assert.equal(fallback.label, "Worker");
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- tests/fleet-ui-contract.test.ts`
Expected: FAIL with `formatFleetNodeRole is not a function`.

- [ ] **Step 3: Implement role formatting and update UI pages**
In `src/lib/fleet-ui-utils.ts`:
```typescript
export function formatFleetNodeRole(role?: string): {
  label: string;
  badgeVariant: "default" | "secondary" | "outline";
} {
  if (role === "controller-worker") {
    return { label: "Controller + Worker", badgeVariant: "default" };
  }
  return { label: "Worker", badgeVariant: "secondary" };
}
```

In `src/app/(dashboard)/nodes/page.tsx`:
Add Role column in `<TableHead>` and display `<Badge variant={roleInfo.badgeVariant}>{roleInfo.label}</Badge>`.

In `src/app/(dashboard)/nodes/[id]/page.tsx`:
Display role badge next to node name and status badge in header.

In `src/app/(dashboard)/monitoring/page.tsx`:
Display role badge in telemetry table.

- [ ] **Step 4: Run tests and build to verify UI compiles cleanly**
Run:
```bash
npm test -- tests/fleet-ui-contract.test.ts
npm run typecheck
npm run build
```
Expected: PASS, 0 type errors, build succeeded.

- [ ] **Step 5: Commit**
```bash
git add src/lib/fleet-ui-utils.ts src/app/\(dashboard\)/nodes/page.tsx src/app/\(dashboard\)/nodes/\[id\]/page.tsx src/app/\(dashboard\)/monitoring/page.tsx tests/fleet-ui-contract.test.ts
git commit -m "feat(ui): display node role badges in fleet nodes and monitoring tables"
```

---

### Task 4: Deploy Controller Agent & Local 3proxy Services on VPS #1

**Files:**
- Create/Deploy: `/etc/proxyfleet/state.json` (on VPS #1)
- Create/Deploy: `/etc/systemd/system/proxyfleet-agent-controller.service` (on VPS #1)
- Verify: Remote HTTP API and service status

**Interfaces:**
- Consumes: Running controller dashboard service on `:1300`, pre-compiled `proxyfleet-agent-linux-amd64`
- Produces: Active `proxyfleet-agent-controller.service` sending heartbeats via `http://127.0.0.1:1300` and executing 3proxy configuration updates.

- [ ] **Step 1: Check controller node registration in live DB**
Execute query to verify `bootstrapControllerNode` created `controller-001` on VPS #1.
Run:
```bash
curl -s -u admin:minhmice2026@ http://100.73.175.42:1300/api/fleet/nodes | grep -o '"role":"controller-worker"'
```
Expected: Match found.

- [ ] **Step 2: Provision state and systemd unit on VPS #1**
Write `/etc/proxyfleet/controller-state.json` with `node_id` matching the bootstrapped controller node, `server_url: "http://127.0.0.1:1300"`, and `wireguard_ip: "10.77.0.1"`.
Create `/etc/systemd/system/proxyfleet-agent-controller.service`:
```ini
[Unit]
Description=ProxyFleet Controller Local Agent
After=network-online.target proxy-control-dashboard.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/proxyfleet/bin/proxyfleet-agent-linux-amd64 --server http://127.0.0.1:1300 --node-name controller-001 --config-dir /etc/proxyfleet/controller --proxy-config /etc/3proxy/3proxy.cfg
Restart=on-failure
RestartSec=15
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Start and enable services on VPS #1**
```bash
systemctl daemon-reload
systemctl enable proxyfleet-agent-controller.service 3proxy.service
systemctl restart proxyfleet-agent-controller.service 3proxy.service
```

- [ ] **Step 4: Verify live heartbeats and endpoints**
Run:
```bash
curl -s -u admin:minhmice2026@ http://100.73.175.42:1300/api/fleet/nodes
```
Verify that both nodes (`controller-001` with `role: "controller-worker"` and `worker-001` with `role: "worker"`) report `status: "online"` and heartbeat freshness within 30 seconds.

- [ ] **Step 5: Run full test suite regression**
```bash
npm run test:fleet
```
Expected: All fleet test suites pass.
