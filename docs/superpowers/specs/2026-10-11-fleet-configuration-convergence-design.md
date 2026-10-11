# Fleet Configuration Convergence Design

## Status

Approved scope for the first operator-workflow improvement. This design does not include read-path decoupling, unified-sync concurrency, rollback controls, or session persistence.

## Goal

Show operators separately whether a fleet agent is connected and whether its 3proxy configuration has converged to the controller's desired revision, while preserving deployment history and rejecting stale deployment reports.

## Current Evidence

- `src/proxyfleet/db.ts:140-154` stores `desired_revision` on `fleet_nodes`, but no applied revision or deployment status.
- `src/proxyfleet/db.ts:218-227` creates `fleet_deployments`, but the current backend does not write or read deployment rows.
- `src/proxyfleet/api-router.ts:173-190` accepts agent deployment results and records only a generic event.
- `agent/cmd/proxyfleet-agent/main.go:194-245` reports revision, config digest, `applied`/`failed`, and an optional error message.
- `src/app/(dashboard)/nodes/page.tsx` currently presents node liveness; `src/app/(dashboard)/nodes/[id]/page.tsx` presents endpoints and events but no convergence summary.

Heartbeat liveness is not proof that the 3proxy data plane applied the desired configuration. A deployment failure MUST NOT change the heartbeat status. A legacy node with no deployment evidence MUST remain configuration status `unknown` rather than being assumed converged.

## Scope and State Model

Add configuration convergence fields to fleet node storage, exposing the nested API view described below:

- `applied_revision: number | null`
- `deployment_status: "pending" | "applied" | "failed" | "unknown"`
- `deployment_error: string | null`
- `deployment_updated_at: number | null`
- `deployment_revision: number | null` records the latest reported revision watermark independently of the successful applied revision.
- `desired_revision` remains the controller-owned target revision.

Keep `fleet_nodes.status` exclusively for agent liveness (`online`, `offline`, `degraded` as currently derived). The UI MUST label the axes distinctly:

- **Agent:** Online/Offline from heartbeat.
- **Configuration:** Unknown, Pending, Applied, or Failed, with `applied_revision / desired_revision` where available.

The existing `fleet_deployments` table becomes the append-only deployment history. Each accepted deployment result records node, revision, digest, status, error, applied time, and creation time.

## API and Persistence Contract

1. Database migration adds the convergence columns to existing `fleet_nodes`. Defaults:
   - `applied_revision = NULL`
   - `deployment_status = "unknown"`
   - `deployment_error = NULL`
   - `deployment_updated_at = NULL`
2. New nodes use the same defaults. No migration infers applied state from desired state.
3. When desired configuration changes, current configuration status becomes `pending`. Preserve the last applied revision and the prior deployment evidence in history; clear the current error because it belongs to an older target. Heartbeats never change configuration state.
4. Deployment result handling remains authenticated by the existing node-scoped agent token. The reported revision must be a positive safe integer no greater than the node's desired revision; a future revision is rejected with HTTP 400.
5. Store a separate latest-reported revision watermark: failures advance this watermark but never advance the applied revision. Reject a report older than that watermark with HTTP 200 `{ ok: true, accepted: false, reason: "stale_revision" }`, without altering current fields, history, or success events.
6. At the same revision, an applied report can supersede a failed report (agent retry). Once success is recorded for a revision, a delayed failure for that revision cannot overwrite it. Exact repeat reports are acknowledged without inserting duplicate history/events. Distinct failed reports before success remain history evidence; without agent attempt IDs the controller cannot establish their true chronological order and exposes the most recently received error.
7. An accepted applied result raises `applied_revision` monotonically and clears the current error only when it applies the current desired revision. Applied evidence for an older target is retained but the current configuration remains `pending`. An accepted failed result preserves `applied_revision`; it makes the current status `failed` only when its revision equals the current desired revision. Otherwise the current status remains `pending`.
8. The history row, corresponding audit event, revision watermark and current node fields MUST be written in one transaction. A failed transaction leaves all four unchanged. Existing last-applied evidence is retained when the desired target advances.
9. The node and node-detail API responses expose a nested configuration view to UI consumers:

```ts
configuration: {
  status: "pending" | "applied" | "failed" | "unknown";
  desiredRevision: number;
  appliedRevision: number | null;
  error: string | null;
  updatedAt: number | null;
}
```

Keep the existing `desired_revision` field because the agent desired-state contract already uses it; expose new convergence data through `configuration` without adding a second set of public aliases.

## UI Behavior

### Nodes list

