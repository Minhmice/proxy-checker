# Fleet Configuration Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide trustworthy, explicit proof of 3proxy configuration convergence across Fleet nodes, decoupled from WireGuard heartbeat liveness, with durable deployment history, monotonic revision guards, reliable agent report delivery, and clear operator indicators.

**Architecture:** Extend `fleet_nodes` with convergence columns and expose a nested `configuration` view in API responses; activate `fleet_deployments` append-only history; enforce monotonic revision gating and atomic history/event updates in `api-router.ts` and `db.ts`; persist unacknowledged reports in `proxyfleet-agent` state for reliable delivery across cycles; surface dual-axis (Agent Liveness + Configuration Convergence) UI across Nodes list, Node detail, and Proxy Endpoints.

**Tech Stack:** TypeScript, Node.js (`node:sqlite`, `node:test`, `node:assert/strict`), React 19, Next.js 16, Tailwind CSS, Go 1.22 (`proxyfleet-agent`).

**Spec:** `docs/superpowers/specs/2026-10-11-fleet-configuration-convergence-design.md`

## Global Constraints

- Never conflate WireGuard agent heartbeat with 3proxy data-plane configuration convergence.
- Legacy nodes without deployment evidence remain configuration status `unknown` with null `applied_revision`; never synthesize `applied = desired`.
- Stale or duplicate deployment reports must return acknowledgement without advancing state or inserting duplicate history/events.
- Report delivery retry on the agent must use the existing state file and cycle without new timers or re-applying configuration.
- The UI must distinguish Agent Liveness (Online/Offline) from Configuration (Applied/Pending/Failed/Unknown), and never label configuration convergence as "Endpoint healthy".

---

### Task 1: Schema Migration & FleetNodeConfiguration Types

**Files:**
- Modify: `src/proxyfleet/types.ts`
- Modify: `src/proxyfleet/db.ts`
- Test: `tests/fleet-configuration-convergence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FleetConfigurationStatus = "pending" | "applied" | "failed" | "unknown";

  export interface FleetNodeConfigurationView {
    status: FleetConfigurationStatus;
    desiredRevision: number;
    appliedRevision: number | null;
    deploymentRevision: number | null;
    error: string | null;
    updatedAt: number | null;
  }
  ```
- Consumes: Existing `DatabaseSync` in `src/proxyfleet/db.ts`.

- [ ] **Step 1: Write the failing test for schema migration and default unknown configuration mapping**

