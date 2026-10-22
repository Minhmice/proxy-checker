import type { IncomingMessage, ServerResponse } from "node:http";
import type { FleetRepository } from "./db.js";
import { parseFleetCapacity, parseFleetDevice, parseFleetRuntime, parseFleetSessionId } from "./runtime.js";
import type { FleetWireGuardManager, FleetWireGuardSettings } from "./wireguard.js";
import { requireDashboardAuth } from "../server/session-auth.js";


export interface FleetRuntimeApiDependencies {
  repo: FleetRepository;
  getWireguard(): { manager: FleetWireGuardManager; settings: FleetWireGuardSettings } | null;
  readBody(request: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>;
  send(response: ServerResponse, body: unknown, status?: number): void;
}

export function createFleetRuntimeApi(deps: FleetRuntimeApiDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> => {
    const heartbeat = request.method === "POST" && pathname === "/api/fleet/agent/heartbeat";
    const session = request.method === "POST" && pathname === "/api/fleet/agent/runtime-session";
    const desired = request.method === "GET" && pathname === "/api/fleet/agent/desired-state";
    const capacity = request.method === "PATCH" && /^\/api\/fleet\/nodes\/[^/]+\/capacity$/.test(pathname);
    const overlay = pathname === "/api/fleet/wireguard" || pathname === "/api/fleet/wireguard/setup" || pathname === "/api/fleet/wireguard/migrate";
    if (!heartbeat && !session && !desired && !capacity && !overlay) return false;
    try {
      if (heartbeat || session || desired) {
        const body = desired ? {} : await deps.readBody(request, 65_536);
        const nodeId = desired ? new URL(request.url ?? "/", "http://localhost").searchParams.get("nodeId") ?? String(request.headers["x-node-id"] ?? "") : typeof body.nodeId === "string" ? body.nodeId : "";
        const auth = request.headers.authorization;
        const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
        if (!nodeId || !await deps.repo.verifyNodeAgentToken(nodeId, token)) {
          deps.send(response, { error: "Invalid node credential" }, 401);
          return true;
        }
        if (session) {
          await deps.repo.startRuntimeSession(nodeId, parseFleetSessionId(body.sessionId));
          deps.send(response, { accepted: true });
        } else if (heartbeat) {
          // Parse the entire boundary before mutating any liveness/device/runtime state.
          const device = body.device == null ? null : parseFleetDevice(body.device);
          const runtime = body.runtime == null ? null : parseFleetRuntime(body.runtime);
          if (body.agentVersion !== undefined && (typeof body.agentVersion !== "string" || body.agentVersion.length > 64)) throw new Error("Invalid agentVersion");
          const status = body.status === undefined ? "online" : body.status;
          if (status !== "online" && status !== "degraded" && status !== "offline") throw new Error("Invalid status");
          if (device) await deps.repo.recordNodeDevice(nodeId, device);
          const result = runtime ? await deps.repo.recordNodeRuntime(nodeId, runtime) : null;
          await deps.repo.recordHeartbeat(nodeId, { status, agentVersion: body.agentVersion as string | undefined });
          deps.send(response, { ok: true, ...(result ? { runtimeAccepted: result.accepted } : {}) });
        } else {
          const state = await deps.repo.getNodeDesiredState(nodeId);
          if (!state) deps.send(response, { error: "Node not found" }, 404);
          else {
            const node = await deps.repo.getNode(nodeId);
            const configured = deps.getWireguard();
            let wireguard = null;
            let wireguardError: string | null = null;
            const isApproved = deps.repo.isOverlayApproved(nodeId);
            if (configured && node && isApproved && !node.tailscale_ip) {
              try {
                const preflight = await configured.manager.preflight();
                wireguard = { interfaceName: configured.settings.interfaceName, addressCidr: `${node.wireguard_ip}/24`, controllerPublicKey: preflight.publicKey, controllerEndpoint: configured.settings.publicEndpoint, allowedIps: ["10.77.0.0/24"], persistentKeepaliveSeconds: 25, mtu: configured.settings.mtu };
              } catch (error) {
                wireguardError = error instanceof Error ? error.message : "WireGuard setup unavailable";
              }
            }
            deps.send(response, { ...state, wireguard, wireguardError });
          }
        }
        return true;
      }
      if (!requireDashboardAuth(request).authenticated) {
        deps.send(response, { error: "Unauthorized" }, 401);
        return true;
      }
      if (capacity) {
        const nodeId = decodeURIComponent(pathname.split("/")[4]);
        const body = parseFleetCapacity(await deps.readBody(request, 1024));
        const node = await deps.repo.updateNodeCapacity(nodeId, body);
        deps.send(response, { node });
        return true;
      }
      const configured = deps.getWireguard();
      if (!configured) {
        deps.send(response, { configured: false, settings: null, observation: null, error: "Save actual controller WireGuard settings before setup" }, request.method === "GET" ? 200 : 409);
        return true;
      }
      if (request.method === "GET" && pathname === "/api/fleet/wireguard") {
        const observation = await configured.manager.observe();
        let publicKey: string | null = null;
        let error: string | null = null;
        try { publicKey = (await configured.manager.preflight()).publicKey; }
        catch (cause) { error = cause instanceof Error ? cause.message : "WireGuard preflight unavailable"; }
        deps.send(response, { configured: true, settings: configured.settings, observation, publicKey, error });
      } else if (request.method === "POST" && pathname === "/api/fleet/wireguard/setup") {
        const setup = await configured.manager.setup();
        deps.send(response, { configured: true, settings: configured.settings, ...setup });
      } else if (request.method === "POST" && pathname === "/api/fleet/wireguard/migrate") {
        const body = await deps.readBody(request, 32_768);
        if (!Array.isArray(body.nodeIds) || body.nodeIds.length > 254 || body.nodeIds.some(id => typeof id !== "string")) throw new Error("nodeIds must be an explicit list of existing node IDs");
        const nodes = await deps.repo.listNodes();
        const requested = new Set(body.nodeIds as string[]);
        for (const id of requested) if (!nodes.some(node => node.id === id && node.role !== "controller-worker")) throw new Error("Migration references an unknown or protected node");
        await configured.manager.preflight();
        const approvedIds = new Set(deps.repo.getApprovedNodeIds());
        for (const id of requested) approvedIds.add(id);
        const peers = nodes.filter(node => node.role !== "controller-worker" && node.wireguard_public_key && approvedIds.has(node.id)).map(node => ({ nodeId: node.id, publicKey: node.wireguard_public_key!, address: node.wireguard_ip }));
        await configured.manager.reconcilePeers(peers);
        for (const id of requested) deps.repo.setOverlayApproved(id, true);
        deps.send(response, { configured: true, migratedNodeIds: [...requested], observation: await configured.manager.observe() });
      } else deps.send(response, { error: "Method not allowed" }, 405);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fleet runtime operation failed";
      deps.send(response, { error: message.slice(0, 2048) }, message === "Node not found" ? 404 : 400);
    }
    return true;
  };
}