Keep the existing Agent status column. Add a compact Configuration column or subline showing:

- `Applied rev N/N` when applied revision equals desired revision.
- `Pending rev N/M` when a newer desired revision is outstanding.
- `Failed rev N/M` with an accessible error title when the latest accepted result failed.
- `Unknown rev —/M` for legacy/no-evidence nodes.

Status color MUST be paired with text and MUST NOT replace the Agent status meaning.

### Node detail

Show an explicit convergence summary beside the node liveness summary. Include desired/applied revisions, latest deployment status, bounded error, and update time. Existing audit events remain the detailed history surface. The first implementation does not add Retry or Rollback buttons because no safe server command contract for those actions is currently defined.

### Proxy endpoints

Expose the node configuration warning when an endpoint belongs to a node whose current configuration is failed, pending, or unknown. Do not disable existing read/copy actions solely from this indicator; the UI must inform the operator without claiming that endpoint connectivity was tested by deployment convergence.

## Agent Report Delivery

The current agent ignores deployment-report errors and skips a desired revision already stored in `LastRevision`. A lost success report would therefore leave the controller pending indefinitely. Within this scope, persist the unacknowledged deployment result in the existing restrictive agent state file, send it on subsequent normal cycles until acknowledged, and clear it only after HTTP success (including stale/duplicate acknowledgements). Retrying delivery does not re-apply configuration, add a new timer, or change the heartbeat schedule. Log report failures without credentials. For failed deployments, retry outstanding evidence before any subsequent attempt; a newly completed attempt replaces pending evidence durably. Legacy agent state remains readable; absent digest/report evidence is not fabricated. Old agents that never retransmit a lost report remain Pending/Unknown until new valid evidence arrives; UI must not synthesize success.

This does not prove runtime availability: the current agent reports `applied` after its Apply call even when individual listener checks only log warnings. The UI uses the label **Configuration applied**, never **Endpoint healthy**.

## Error Handling and Security

- Preserve node-scoped agent authentication and do not log bearer tokens or proxy credentials.
- Validate `nodeId` as a nonempty string of at most 128 characters matching the authenticated existing node; `revision` as a positive safe integer no greater than desired revision; `status` as exactly `applied` or `failed`; `configDigest` as a string of at most 128 characters (empty is allowed for render failure); and optional `errorMessage` as a string of at most 2,048 characters. Store/display errors as text, never HTML; prohibit bearer/proxy credentials in agent error construction.
- Treat unknown deployment status as a 400 validation error; do not coerce arbitrary values to `applied`.
- Stale and duplicate results return an acknowledgement without creating a deployment success/failure event; accepted history and event updates use the transaction specified above.
- Deployment convergence is configuration evidence, not a replacement for proxy health checks or heartbeat liveness.

## Testing and Acceptance

Permanent tests MUST cover:

1. Migration/default mapping returns `unknown` with null applied revision for legacy nodes.
2. Accepted applied result updates current state and inserts one history row atomically.
3. Accepted failed result preserves the previous applied revision, stores the error, and leaves heartbeat liveness unchanged.
4. A stale result cannot move current state backward or replace a newer failure/success.
5. Invalid status/revision/node input is rejected without persistence changes.
6. Node and node-detail API responses expose the nested configuration contract.
7. Agent report delivery survives controller request failure and agent restart; acknowledged retry does not re-apply configuration and does not duplicate history/events.
8. Same-revision success supersedes failure; same-revision delayed failure cannot supersede success. Older applied evidence while a newer target is outstanding remains Pending, never Applied.
9. UI smoke verification renders Agent Online alongside Configuration Failed/Pending/Unknown at desktop and mobile widths; this is behavior proof, not a source-text assertion test.

Acceptance scenario:

- Set desired revision to 2 while applied revision is 1.
- Confirm the node reports `Agent: Online` and `Configuration: Pending 1/2`.
- Submit a failed result for revision 2.
- Confirm the node remains Agent Online but shows Configuration Failed 1/2 with the deployment error, and the history contains the failure.
- Submit a delayed result for revision 1 and confirm it does not change the current configuration state.
- Submit an applied result for revision 2 and confirm the state becomes Applied 2/2 and the prior failure remains in history.

## Non-goals

- No change to `/api/ninerouter/pools` read-path behavior.
- No change to unified sync or Antigravity concurrency.
- No new automatic redeployment, rollback, restart, or circuit breaker. Delivery retry of an already-completed deployment result uses the existing agent cycle as specified above.
- No inference that applied revision means proxy connectivity is healthy.
- No broad UI redesign outside the three fleet surfaces named above.