Create `tests/fleet-configuration-convergence.test.ts`:
```ts
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createFleetRepository } from "../src/proxyfleet/db.js";

test("convergence: migration adds convergence columns and maps legacy nodes to unknown status", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-convergence-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");

  try {
    const rawDb = new DatabaseSync(dbPath);
    // Legacy schema without convergence columns
    rawDb.exec(`
      CREATE TABLE fleet_nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'worker',
        status TEXT NOT NULL DEFAULT 'offline',
        public_ip TEXT,
        wireguard_ip TEXT NOT NULL UNIQUE,
        wireguard_public_key TEXT,
        os TEXT,
        arch TEXT,
        agent_version TEXT,
        last_heartbeat_at INTEGER,
        desired_revision INTEGER NOT NULL DEFAULT 1,
        agent_token_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE fleet_proxy_endpoints (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        protocol TEXT NOT NULL,
        listen_ip TEXT NOT NULL,
        listen_port INTEGER NOT NULL,
        egress_id TEXT,
        username TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        current_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE fleet_deployments (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL REFERENCES fleet_nodes(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        config_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        error_message TEXT,
        applied_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE fleet_events (
        id TEXT PRIMARY KEY,
        node_id TEXT,
        endpoint_id TEXT,
        event_type TEXT NOT NULL,
        level TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    rawDb.prepare(`
      INSERT INTO fleet_nodes (
        id, name, role, status, public_ip, wireguard_ip, wireguard_public_key, os, arch, agent_version, last_heartbeat_at, desired_revision, created_at, updated_at
      ) VALUES ('legacy-node-1', 'worker-1', 'worker', 'offline', NULL, '10.77.0.21', NULL, 'linux', 'arm64', '0.1.0', NULL, 3, 1000, 1000)
    `).run();
    rawDb.close();

    const repo = createFleetRepository(dbPath);
    const node = repo.getNode("legacy-node-1");

    assert.ok(node, "node must exist");
    assert.equal(node.desired_revision, 3);
    assert.equal(node.applied_revision, null);
    assert.equal(node.deployment_status, "unknown");
    assert.equal(node.deployment_error, null);
    assert.equal(node.deployment_updated_at, null);
    assert.deepEqual(node.configuration, {
      status: "unknown",
      desiredRevision: 3,
      appliedRevision: null,
      deploymentRevision: null,
      error: null,
      updatedAt: null,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: FAIL because convergence columns and `node.configuration` are not defined.

- [ ] **Step 3: Update `src/proxyfleet/types.ts` and `src/proxyfleet/db.ts`**

In `src/proxyfleet/types.ts`:
```ts
export type FleetConfigurationStatus = "pending" | "applied" | "failed" | "unknown";

export interface FleetNodeConfigurationView {
  status: FleetConfigurationStatus;
  desiredRevision: number;
  appliedRevision: number | null;
  deploymentRevision: number | null;
  error: string | null;
  updatedAt: number | null;
}
```
Add fields to `FleetNodeRecord` and `FleetNodeWithCamel`:
- `applied_revision: number | null;`
- `deployment_revision: number | null;`
- `deployment_status: FleetConfigurationStatus;`
- `deployment_error: string | null;`
- `deployment_updated_at: number | null;`
- `configuration: FleetNodeConfigurationView;`

In `src/proxyfleet/db.ts`:
- Update `CREATE TABLE IF NOT EXISTS fleet_nodes` to include:
  `applied_revision INTEGER,`
  `deployment_revision INTEGER,`
  `deployment_status TEXT NOT NULL DEFAULT 'unknown',`
  `deployment_error TEXT,`
  `deployment_updated_at INTEGER,`
- In migration block checking `columnNames`, add migration for missing convergence columns (`applied_revision`, `deployment_revision`, `deployment_status`, `deployment_error`, `deployment_updated_at`).
- In `mapNode()`, derive `configuration`:
  ```ts
  const appliedRevision = row.applied_revision != null ? Number(row.applied_revision) : null;
  const deploymentRevision = row.deployment_revision != null ? Number(row.deployment_revision) : null;
  const deploymentStatus = (row.deployment_status as FleetConfigurationStatus) || "unknown";
  const deploymentError = row.deployment_error ? String(row.deployment_error) : null;
  const deploymentUpdatedAt = row.deployment_updated_at != null ? Number(row.deployment_updated_at) : null;

  const configuration: FleetNodeConfigurationView = {
    status: deploymentStatus,
    desiredRevision,
    appliedRevision,
    deploymentRevision,
    error: deploymentError,
    updatedAt: deploymentUpdatedAt,
  };
  ```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/proxyfleet/types.ts src/proxyfleet/db.ts tests/fleet-configuration-convergence.test.ts
git commit -m "feat(fleet): add configuration convergence schema and types"
```

---

### Task 2: Repository Transaction & Deployment Recording with Stale/Monotonic Guards

**Files:**
- Modify: `src/proxyfleet/db.ts`
- Test: `tests/fleet-configuration-convergence.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface RecordDeploymentResultInput {
    nodeId: string;
    revision: number;
    configDigest: string;
    status: "applied" | "failed";
    errorMessage?: string;
  }

  export interface RecordDeploymentResultOutcome {
    ok: boolean;
    accepted: boolean;
    reason?: "stale_revision" | "duplicate_revision" | "node_not_found" | "future_revision";
    node?: FleetNodeWithCamel;
  }
  ```
- Consumes: `createFleetRepository` in `src/proxyfleet/db.ts`.

- [ ] **Step 1: Write failing tests for deployment result recording rules**

Append to `tests/fleet-configuration-convergence.test.ts`:
```ts
test("convergence: recordDeploymentResult updates state atomically and enforces monotonic guards", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-convergence-rules-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");

  try {
    const repo = createFleetRepository(dbPath);
    const node = repo.createNode({
      name: "worker-test",
      wireguardIp: "10.77.0.30",
    });

    // Node starts at desired_revision = 1, configuration status = unknown
    assert.equal(node.desired_revision, 1);
    assert.equal(node.configuration.status, "unknown");

    // Advance desired revision to 2
    repo.updateNodeDesiredRevision(node.id, 2);
    const pendingNode = repo.getNode(node.id)!;
    assert.equal(pendingNode.desired_revision, 2);
    assert.equal(pendingNode.configuration.status, "pending");

    // 1. Submit failed result for revision 2
    const failOutcome = repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "digest-rev2",
      status: "failed",
      errorMessage: "bind port 20001: address already in use",
    });
    assert.equal(failOutcome.ok, true);
    assert.equal(failOutcome.accepted, true);

    const failedNode = repo.getNode(node.id)!;
    assert.equal(failedNode.configuration.status, "failed");
    assert.equal(failedNode.configuration.desiredRevision, 2);
    assert.equal(failedNode.configuration.appliedRevision, null);
    assert.equal(failedNode.configuration.deploymentRevision, 2);
    assert.equal(failedNode.configuration.error, "bind port 20001: address already in use");

    // Liveness remains offline (no heartbeat), not altered by deployment failure
    assert.equal(failedNode.status, "offline");

    // 2. Stale report: delayed report for revision 1 must be rejected
    const staleOutcome = repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 1,
      configDigest: "digest-rev1",
      status: "applied",
    });
    assert.equal(staleOutcome.ok, true);
    assert.equal(staleOutcome.accepted, false);
    assert.equal(staleOutcome.reason, "stale_revision");

    // Node state unchanged
    const afterStale = repo.getNode(node.id)!;
    assert.equal(afterStale.configuration.status, "failed");
    assert.equal(afterStale.configuration.deploymentRevision, 2);

    // 3. Same-revision retry: applied report for revision 2 supersedes previous failure
    const successOutcome = repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "digest-rev2",
      status: "applied",
    });
    assert.equal(successOutcome.ok, true);
    assert.equal(successOutcome.accepted, true);

    const successNode = repo.getNode(node.id)!;
    assert.equal(successNode.configuration.status, "applied");
    assert.equal(successNode.configuration.desiredRevision, 2);
    assert.equal(successNode.configuration.appliedRevision, 2);
    assert.equal(successNode.configuration.deploymentRevision, 2);
    assert.equal(successNode.configuration.error, null);

    // 4. Duplicate success report acknowledged without re-inserting
    const duplicateOutcome = repo.recordDeploymentResult({
      nodeId: node.id,
      revision: 2,
      configDigest: "digest-rev2",
      status: "applied",
    });
    assert.equal(duplicateOutcome.ok, true);
    assert.equal(duplicateOutcome.accepted, false);
    assert.equal(duplicateOutcome.reason, "duplicate_revision");

    // Verify fleet_deployments has 2 records (1 fail, 1 success)
    const deployments = repo.getNodeDeployments(node.id);
    assert.equal(deployments.length, 2);
    assert.equal(deployments[0].status, "applied");
    assert.equal(deployments[1].status, "failed");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: FAIL because `recordDeploymentResult`, `updateNodeDesiredRevision`, `getNodeDeployments` are missing.

- [ ] **Step 3: Implement `recordDeploymentResult`, `getNodeDeployments`, and transition hooks in `src/proxyfleet/db.ts`**

In `src/proxyfleet/db.ts`:
1. Add `updateNodeDesiredRevision(nodeId: string, desiredRevision: number): void`:
   ```ts
   this.db.prepare(`
     UPDATE fleet_nodes
     SET desired_revision = ?,
         deployment_status = 'pending',
         deployment_error = NULL,
         updated_at = ?
     WHERE id = ?
   `).run(desiredRevision, Date.now(), nodeId);
   ```
   Also update existing `createProxyEndpoint` and `updateProxyEndpoint` where `nextRevision` is updated to set `deployment_status = 'pending'` and `deployment_error = NULL`.

2. Add `recordDeploymentResult(input: RecordDeploymentResultInput): RecordDeploymentResultOutcome`:
   Inside `BEGIN IMMEDIATE;`:
   - Fetch node row. If missing, return `{ ok: false, accepted: false, reason: "node_not_found" }`.
   - Validate `input.revision <= nodeRow.desired_revision`. If greater, rollback and return `{ ok: false, accepted: false, reason: "future_revision" }`.
   - Read `deployment_revision` (latest reported watermark) and `applied_revision`.
   - If `input.revision < (nodeRow.deployment_revision ?? 0)`:
     Rollback and return `{ ok: true, accepted: false, reason: "stale_revision" }`.
   - If `input.revision === nodeRow.deployment_revision`:
     - If `nodeRow.deployment_status === 'applied'`:
       Rollback and return `{ ok: true, accepted: false, reason: "duplicate_revision" }`.
     - If `input.status === 'failed'` and already failed with same error:
       Rollback and return `{ ok: true, accepted: false, reason: "duplicate_revision" }`.
     - Otherwise (i.e. `input.status === 'applied'` superseding a previous failure for the same revision): accept.
   - Insert row into `fleet_deployments` (`id`, `node_id`, `revision`, `config_digest`, `status`, `error_message`, `applied_at`, `created_at`).
   - Insert corresponding audit event into `fleet_events`.
   - Calculate updated node configuration fields:
     - `newDeploymentRevision = Math.max(input.revision, Number(nodeRow.deployment_revision) || 0)`
     - If `input.status === 'applied'`:
       - `newAppliedRevision = Math.max(input.revision, Number(nodeRow.applied_revision) || 0)`
       - `newStatus = input.revision === Number(nodeRow.desired_revision) ? 'applied' : 'pending'`
       - `newError = null`
     - If `input.status === 'failed'`:
       - `newAppliedRevision = nodeRow.applied_revision`
       - `newStatus = input.revision === Number(nodeRow.desired_revision) ? 'failed' : 'pending'`
       - `newError = input.errorMessage?.slice(0, 2048) || "Deployment failed"`
   - Update `fleet_nodes` with `applied_revision`, `deployment_revision`, `deployment_status`, `deployment_error`, `deployment_updated_at`.
   - `COMMIT;`
   - Return `{ ok: true, accepted: true, node: this.mapNode(updatedNode)! }`.

3. Add `getNodeDeployments(nodeId: string, limit = 20): FleetDeploymentRecord[]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/proxyfleet/db.ts tests/fleet-configuration-convergence.test.ts
git commit -m "feat(fleet): implement atomic deployment result recording with monotonic guards"
```

---

### Task 3: Controller API Validation & Deployment-Result Router

**Files:**
- Modify: `src/proxyfleet/api-router.ts`
- Test: `tests/fleet-configuration-convergence.test.ts`

**Interfaces:**
- Produces:
  - HTTP `POST /api/fleet/agent/deployment-result` returns `{ ok: true, accepted: boolean, reason?: string }` (or HTTP 400 for bad input).
  - HTTP `GET /api/fleet/nodes` and `GET /api/fleet/nodes/:id` include `configuration` in each node object.
- Consumes: `repo.recordDeploymentResult` in `src/proxyfleet/db.ts`.

- [ ] **Step 1: Write failing test for controller API endpoints**

Append to `tests/fleet-configuration-convergence.test.ts`:
```ts
import http from "node:http";
import { createFleetApiRouter } from "../src/proxyfleet/api-router.js";
import { createFleetEnrollmentService } from "../src/proxyfleet/enrollment.js";

test("convergence: api-router validates deployment-result and exposes configuration view", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-api-test-"));
  const dbPath = path.join(tmpDir, "fleet.sqlite3");

  try {
    const repo = createFleetRepository(dbPath);
    const enrollment = createFleetEnrollmentService(repo);
    const token = repo.createEnrollmentToken({ nodeName: "api-worker" });

    // Enroll node to get agent token
    const enrolled = await enrollment.enrollNode({
      token: token.token,
      nodeName: "api-worker",
      wireguardPublicKey: "mock-wg-pubkey",
    });

    const handler = createFleetApiRouter({
      repo,
      enrollmentService: enrollment,
      verifyAuth: (pass) => pass === "adminpass",
    });

    // Helper to simulate HTTP requests
    async function request(options: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: unknown;
    }): Promise<{ status: number; body: any }> {
      const { promise, resolve } = Promise.withResolvers<{ status: number; body: any }>();
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        const handled = await handler(req, res, url.pathname);
        if (!handled) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
      server.listen(0, async () => {
        const port = (server.address() as any).port;
        const res = await fetch(`http://localhost:${port}${options.url}`, {
          method: options.method,
          headers: {
            "Content-Type": "application/json",
            ...options.headers,
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        });
        const data = await res.json();
        server.close(() => {
          resolve({ status: res.status, body: data });
        });
      });
      return promise;
    }

    // 1. Submit invalid deployment result (missing nodeId) -> 400
    const invalidRes = await request({
      method: "POST",
      url: "/api/fleet/agent/deployment-result",
      headers: { Authorization: `Bearer ${enrolled.agentToken}` },
      body: { status: "invalid_status", revision: -1 },
    });
    assert.equal(invalidRes.status, 400);

    // 2. Submit valid deployment result -> 200 { ok: true, accepted: true }
    const validRes = await request({
      method: "POST",
      url: "/api/fleet/agent/deployment-result",
      headers: { Authorization: `Bearer ${enrolled.agentToken}` },
      body: {
        nodeId: enrolled.nodeId,
        revision: 1,
        configDigest: "digest-1",
        status: "applied",
      },
    });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.body.ok, true);
    assert.equal(validRes.body.accepted, true);

    // 3. Verify GET /api/fleet/nodes returns configuration object
    const nodesRes = await request({
      method: "GET",
      url: "/api/fleet/nodes",
      headers: { Authorization: "Bearer adminpass" },
    });
    assert.equal(nodesRes.status, 200);
    const workerNode = nodesRes.body.nodes.find((n: any) => n.id === enrolled.nodeId);
    assert.ok(workerNode);
    assert.deepEqual(workerNode.configuration, {
      status: "applied",
      desiredRevision: 1,
      appliedRevision: 1,
      deploymentRevision: 1,
      error: null,
      updatedAt: workerNode.configuration.updatedAt,
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: FAIL because `api-router.ts` doesn't validate or delegate deployment-result to `repo.recordDeploymentResult`.

- [ ] **Step 3: Update `src/proxyfleet/api-router.ts`**

In `src/proxyfleet/api-router.ts`:
1. In `POST /api/fleet/agent/deployment-result`:
   - Validate `nodeId` (nonempty string <= 128 chars).
   - Check `await authenticateAgent(req, res, nodeId)`.
   - Validate `revision`: positive safe integer.
   - Validate `status`: must be `"applied"` or `"failed"`.
   - Validate `configDigest`: string <= 128 chars.
   - Validate `errorMessage`: optional string <= 2048 chars.
   - Call `const outcome = repo.recordDeploymentResult({ nodeId, revision, configDigest, status, errorMessage })`.
   - If `outcome.reason === "future_revision"`: `sendJson(res, 400, { error: "Revision exceeds desired revision" })`.
   - If `outcome.reason === "node_not_found"`: `sendJson(res, 404, { error: "Node not found" })`.
   - Otherwise: `sendJson(res, 200, { ok: outcome.ok, accepted: outcome.accepted, reason: outcome.reason })`.
2. In `GET /api/fleet/nodes/:id`:
   - Ensure the response payload `{ node, endpoints, events }` includes `node.configuration` and add `deployments: repo.getNodeDeployments(nodeId)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-configuration-convergence.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add src/proxyfleet/api-router.ts tests/fleet-configuration-convergence.test.ts
git commit -m "feat(fleet): add controller API validation and deployment result handler"
```

---

### Task 4: Agent Persistent Report Delivery & Cycle Retry

**Files:**
- Modify: `agent/internal/config/config.go`
- Modify: `agent/cmd/proxyfleet-agent/main.go`
- Modify: `agent/internal/config/config_test.go`
- Modify: `agent/cmd/proxyfleet-agent/main_test.go`

**Interfaces:**
- Produces:
  ```go
  type State struct {
    // ... existing fields ...
    PendingReport *controller.DeploymentResultRequest `json:"pending_report,omitempty"`
  }
  ```
- Consumes: `client.ReportDeploymentResult` in `agent/internal/controller/client.go`.

- [ ] **Step 1: Write failing test in `agent/internal/config/config_test.go` for PendingReport persistence**

Add test in `agent/internal/config/config_test.go`:
```go
func TestConfigPendingReportPersistence(t *testing.T) {
	dir := t.TempDir()
	mgr := config.NewManager(dir)

	pending := &controller.DeploymentResultRequest{
		NodeID:       "node-retry-1",
		Revision:     5,
		ConfigDigest: "digest-sha256",
		Status:       "applied",
		ErrorMessage: "",
	}

	state := &config.State{
		ServerURL:     "https://control.example.com",
		NodeID:        "node-retry-1",
		AgentToken:    "fla_test_token",
		LastRevision:  5,
		PendingReport: pending,
	}

	if err := mgr.Save(state); err != nil {
		t.Fatalf("save state error: %v", err)
	}

	loaded, err := mgr.Load()
	if err != nil {
		t.Fatalf("load state error: %v", err)
	}

	if loaded.PendingReport == nil {
		t.Fatalf("expected PendingReport to be preserved, got nil")
	}
	if loaded.PendingReport.Revision != 5 || loaded.PendingReport.Status != "applied" {
		t.Errorf("unexpected PendingReport: %+v", loaded.PendingReport)
	}
}
```

- [ ] **Step 2: Run Go test to verify it fails**

Run: `go test -v ./agent/internal/config/...`
Expected: FAIL because `PendingReport` field does not exist on `State`.

- [ ] **Step 3: Update `agent/internal/config/config.go` and `agent/cmd/proxyfleet-agent/main.go`**

1. In `agent/internal/config/config.go`:
   Import `proxyfleet/agent/internal/controller` and add:
   ```go
   PendingReport *controller.DeploymentResultRequest `json:"pending_report,omitempty"`
   ```
2. In `agent/cmd/proxyfleet-agent/main.go` inside `runCycle`:
   - At the beginning of `runCycle`:
     ```go
     if state.PendingReport != nil {
         err := client.ReportDeploymentResult(ctx, *state.PendingReport)
         if err == nil {
             log.Printf("[agent] Acknowledged pending deployment report for revision %d", state.PendingReport.Revision)
             state.PendingReport = nil
             if err := cfgMgr.Save(state); err != nil {
                 log.Printf("[agent] Warning: failed to save state after clearing pending report: %v", err)
             }
         } else {
             log.Printf("[agent] Retry delivery of pending report (rev %d) failed: %v", state.PendingReport.Revision, err)
         }
     }
     ```
   - When render fails:
     Set `state.PendingReport = &report`, save state, call `client.ReportDeploymentResult`, if `err == nil`: clear `state.PendingReport` and save.
   - When apply fails:
     Same: set `state.PendingReport = &report`, save state, attempt report, if success clear and save.
   - When apply succeeds:
     Update `state.LastRevision = desired.Revision`, set `state.PendingReport = &report`, save state, attempt report, if success clear and save.

- [ ] **Step 4: Write and run Go test in `agent/cmd/proxyfleet-agent/main_test.go`**

Add unit test verifying that if reporting fails, `state.PendingReport` remains stored and on next cycle when server is reachable, it reports and clears without re-applying 3proxy.
Run: `go test -v ./agent/...`
Expected: PASS

- [ ] **Step 5: Commit Task 4**

```bash
git add agent/internal/config/config.go agent/internal/config/config_test.go agent/cmd/proxyfleet-agent/main.go agent/cmd/proxyfleet-agent/main_test.go
git commit -m "feat(agent): persist unacknowledged deployment reports across cycles"
```

---

### Task 5: Frontend UI Integration across Nodes, Node Detail, and Proxy Endpoints

**Files:**
- Modify: `src/app/(dashboard)/nodes/page.tsx`
- Modify: `src/app/(dashboard)/nodes/[id]/page.tsx`
- Modify: `src/app/(dashboard)/proxy-endpoints/page.tsx`

**Interfaces:**
- Consumes: `node.configuration` view from `/api/fleet/nodes` and `/api/fleet/nodes/:id`.
- Produces: Dual-axis rendering (Agent Online/Offline and Configuration Applied/Pending/Failed/Unknown).

- [ ] **Step 1: Update Nodes list page (`src/app/(dashboard)/nodes/page.tsx`)**

In `src/app/(dashboard)/nodes/page.tsx`:
- In the table row for each node, update the `Status` column:
  - Line 1: Agent status dot (`●`) + capitalized label (`Online`, `Degraded`, `Offline`).
  - Line 2 (subline): Compact configuration badge:
    - If `config.status === "applied"`:
      `<span className="text-[11px] font-mono text-emerald-400">Config rev {config.appliedRevision}/{config.desiredRevision}</span>`
    - If `config.status === "pending"`:
      `<span className="text-[11px] font-mono text-amber-400">Pending rev {config.appliedRevision ?? "—"}/{config.desiredRevision}</span>`
    - If `config.status === "failed"`:
      `<span className="text-[11px] font-mono text-rose-400" title={config.error ?? "Deployment failed"}>Failed rev {config.appliedRevision ?? "—"}/{config.desiredRevision}</span>`
    - If `config.status === "unknown"`:
      `<span className="text-[11px] font-mono text-muted-foreground">Config unknown (rev {config.desiredRevision})</span>`

- [ ] **Step 2: Update Node Detail page (`src/app/(dashboard)/nodes/[id]/page.tsx`)**

In `src/app/(dashboard)/nodes/[id]/page.tsx`:
- Beside the Liveness summary card, render a dedicated **Configuration Convergence** card:
  - Title: "Configuration Convergence"
  - Status badge: `Applied` (emerald) / `Pending` (amber) / `Failed` (rose) / `Unknown` (secondary).
  - Target Revision: `desiredRevision`
  - Applied Revision: `appliedRevision ?? "None"`
  - Latest Reported Revision: `deploymentRevision ?? "None"`
  - Last Convergence Update: formatted date/time.
  - If error present: Display `<Alert variant="destructive">` with the exact sanitized error message.

- [ ] **Step 3: Update Proxy Endpoints page (`src/app/(dashboard)/proxy-endpoints/page.tsx`)**

In `src/app/(dashboard)/proxy-endpoints/page.tsx`:
- In the endpoints table, if an endpoint belongs to a node whose configuration is `failed` or `pending`, display an inline warning indicator next to the Revision badge:
  - Failed: small amber/rose alert icon with tooltip: `Node configuration failed: {error}`.
  - Pending: small clock/refresh icon with tooltip: `Node applying desired revision {desiredRevision}`.
- Do not disable copy or toggle buttons, maintaining operator control.

- [ ] **Step 4: Run typecheck and lint to verify compilation**

Run: `npm run typecheck`
Expected: 0 errors.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/app/\(dashboard\)/nodes/page.tsx src/app/\(dashboard\)/nodes/\[id\]/page.tsx src/app/\(dashboard\)/proxy-endpoints/page.tsx
git commit -m "feat(ui): display dual-axis agent liveness and configuration convergence"
```

---

### Task 6: Consolidated Verification & Behavioral Smoke Proof

**Files:**
- Execute: Test suites, typecheck, production build, browser evaluation.

- [ ] **Step 1: Run complete Node.js test suite**

Run: `npm test`
Expected: All tests pass (including new convergence tests).

- [ ] **Step 2: Run Go agent test suite**

Run: `cd agent && go test -v ./... && cd ..`
Expected: All Go tests pass.

- [ ] **Step 3: Verify TypeScript and Production Build**

Run: `npm run typecheck && npm run build`
Expected: Clean compilation with 0 errors and successful Next.js build.

- [ ] **Step 4: Run Browser Smoke Run**

Using `browser`:
1. Open `http://localhost:1300/nodes` at desktop (1440px) and mobile (390px).
2. Inspect rendered table: verify Agent Online and Configuration badges render cleanly without layout overflow.
3. Open `http://localhost:1300/nodes/238bad43-6f97-47ce-b7ec-0edf438d9b03`: verify Configuration Convergence card renders desired/applied revision details.
4. Open `http://localhost:1300/proxy-endpoints`: verify endpoint table renders revision and indicators.
5. Capture screenshot proof for evidence.

- [ ] **Step 5: Commit documentation and plan completion**

```bash
git add docs/operations.md
git commit -m "docs: document configuration convergence indicators and delivery retry"
```
