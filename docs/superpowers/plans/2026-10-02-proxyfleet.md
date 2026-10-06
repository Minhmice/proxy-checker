# ProxyFleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Next.js proxy control dashboard into a production-ready ProxyFleet controller managing remote Ubuntu proxy worker nodes over WireGuard with 3proxy and Beszel monitoring, preserving all 9Router and safety auditing functionality.

**Architecture:** Distributed control plane with a central Next.js/PostgreSQL controller (VPS #1) and a lightweight Go agent on worker nodes (VPS #2). Worker nodes connect to the controller over an isolated WireGuard overlay (`10.77.0.0/24`). The Go agent reconciles desired-state configurations for 3proxy, executes layered health checks (process, TCP, authenticated exit IP leak verification), and ships metrics to the controller while Beszel handles host OS telemetry.

**Tech Stack:** Next.js 16 (React 19, TypeScript), Node.js 22+, PostgreSQL 16 (with fallback database adapter), Go 1.24+ (`CGO_ENABLED=0`), 3proxy 0.9.4+, WireGuard (`wg-quick`), Beszel, `nftables`, `systemd`.

**Spec:** `docs/proxyfleet-architecture.md`

## Global Constraints

- Never mutate or delete existing `data/settings.json`, `data/pool-state.json`, or `data/proxies.sqlite3`.
- All safety audits must remain strictly non-destructive; audit results must never trigger automatic configuration mutations.
- 3proxy is the sole data-plane for traffic; never implement a custom SOCKS or HTTP proxy server.
- All proxy listeners must default to listening on WireGuard private IP addresses (`10.77.0.x`), never open `0.0.0.0`.
- All credentials must be encrypted at rest and redacted from normal table displays, logs, and query parameters.
- Preserved 9Router behavior: 6-hour minimum sync cooldown, confirmed-dead auto-removal with local history, top 20 active ranking, reverse-rank renaming.
- All worker services must run under systemd with `Restart=on-failure` and survive machine reboots.

---

### Task 1: Controller Fleet Database Schema & Migration Layer

**Files:**
- Create: `src/proxyfleet/migrations/001_fleet_schema.sql`
- Create: `src/proxyfleet/db.ts`
- Modify: `src/server/server.ts:25-35`
- Test: `tests/fleet-db.test.ts`

**Interfaces:**
- Consumes: `process.env.DATABASE_URL` (or fallback SQLite database for local test harness)
- Produces: `getFleetDb()`, `migrateFleet(db)`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fleet-db.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { openFleetDb, closeFleetDb } from "../src/proxyfleet/db.js";

test("fleet db initializes schema and supports node inserts", async () => {
  const db = await openFleetDb({ inMemory: true });
  try {
    const node = await db.createNode({
      id: "node-test-1",
      name: "worker-001",
      wireguardIp: "10.77.0.11",
      status: "offline",
    });
    assert.equal(node.name, "worker-001");
    assert.equal(node.wireguardIp, "10.77.0.11");
    
    const retrieved = await db.getNode("node-test-1");
    assert.equal(retrieved?.id, "node-test-1");
  } finally {
    await closeFleetDb(db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-db.test.ts`
Expected: FAIL with "Cannot find module '../src/proxyfleet/db.js'"

- [ ] **Step 3: Write minimal implementation**

Create `src/proxyfleet/migrations/001_fleet_schema.sql` containing tables: `fleet_nodes`, `fleet_node_interfaces`, `fleet_egresses`, `fleet_proxy_endpoints`, `fleet_proxy_credentials`, `fleet_node_heartbeats`, `fleet_health_checks`, `fleet_deployments`, `fleet_enrollment_tokens`, `fleet_events`.
Create `src/proxyfleet/db.ts` supporting connection pooling, migration runner, and typed CRUD operations.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxyfleet/ tests/fleet-db.test.ts
git commit -m "feat(fleet): add database schema and repository layer"
```

---

### Task 2: Controller Secret Vault & Enrollment Service

**Files:**
- Create: `src/proxyfleet/security.ts`
- Create: `src/proxyfleet/enrollment.ts`
- Test: `tests/fleet-enrollment.test.ts`

**Interfaces:**
- Consumes: `openFleetDb()` from `src/proxyfleet/db.ts`
- Produces: `generateEnrollmentToken()`, `consumeEnrollmentToken()`, `encryptSecret()`, `decryptSecret()`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fleet-enrollment.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { openFleetDb, closeFleetDb } from "../src/proxyfleet/db.js";
import { createEnrollmentService } from "../src/proxyfleet/enrollment.js";

test("enrollment token can be issued, consumed once, and expires", async () => {
  const db = await openFleetDb({ inMemory: true });
  const service = createEnrollmentService(db, { tokenSecret: "test-secret-12345678901234567890" });
  try {
    const { token, tokenId } = await service.issueToken({ nodeName: "worker-001", ttlMinutes: 10 });
    assert.ok(token);
    
    const enrolled = await service.enrollNode({ token, publicKey: "mock-wg-pubkey", hostname: "worker-001" });
    assert.ok(enrolled.nodeId);
    assert.equal(enrolled.wireguardIp, "10.77.0.11");
    
    // Single use: second attempt must fail
    await assert.rejects(
      service.enrollNode({ token, publicKey: "mock-wg-pubkey", hostname: "worker-001" }),
      /token already consumed or invalid/i
    );
  } finally {
    await closeFleetDb(db);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-enrollment.test.ts`
Expected: FAIL with missing module error.

- [ ] **Step 3: Write minimal implementation**

Implement AES-256-GCM authenticated encryption in `src/proxyfleet/security.ts`.
Implement single-use expiring token generation and node identity provisioning in `src/proxyfleet/enrollment.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-enrollment.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxyfleet/security.ts src/proxyfleet/enrollment.ts tests/fleet-enrollment.test.ts
git commit -m "feat(fleet): implement secret encryption and node enrollment service"
```

---

### Task 3: Controller Fleet HTTP API Routes

**Files:**
- Create: `src/proxyfleet/api-router.ts`
- Modify: `src/server/server.ts:575-585`
- Test: `tests/fleet-api.test.ts`

**Interfaces:**
- Consumes: `src/proxyfleet/db.ts`, `src/proxyfleet/enrollment.ts`, `src/server/server.ts` auth helper
- Produces: Dispatches `/api/fleet/*` routes (`/nodes`, `/endpoints`, `/enroll`, `/agent/heartbeat`, `/agent/desired-state`)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fleet-api.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { handleFleetApi } from "../src/proxyfleet/api-router.js";

test("fleet api routes enforce auth and handle node listing", async () => {
  let handled = false;
  const mockReq = {
    method: "GET",
    url: "/api/fleet/nodes",
    headers: { authorization: "Bearer invalid" },
  } as unknown as http.IncomingMessage;
  
  const mockRes = {
    writeHead(status: number) { this.statusCode = status; },
    end(body: Buffer) {
      handled = true;
      assert.equal(this.statusCode, 401);
    }
  } as unknown as http.ServerResponse & { statusCode: number };

  await handleFleetApi(mockReq, mockRes, "/api/fleet/nodes");
  assert.equal(handled, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-api.test.ts`
Expected: FAIL with missing module error.

- [ ] **Step 3: Write minimal implementation**

Create `src/proxyfleet/api-router.ts` handling:
- `POST /api/fleet/enroll`
- `GET /api/fleet/nodes`
- `GET /api/fleet/nodes/:id`
- `POST /api/fleet/agent/heartbeat`
- `GET /api/fleet/agent/desired-state`
- `POST /api/fleet/agent/deployment-result`
- `GET/POST /api/fleet/endpoints`
- `POST /api/fleet/endpoints/:id/credentials/reveal` (strictly authenticated)
Wire into `src/server/server.ts` alongside existing routes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxyfleet/api-router.ts src/server/server.ts tests/fleet-api.test.ts
git commit -m "feat(fleet): implement controller HTTP API routes"
```

---

### Task 4: Go Agent Core: Config, Keygen & Enrollment

**Files:**
- Create: `agent/go.mod`
- Create: `agent/cmd/proxyfleet-agent/main.go`
- Create: `agent/internal/config/config.go`
- Create: `agent/internal/controller/client.go`
- Create: `agent/internal/controller/client_test.go`
- Test: `agent/internal/controller/client_test.go`

**Interfaces:**
- Consumes: Controller `/api/fleet/enroll` and `/api/fleet/agent/heartbeat`
- Produces: Static binary `proxyfleet-agent`

- [ ] **Step 1: Write the failing test in Go**

```go
// agent/internal/controller/client_test.go
package controller_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"proxyfleet/agent/internal/controller"
)

func TestEnrollmentSuccess(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"nodeId":"node-123","wireguardIp":"10.77.0.11","serverWgPublicKey":"mock-key"}`))
	}))
	defer ts.Close()

	client := controller.NewClient(ts.URL)
	resp, err := client.Enroll(context.Background(), "test-token", "client-wg-pubkey", "worker-001")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if resp.NodeID != "node-123" || resp.WireGuardIP != "10.77.0.11" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go -C agent test ./...`
Expected: FAIL (package does not exist)

- [ ] **Step 3: Write minimal implementation**

Initialize `agent/go.mod`. Implement HTTP client with bounded timeouts, TLS config, retry backoff, and JSON serialization. Implement CLI entrypoint parsing `--server`, `--token`, `--node-name`.

- [ ] **Step 4: Run test to verify it passes**

Run: `go -C agent test ./...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/
git commit -m "feat(agent): initialize Go agent with enrollment client"
```

---

### Task 5: Go Agent 3proxy Desired-State Renderer & Rollback

**Files:**
- Create: `agent/internal/proxy/render.go`
- Create: `agent/internal/proxy/deploy.go`
- Create: `agent/internal/proxy/deploy_test.go`
- Test: `agent/internal/proxy/deploy_test.go`

**Interfaces:**
- Consumes: Desired-state JSON definition containing list of `ProxyEndpoint`
- Produces: Rendered `3proxy.cfg`, config validation, atomic file swap, systemd reload, automatic rollback

- [ ] **Step 1: Write the failing test**

```go
// agent/internal/proxy/deploy_test.go
package proxy_test

import (
	"testing"
	"proxyfleet/agent/internal/proxy"
)

func TestRender3ProxyConfig(t *testing.T) {
	endpoints := []proxy.Endpoint{
		{
			ID: "ep-1",
			Protocol: "http",
			ListenIP: "10.77.0.11",
			ListenPort: 20001,
			Username: "user1",
			Password: "pass1",
		},
		{
			ID: "ep-2",
			Protocol: "socks5",
			ListenIP: "10.77.0.11",
			ListenPort: 30001,
			Username: "user2",
			Password: "pass2",
		},
	}
	
	cfg, err := proxy.RenderConfig(endpoints)
	if err != nil {
		t.Fatalf("render error: %v", err)
	}
	if !contains(cfg, "proxy -p20001 -i10.77.0.11") {
		t.Errorf("missing http proxy directive: %s", cfg)
	}
	if !contains(cfg, "socks -p30001 -i10.77.0.11") {
		t.Errorf("missing socks proxy directive: %s", cfg)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go -C agent test ./internal/proxy`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Implement safe template rendering avoiding command injection and CRLF injection. Implement atomic file swap (`write temp -> rename`) and previous configuration backup. On reload error, restore backup immediately.

- [ ] **Step 4: Run test to verify it passes**

Run: `go -C agent test ./internal/proxy`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/proxy/
git commit -m "feat(agent): implement 3proxy configuration rendering and atomic rollback"
```

---

### Task 6: Go Agent Layered Health Engine & Policy Routing

**Files:**
- Create: `agent/internal/health/checker.go`
- Create: `agent/internal/health/checker_test.go`
- Create: `agent/internal/routing/policy.go`
- Test: `agent/internal/health/checker_test.go`

**Interfaces:**
- Consumes: Target test URL, proxy endpoint connection string
- Produces: Structured health status (`healthy`, `degraded`, `offline`, `route_leak`, `auth_error`, `timeout`)

- [ ] **Step 1: Write the failing test**

```go
// agent/internal/health/checker_test.go
package health_test

import (
	"context"
	"testing"
	"proxyfleet/agent/internal/health"
)

func TestHealthCheckRouteLeakDetection(t *testing.T) {
	checker := health.NewChecker()
	// Test route leak detection logic: expected egress IP 1.2.3.4 but returned 5.6.7.8
	status := checker.EvaluateEgress("1.2.3.4", "5.6.7.8")
	if status != health.StatusRouteLeak {
		t.Fatalf("expected route_leak status, got %s", status)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go -C agent test ./internal/health`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Implement 3-layer health checking:
- L1: Process check
- L2: TCP port open check
- L3: HTTP/SOCKS forward check measuring latency and exit IP
Implement policy routing helpers (`ip rule`, `ip route`) for binding multiple egress interfaces.

- [ ] **Step 4: Run test to verify it passes**

Run: `go -C agent test ./internal/health`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/health/ agent/internal/routing/
git commit -m "feat(agent): implement layered health checker and policy routing"
```

---

### Task 7: WireGuard Hub & Worker Provisioning Script

**Files:**
- Create: `scripts/install-agent.sh`
- Create: `deploy/systemd/proxyfleet-agent.service`
- Create: `deploy/systemd/3proxy.service`
- Create: `deploy/wireguard/wg0.conf.example`
- Test: `tests/installer-syntax.test.ts`

**Interfaces:**
- Consumes: Ubuntu 24.04/22.04 environment, `--server`, `--token`, `--node-name`
- Produces: Installed systemd services, WireGuard client config, running 3proxy

- [ ] **Step 1: Write the failing test (Bash syntax & safety verification)**

```typescript
// tests/installer-syntax.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";

test("install-agent.sh passes bash syntax check", () => {
  const scriptPath = path.resolve("scripts/install-agent.sh");
  assert.doesNotThrow(() => {
    execFileSync("bash", ["-n", scriptPath]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/installer-syntax.test.ts`
Expected: FAIL (file not found)

- [ ] **Step 3: Write minimal implementation**

Create `scripts/install-agent.sh` with architecture detection (amd64, arm64, armv7), dependency installation (`wireguard`, `3proxy`, `curl`, `jq`, `nftables`), WireGuard keypair generation, agent binary installation, and systemd service registration.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/installer-syntax.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/install-agent.sh deploy/ tests/installer-syntax.test.ts
git commit -m "feat(deploy): add worker installer script and systemd unit definitions"
```

---

### Task 8: Beszel Infrastructure Monitoring Integration

**Files:**
- Create: `src/proxyfleet/beszel.ts`
- Create: `src/app/(dashboard)/monitoring/page.tsx`
- Test: `tests/beszel-client.test.ts`

**Interfaces:**
- Consumes: Beszel Hub API (`http://127.0.0.1:8090/api/*`)
- Produces: `getSystemMetrics(systemId)`, embeddable/linked node status

- [ ] **Step 1: Write the failing test**

```typescript
// tests/beszel-client.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { createBeszelClient } from "../src/proxyfleet/beszel.js";

test("beszel client normalizes system metrics into dashboard DTO", async () => {
  const client = createBeszelClient({
    baseUrl: "http://127.0.0.1:8090",
    fetch: async () => new Response(JSON.stringify({
      cpu: 21.5,
      memory: 42.0,
      disk: 37.0,
      network: { sent: 419430, received: 1258291 },
    })),
  });
  
  const metrics = await client.getNodeMetrics("node-001");
  assert.equal(metrics.cpuPercent, 21.5);
  assert.equal(metrics.memoryPercent, 42.0);
  assert.equal(metrics.diskPercent, 37.0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/beszel-client.test.ts`
Expected: FAIL with missing module error.

- [ ] **Step 3: Write minimal implementation**

Create `src/proxyfleet/beszel.ts` with API token authentication, metric normalization, and graceful degradation when Beszel Hub is unreachable.
Create `/monitoring` view in Next.js displaying fleet-wide resource utilization.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/beszel-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxyfleet/beszel.ts src/app/\(dashboard\)/monitoring/ tests/beszel-client.test.ts
git commit -m "feat(monitoring): integrate Beszel infrastructure metrics client"
```

---

### Task 9: Next.js Fleet UI (Nodes, Endpoints, Monitoring, Events)

**Files:**
- Create: `src/app/(dashboard)/nodes/page.tsx`
- Create: `src/app/(dashboard)/nodes/[id]/page.tsx`
- Create: `src/app/(dashboard)/proxy-endpoints/page.tsx`
- Create: `src/app/(dashboard)/events/page.tsx`
- Modify: `src/components/app-sidebar.tsx:34-45`
- Test: `tests/fleet-ui-contract.test.ts`

**Interfaces:**
- Consumes: Controller API endpoints `/api/fleet/*`
- Produces: Accessible shadcn-based responsive UI views

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fleet-ui-contract.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { formatFleetNodeStatus, redactCredential } from "../src/lib/fleet-ui-utils.js";

test("fleet ui utils redacts secrets and formats statuses correctly", () => {
  assert.equal(redactCredential("super-secret-pass"), "••••••••••••");
  assert.equal(formatFleetNodeStatus("online").variant, "success");
  assert.equal(formatFleetNodeStatus("offline").variant, "destructive");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-ui-contract.test.ts`
Expected: FAIL with missing module error.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/fleet-ui-utils.ts`.
Create `/nodes`, `/nodes/[id]`, `/proxy-endpoints`, `/events` pages adhering to the existing kinetic theme and shadcn design system.
Update `src/components/app-sidebar.tsx` with Infrastructure group (Nodes, Proxy Endpoints, Network) and Events.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-ui-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/\(dashboard\)/nodes/ src/app/\(dashboard\)/proxy-endpoints/ src/app/\(dashboard\)/events/ src/components/app-sidebar.tsx tests/fleet-ui-contract.test.ts
git commit -m "feat(ui): add nodes, endpoints, and events fleet dashboard pages"
```

---

### Task 10: Managed Endpoint Ingestion into Auditor & Diagnostics Pipeline

**Files:**
- Create: `src/proxyfleet/pipeline-adapter.ts`
- Modify: `src/server/detailed-checker.ts:30-45`
- Modify: `src/server/auditor-jobs.ts:50-65`
- Test: `tests/fleet-pipeline-integration.test.ts`

**Interfaces:**
- Consumes: Managed `ProxyEndpoint` entities
- Produces: Transparent resolution in Safety Auditor and Diagnostics without global SSRF policy bypass

- [ ] **Step 1: Write the failing test**

```typescript
// tests/fleet-pipeline-integration.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveManagedEndpointForAudit } from "../src/proxyfleet/pipeline-adapter.js";

test("resolves registered managed endpoint with allowPrivateTargets scoped strictly to WireGuard address", async () => {
  const result = resolveManagedEndpointForAudit({
    id: "ep-1",
    listenIp: "10.77.0.11",
    listenPort: 20001,
    protocol: "http",
    username: "user",
    decryptedPassword: "secret-password",
  });
  
  assert.equal(result.targetUrl, "http://user:secret-password@10.77.0.11:20001");
  assert.equal(result.options.allowPrivateTargets, true);
  assert.deepEqual(result.options.allowedPrivateIps, ["10.77.0.11"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/fleet-pipeline-integration.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

Implement `src/proxyfleet/pipeline-adapter.ts` resolving credentials securely server-side and attaching scoped private target permissions. Wire into Diagnostics and Safety Auditor handlers.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/fleet-pipeline-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/proxyfleet/pipeline-adapter.ts tests/fleet-pipeline-integration.test.ts
git commit -m "feat(fleet): integrate managed proxy endpoints into diagnostics and auditor pipeline"
```

---

### Task 11: Production Deployment Automation & End-to-End Acceptance Verification

**Files:**
- Create: `scripts/proxyfleet-acceptance.mjs`
- Create: `docs/deployment.md`
- Create: `docs/operations.md`
- Test: `scripts/proxyfleet-acceptance.mjs`

**Interfaces:**
- Consumes: Controller endpoint, worker SSH access
- Produces: Verifiable test report proving the 31-step end-to-end acceptance scenario

- [ ] **Step 1: Write the acceptance verification script**

Implement `scripts/proxyfleet-acceptance.mjs` executing:
1. Controller health check.
2. Worker enrollment.
3. WireGuard connectivity check.
4. Beszel metrics arrival.
5. Single proxy endpoint creation.
6. 3proxy reload & health check verification.
7. Diagnostics and Safety Auditor non-destructive audit.
8. Controlled failure tests: 3proxy stopped, agent stopped, bad config rollback, wrong egress route leak.

- [ ] **Step 2: Run validation in local/mock mode**

Run: `node scripts/proxyfleet-acceptance.mjs --dry-run`
Expected: All structural preconditions verified.

- [ ] **Step 3: Write deployment and operations documentation**

Document step-by-step setup for VPS #1 (Caddy, Next.js, PostgreSQL, WireGuard Hub, Beszel Hub) and VPS #2 (Installer script execution, systemd management, credential rotation, rollback procedures).

- [ ] **Step 4: Run full project verification suite**

Run: `npm run build && npm test && npm run lint`
Expected: Clean build, 0 lint errors, all tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/proxyfleet-acceptance.mjs docs/deployment.md docs/operations.md
git commit -m "docs(fleet): add deployment guide, operations manual, and acceptance verification runner"
```
