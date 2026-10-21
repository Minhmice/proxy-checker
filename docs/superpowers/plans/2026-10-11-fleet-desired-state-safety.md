# Fleet Desired-State Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Protect worker configuration secrets, make desired revisions durable and monotonic, and report stale worker liveness accurately.

**Architecture:** Existing SQLite repository owns node-wide desired_revision and hashed node credential. Enrollment issues a random node token once; worker routes authenticate that token for the requested node. Go stores and sends the credential; legacy nodes use an authenticated admin credential-rotation route plus --agent-token, preserving node IDs and endpoint configuration.

**Tech Stack:** Node TypeScript, DatabaseSync SQLite, Go stdlib HTTP/config, node:test.

**Spec:** Wave A approved in chat: node authentication, monotonic revisions, empty configuration propagation, effective liveness, controller-agent migration and regression verification.

## Global Constraints
- No anonymous or dashboard-password fallback on agent endpoints.
- Enrollment remains authorized by single-use enrollment token.
- Bearer node token is scoped to exactly one node and only its SHA-256 hash is stored in SQLite.
- Node token is returned only on enrollment or authenticated admin rotation, never node list/get/event output.
- Protect heartbeat, desired-state and deployment-result. Validate request node ID against token.
- desired_revision is independent from heartbeat and metadata timestamps, incremented transactionally with actual configuration changes.
- Migration seeds existing node revision above Date.now(), node.updated_at and all endpoint.updated_at/current_revision; never reset legacy timestamp-sized LastRevision to a small counter.
- Worker offline threshold is 60 seconds; get/list/filter use identical effective status. Controller is represented as this live server's inventory node, not a stale remote worker.
- Preserve existing work; no unrelated Fleet-to-Intelligence or scheduler changes; no production endpoint/account mutations during verification.

## Task 1: Repository revisions, credentials and liveness
Files: src/proxyfleet/db.ts, src/proxyfleet/types.ts, tests/fleet-db.test.ts (or isolated behavior test file).
Interfaces: FleetNodeRecord.desired_revision: number; FleetRepository.setNodeAgentToken(nodeId: string, token: string): Promise<void>; FleetRepository.verifyNodeAgentToken(nodeId: string, token: string): Promise<boolean>.
- [ ] Add behavioral tests for same-clock endpoint creates, disable-last, password-only update, no-op update, transaction rollback, persistent revision across reopen, legacy revision migration, expired worker status/filter and scoped hashed token verification.
- [ ] Add desired_revision and nullable agent_token_hash schema migration by checking PRAGMA table_info rather than swallowing arbitrary SQL errors.
- [ ] Seed revisions on existing nodes with max of timestamps/revisions/current clock + 1. New nodes use a positive revision. Token reads remain private repository operations.
- [ ] Make endpoint creation and effective enabled/username/password changes transactions. Encrypt before transaction; mutate credentials, endpoint revision and node desired_revision together. No-op update does not bump revision. Password-only update must work with or without existing credential row; username and encrypted credential username stay consistent.
- [ ] Effective worker status becomes offline for absent or >=60-second-old heartbeat; preserve fresh degraded/online status. Controller inventory status remains server-owned online. Heartbeat never changes desired_revision.

## Task 2: Worker API authentication and enrollment
Files: src/proxyfleet/api-router.ts, src/proxyfleet/enrollment.ts, tests/fleet-api.test.ts, tests/fleet-enrollment.test.ts.
Interfaces: EnrollNodeResult.agentToken: string; POST /api/fleet/nodes/:id/agent-token authenticated admin response {nodeId, agentToken}; agent Authorization: Bearer <agentToken>.
- [ ] Observe failing tests before implementation for anonymous desired-state, foreign-node credential, unauthenticated heartbeat/deployment-result and disable-last revision.
- [ ] Enrollment generates `fla_` + random 32-byte token, saves hash using repository API and returns raw token once. No token in logs/events.
- [ ] For every agent route require Bearer token; resolve nodeId from route request body/query and verify exactly that node. Return 401 before credential reads or state mutation. Return node.desired_revision from desired-state.
- [ ] Admin token-rotation route updates hash and returns token once; old token immediately invalid. Support legacy enrolled nodes without changing node ID/endpoints.
- [ ] Migrate existing tests to node credentials and assert dashboard Basic/Bearer cannot authenticate worker routes.

## Task 3: Go agent cutover and binary integration
Files: agent/internal/config/config.go, agent/internal/controller/client.go, agent/cmd/proxyfleet-agent/main.go and corresponding Go tests; tests/fleet-agent-integration.test.ts; distribution binaries in bin/.
Interfaces: Go State.AgentToken `json:"agent_token"`; EnrollResponse.AgentToken `json:"agentToken"`; Client.SetAgentToken(token string); --agent-token CLI flag.
- [ ] Go client sets Bearer header on heartbeat/desired-state/deployment-result only. Enrollment does not send post-enrollment credential.
- [ ] Save enrollment credential alongside node identity; restore after restart. --agent-token installs rotated credential for an existing node using existing restrictive state file. Existing node without credential fails closed with actionable admin rotation instruction; never re-enroll silently or reset LastRevision.
- [ ] Add Go tests for per-route Bearer headers, token persistence, missing enrollment credential and legacy credential install. Agent must deploy empty proxy configuration on strictly higher revision.
- [ ] Update binary integration test to verify enrollment/restart credential persistence and disable-last empty configuration deployment. Build Windows amd64 plus Linux amd64/arm64/armv7 distributed binaries only after source changes settle.

## Task 4: Verification and operator documentation
- [ ] Run failing-before checks once before source implementation, then focused final TypeScript Fleet tests, Go tests, npm run typecheck and npm test once after worker integration.
- [ ] Smoke real loopback HTTP server plus real Go binary against isolated SQLite/state/config: enrollment, unauthorized rejection, authenticated heartbeat/config, disable-last empty deployment, restart, admin rotation invalidating old credential.
- [ ] Update docs/operations.md and docs/deployment.md with controller+agent cutover, legacy admin credential provisioning, HTTPS or trusted encrypted overlay requirement, no secret logging, and liveness/revision contracts.
- [ ] Do not commit unrelated changes or restart running production services. Report source verification separately from deployment state.

## Execution rulings
- Work in current checkout to preserve user's extensive existing uncommitted Fleet code; no destructive stash or hidden merge.
- Repository slice owns db.ts/types.ts only; Go slice owns agent/ and Go tests only; parent owns API/enrollment/TS integration/docs. All children skip build/test/format mid-flight; parent executes failing-before and final verification.
- Existing workers require deliberate token provisioning as security cutover, not anonymous backward compatibility.
