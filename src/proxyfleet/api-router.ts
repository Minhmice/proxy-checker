import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { FleetRepository } from "./db.js";
import { createEnrollmentService, type EnrollmentService } from "./enrollment.js";
import type { FleetNodeStatus, FleetProxyProtocol, NodeRemovalService } from "./types.js";
import { readSession } from "../server/session-auth.js";
import { generateRandomToken } from "./security.js";
import { inspectSshHostKey } from "./tailscale-ssh.js";
import { createProvisioningService, type ProvisioningService } from "./provisioning.js";
export interface FleetApiHandlerOptions {
  repo: FleetRepository;
  verifyAuth: (candidate: string) => boolean;
  nodeRemovalService?: NodeRemovalService;
  enrollmentService?: EnrollmentService;
  provisioningService?: ProvisioningService;
  enrollmentOptions?: {
    serverWireguardPublicKey?: string;
    serverWireguardEndpoint?: string;
  };
}
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseAuth(req: IncomingMessage, verifyAuth: (candidate: string) => boolean): boolean {
  if (req.headers.cookie && readSession(req.headers.cookie)) return true;
  const header = req.headers.authorization;
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0 && decoded.slice(0, colon) === "admin") {
      if (verifyAuth(decoded.slice(colon + 1))) return true;
    }
  }
  if (header?.startsWith("Bearer ")) {
    if (verifyAuth(header.slice(7).trim())) return true;
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.split("; ").find((c) => c.startsWith("minhmiceproxy-auth="));
    if (match) {
      const cookiePass = decodeURIComponent(match.slice("minhmiceproxy-auth=".length));
      if (verifyAuth(cookiePass)) return true;
    }
  }
  return false;
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const chunks: Buffer[] = [];
  let received = 0;

  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxBytes) {
      req.destroy();
      reject(new Error("Request payload too large"));
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      resolve({});
      return;
    }
    try {
      resolve(JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      reject(err);
    }
  });

  req.on("error", reject);
  return promise;
}

