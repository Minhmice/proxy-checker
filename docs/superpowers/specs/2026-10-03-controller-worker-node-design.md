# Controller-Worker Node Design

**Status:** Proposed for review

## Goal

Represent VPS #1 as a first-class ProxyFleet node that also hosts managed proxy endpoints, while preserving Raspberry Pi worker identity and avoiding duplicate WireGuard identities or unsafe listeners.

## Architecture

VPS #1 keeps its controller, dashboard, 9Router, Beszel Hub, WireGuard server, and a local ProxyFleet agent plus 3proxy worker. It is stored as one node with role `controller-worker` and fixed overlay address `10.77.0.1`. Raspberry Pi remains role `worker`, with its existing node ID and address `10.77.0.11`.

The controller node uses a stable bootstrap identity, not a one-time enrollment token. Bootstrap is idempotent: reruns find the existing node by stable identity and do not create duplicates, change the overlay address, or delete endpoints.

## Data model

Add `role` to `fleet_nodes`. Allowed values are `controller-worker` and `worker`; existing rows migrate to `worker` unless explicitly identified as the controller. The API returns `role` in snake_case and camel-case mappings. Existing node IDs, endpoints, heartbeat timestamps, and credentials remain unchanged.

## Agent and services

VPS #1 runs `proxyfleet-agent.service` and `3proxy.service` independently from `proxy-control-dashboard.service`. Agent uses `http://127.0.0.1:1300`, the stable controller node ID, and `/etc/proxyfleet`. It must not create another WireGuard server interface or peer. Its managed proxy listeners bind to `10.77.0.1`, never `0.0.0.0`, unless an explicit future policy allows otherwise. Raspberry Pi service remains unchanged.

All services use conservative restart behavior. No runtime watchdog or Wake-on-LAN changes are part of this design. A 3proxy failure must not restart the controller service; a controller restart must not erase node state.

## Dashboard

Nodes and Monitoring pages consume the existing authenticated `/api/fleet/nodes` endpoint. The node table and detail page show role badges: `Controller + Worker` and `Worker`. The controller row links to the same endpoint and event views as every worker. No secrets, enrollment tokens, WireGuard private keys, or proxy passwords are rendered.

Node connectivity is based on heartbeat freshness, not only frontend polling. A future stale-heartbeat policy must be explicit and conservative; it must not infer proxy health from controller API health. Beszel metrics remain separate from agent status and are shown only when an actual Beszel system match is configured.

## API and error behavior

`GET /api/fleet/nodes` and `GET /api/fleet/nodes/:id` include role. Unknown roles are rejected at write boundaries. Bootstrap fails closed if an existing node has the same stable identity but a conflicting overlay address. Existing enrollment remains available for workers.

If the controller agent cannot heartbeat, the dashboard keeps the last recorded node and marks it stale/offline according to the explicit freshness policy; it does not delete the node. If desired-state deployment fails, the agent reports the deployment error and keeps the previous valid 3proxy configuration.

## Verification

- Database migration preserves existing worker ID, endpoint, credential, event, and heartbeat data.
- Bootstrap can run twice without duplicate controller rows.
- API returns both nodes with correct roles.
- Controller agent enrolls or restores its stable identity and heartbeats locally.
- Controller and Pi services remain independently restartable.
- A controller endpoint binds to `10.77.0.1`, not all interfaces.
- Dashboard displays both node rows, role badges, status, architecture, overlay IP, and last heartbeat.
- No secret appears in API responses or rendered UI.