export function createFleetApiHandler(options: FleetApiHandlerOptions) {
  const { repo, verifyAuth, nodeRemovalService } = options;
  const provisioningService =
    options.provisioningService || createProvisioningService({ repo });
  const enrollmentService =
    options.enrollmentService || createEnrollmentService(repo, options.enrollmentOptions);
  async function authenticateAgent(req: IncomingMessage, res: ServerResponse, nodeId: string): Promise<boolean> {
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!nodeId || !token || !(await repo.verifyNodeAgentToken(nodeId, token))) {
      sendJson(res, 401, { error: "Invalid node credential" });
      return false;
    }
    return true;
  }

  return async function handleFleetApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string
  ): Promise<boolean> {
    if (!pathname.startsWith("/api/fleet/")) return false;

    // 1. Public or token-authenticated worker routes:
    if (req.method === "POST" && pathname === "/api/fleet/enroll") {
      try {
        const body = await readBody(req);
        const token = String(body.token || "");
        const nodeName = String(body.nodeName || "");
        const wireguardPublicKey = String(body.wireguardPublicKey || "");
        const publicIp = body.publicIp ? String(body.publicIp) : undefined;
        const os = body.os ? String(body.os) : undefined;
        const arch = body.arch ? String(body.arch) : undefined;
        const agentVersion = body.agentVersion ? String(body.agentVersion) : undefined;

        if (!token || !nodeName || !wireguardPublicKey) {
          sendJson(res, 400, { error: "token, nodeName, and wireguardPublicKey are required" });
          return true;
        }

        const enrolled = await enrollmentService.enrollNode({
          token,
          nodeName,
          wireguardPublicKey,
          publicIp,
          os,
          arch,
          agentVersion,
        });

        sendJson(res, 200, enrolled);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/agent/heartbeat") {
      try {
        const body = await readBody(req);
        const nodeId = String(body.nodeId || "");
        if (!(await authenticateAgent(req, res, nodeId))) return true;

        await repo.recordHeartbeat(nodeId, {
          status: (body.status as FleetNodeStatus) || "online",
          cpuUsage: typeof body.cpuUsage === "number" ? body.cpuUsage : undefined,
          memoryUsage: typeof body.memoryUsage === "number" ? body.memoryUsage : undefined,
          publicIp: body.publicIp ? String(body.publicIp) : undefined,
          agentVersion: body.agentVersion ? String(body.agentVersion) : undefined,
        });

        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/fleet/agent/desired-state") {
      try {
        const parsed = new URL(req.url || "/", "http://localhost");
        const nodeId = parsed.searchParams.get("nodeId") || String(req.headers["x-node-id"] || "");
        if (!(await authenticateAgent(req, res, nodeId))) return true;
        const state = await repo.getNodeDesiredState(nodeId);
        if (!state) {
          sendJson(res, 404, { error: "Node not found" });
          return true;
        }
        sendJson(res, 200, state);
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/agent/deployment-result") {
      try {
        const body = await readBody(req);
        const nodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
        if (!nodeId || nodeId.length > 128) {
          sendJson(res, 400, { error: "Invalid nodeId" });
          return true;
        }

        if (!(await authenticateAgent(req, res, nodeId))) return true;

        const rawRevision = body.revision;
        const revision = typeof rawRevision === "number" ? rawRevision : Number(rawRevision);
        if (!Number.isSafeInteger(revision) || revision <= 0) {
          sendJson(res, 400, { error: "Invalid revision: must be positive safe integer" });
          return true;
        }

        const status = body.status;
        if (status !== "applied" && status !== "failed") {
          sendJson(res, 400, { error: "Invalid status: must be 'applied' or 'failed'" });
          return true;
        }

        const configDigest = typeof body.configDigest === "string" ? body.configDigest.trim() : "";
        if (!configDigest || configDigest.length > 128) {
          sendJson(res, 400, { error: "Invalid configDigest" });
          return true;
        }

        const rawErrorMessage = body.errorMessage;
        if (rawErrorMessage !== undefined && rawErrorMessage !== null && typeof rawErrorMessage !== "string") {
          sendJson(res, 400, { error: "errorMessage must be a string if provided" });
          return true;
        }
        const errorMessage = typeof rawErrorMessage === "string" ? rawErrorMessage : undefined;
        if (errorMessage && errorMessage.length > 2048) {
          sendJson(res, 400, { error: "errorMessage exceeds 2048 characters" });
          return true;
        }

        const outcome = await repo.recordDeploymentResult({
          nodeId,
          revision,
          configDigest,
          status,
          errorMessage,
        });

        if (outcome.reason === "future_revision") {
          sendJson(res, 400, { ok: false, accepted: false, reason: "future_revision", error: "Future revision not accepted" });
          return true;
        }

        if (outcome.reason === "node_not_found") {
          sendJson(res, 404, { error: "Node not found" });
          return true;
        }

        sendJson(res, 200, {
          ok: outcome.ok,
          accepted: outcome.accepted,
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    // 2. Protected Dashboard & Admin APIs:
    if (!parseAuth(req, verifyAuth)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/enrollment-tokens") {
      try {
        const body = await readBody(req);
        const nodeName = String(body.nodeName || "");
        if (!nodeName) {
          sendJson(res, 400, { error: "nodeName is required" });
          return true;
        }
        const ttlMinutes = typeof body.ttlMinutes === "number" ? body.ttlMinutes : undefined;
        const result = await enrollmentService.issueToken({ nodeName, ttlMinutes });
        sendJson(res, 201, result);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/ssh/host-key") {
      try {
        const body = await readBody(req);
        const host = String(body.host || "").trim();
        const port = Number(body.port || 22);
        if (!host) {
          sendJson(res, 400, { error: "host is required" });
          return true;
        }
        const keyInfo = await inspectSshHostKey({ host, port });
        sendJson(res, 200, keyInfo);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/nodes/provision") {
      try {
        const body = await readBody(req);
        const tailscaleIp = String(body.tailscaleIp || "").trim();
        const username = String(body.username || "").trim();
        const password = String(body.password || "");
        const hostKeyFingerprint = String(body.hostKeyFingerprint || "").trim();
        const controllerUrl = String(body.controllerUrl || "").trim();
        const name = body.name ? String(body.name).trim() : undefined;
        const expectedPublicIp = body.expectedPublicIp ? String(body.expectedPublicIp).trim() : undefined;
        const sshPort = typeof body.sshPort === "number" ? body.sshPort : undefined;

        if (!tailscaleIp || !username || !password || !hostKeyFingerprint || !controllerUrl) {
          sendJson(res, 400, { error: "tailscaleIp, username, password, hostKeyFingerprint, and controllerUrl are required" });
          return true;
        }

        const result = await provisioningService.provision({
          name,
          tailscaleIp,
          username,
          password,
          hostKeyFingerprint,
          expectedPublicIp,
          sshPort,
          controllerUrl,
        });

        sendJson(res, 202, { nodeId: result.nodeId, status: "provisioning" });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/provision\/retry$/.test(pathname)) {
      try {
        const parts = pathname.split("/");
        const nodeId = decodeURIComponent(parts[4]);
        const body = await readBody(req);
        const controllerUrl = String(body.controllerUrl || "").trim();
        if (!controllerUrl) {
          sendJson(res, 400, { error: "controllerUrl is required" });
          return true;
        }
        await provisioningService.retry(nodeId, controllerUrl);
        sendJson(res, 202, { nodeId, status: "retrying" });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/verify-and-activate$/.test(pathname)) {
      try {
        const parts = pathname.split("/");
        const nodeId = decodeURIComponent(parts[4]);
        const node = await provisioningService.verifyAndActivate(nodeId);
        sendJson(res, 200, { node });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/disable$/.test(pathname)) {
      try {
        const parts = pathname.split("/");
        const nodeId = decodeURIComponent(parts[4]);
        const body = await readBody(req);
        const reason = body.reason ? String(body.reason) : undefined;
        const node = await provisioningService.disable(nodeId, reason);
        sendJson(res, 200, { node });
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/fleet/nodes") {
      const parsed = new URL(req.url || "/", "http://localhost");
      const status = parsed.searchParams.get("status") as FleetNodeStatus | undefined;
      const nodes = await repo.listNodes({ status });
      sendJson(res, 200, { nodes });
      return true;
    }

    if (req.method === "POST" && /^\/api\/fleet\/nodes\/[^/]+\/agent-token$/.test(pathname)) {
      const nodeId = decodeURIComponent(pathname.split("/")[4]);
      if (!(await repo.getNode(nodeId))) {
        sendJson(res, 404, { error: "Node not found" });
        return true;
      }
      const agentToken = `fla_${generateRandomToken(32)}`;
      await repo.setNodeAgentToken(nodeId, agentToken);
      sendJson(res, 200, { nodeId, agentToken });
      return true;
    }

    if (req.method === "DELETE" && /^\/api\/fleet\/nodes\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/api/fleet/nodes/".length));
      const node = await repo.getNode(id);
      const existingRemoval = await repo.getNodeRemoval(id);
      if (!node && !existingRemoval) {
        sendJson(res, 404, { error: "Node not found" });
        return true;
      }
      if (node && (node.role === "controller-worker" || node.wireguardIp === "10.77.0.1")) {
        sendJson(res, 409, { error: "Cannot remove controller node" });
        return true;
      }

      if (!nodeRemovalService) {
        sendJson(res, 503, { error: "Node removal service not configured" });
        return true;
      }

      try {
        const removal = await nodeRemovalService.remove(id);
        const status = removal.status === "completed" ? 200 : 202;
        sendJson(res, status, { removal });
      } catch (err) {
        const status = (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number")
          ? err.statusCode
          : 500;
        sendJson(res, status, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/fleet/node-removals") {
      const removals = await repo.listPendingNodeRemovals();
      sendJson(res, 200, { removals });
      return true;
    }

    if (req.method === "GET" && /^\/api\/fleet\/node-removals\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/api/fleet/node-removals/".length));
      const removal = await repo.getNodeRemoval(id);
      if (!removal) {
        sendJson(res, 404, { error: "Removal record not found" });
        return true;
      }
      sendJson(res, 200, { removal });
      return true;
    }

    if (req.method === "POST" && /^\/api\/fleet\/node-removals\/[^/]+\/retry$/.test(pathname)) {
      const parts = pathname.split("/");
      const id = decodeURIComponent(parts[4]);
      const existingRemoval = await repo.getNodeRemoval(id);
      if (!existingRemoval) {
        sendJson(res, 404, { error: "Removal record not found" });
        return true;
      }
      if (!nodeRemovalService) {
        sendJson(res, 503, { error: "Node removal service not configured" });
        return true;
      }
      try {
        const removal = await nodeRemovalService.remove(id);
        const status = removal.status === "completed" ? 200 : 202;
        sendJson(res, status, { removal });
      } catch (err) {
        const status = (err && typeof err === "object" && "statusCode" in err && typeof err.statusCode === "number")
          ? err.statusCode
          : 500;
        sendJson(res, status, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "GET" && /^\/api\/fleet\/nodes\/[^/]+$/.test(pathname)) {
      const id = decodeURIComponent(pathname.slice("/api/fleet/nodes/".length));
      const node = await repo.getNode(id);
      if (!node) {
        sendJson(res, 404, { error: "Node not found" });
        return true;
      }
      const endpoints = await repo.listEndpoints({ nodeId: id });
      const events = await repo.listEvents({ nodeId: id, limit: 20 });
      const deployments = await repo.getNodeDeployments(id);
      sendJson(res, 200, { node, endpoints, events, deployments });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/fleet/endpoints") {
      const parsed = new URL(req.url || "/", "http://localhost");
      const nodeId = parsed.searchParams.get("nodeId") || undefined;
      const endpoints = await repo.listEndpoints({ nodeId });
      sendJson(res, 200, { endpoints });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/endpoints") {
      try {
        const body = await readBody(req);
        const nodeId = String(body.nodeId || "");
        const protocol = (body.protocol as FleetProxyProtocol) || "http";
        const listenIp = String(body.listenIp || "10.77.0.11");
        const listenPort = Number(body.listenPort);
        const username = String(body.username || "");
        const password = String(body.password || "");

        if (!nodeId || !listenPort || !username) {
          sendJson(res, 400, { error: "nodeId, listenPort, and username are required" });
          return true;
        }

        const endpoint = await repo.createProxyEndpoint({
          nodeId,
          protocol,
          listenIp,
          listenPort,
          username,
          password,
          enabled: body.enabled !== false,
        });

        sendJson(res, 201, endpoint);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname.startsWith("/api/fleet/endpoints/") && pathname.endsWith("/credentials/reveal")) {
      const parts = pathname.split("/");
      const endpointId = decodeURIComponent(parts[parts.length - 3]);
      const creds = await repo.getEndpointCredentials(endpointId);
      if (!creds) {
        sendJson(res, 404, { error: "Credentials not found for endpoint" });
        return true;
      }
      sendJson(res, 200, creds);
      return true;
    }

    if (req.method === "PATCH" && pathname.startsWith("/api/fleet/endpoints/")) {
      const parts = pathname.split("/");
      const endpointId = decodeURIComponent(parts[parts.length - 1]);
      try {
        const body = await readBody(req);
        if (typeof body.enabled !== "boolean") {
          sendJson(res, 400, { error: "enabled must be a boolean" });
          return true;
        }
        const updated = await repo.updateEndpoint(endpointId, { enabled: body.enabled });
        sendJson(res, 200, updated);
      } catch (err) {
        sendJson(res, 400, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "GET" && pathname === "/api/fleet/events") {
      const parsed = new URL(req.url || "/", "http://localhost");
      const nodeId = parsed.searchParams.get("nodeId") || undefined;
      const endpointId = parsed.searchParams.get("endpointId") || undefined;
      const limit = Number(parsed.searchParams.get("limit") || "100");
      const events = await repo.listEvents({ nodeId, endpointId, limit });
      sendJson(res, 200, { events });
      return true;
    }

    return false;
  };
}
