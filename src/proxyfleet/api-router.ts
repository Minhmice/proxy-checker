import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import type { FleetRepository } from "./db.js";
import { createEnrollmentService } from "./enrollment.js";
import type { FleetNodeStatus, FleetProxyProtocol } from "./types.js";
import { readSession } from "../server/session-auth.js";

export interface FleetApiHandlerOptions {
  repo: FleetRepository;
  verifyAuth: (candidate: string) => boolean;
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
  const { repo, verifyAuth } = options;
  const enrollmentService = createEnrollmentService(repo);

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
        if (!nodeId) {
          sendJson(res, 400, { error: "nodeId is required" });
          return true;
        }

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
        if (!nodeId) {
          sendJson(res, 400, { error: "nodeId is required" });
          return true;
        }

        const endpoints = await repo.listEndpoints({ nodeId, enabled: true });
        const proxies = await Promise.all(
          endpoints.map(async (ep) => {
            const creds = await repo.getEndpointCredentials(ep.id);
            return {
              id: ep.id,
              node_id: ep.node_id,
              protocol: ep.protocol,
              listen_ip: ep.listen_ip,
              listen_port: ep.listen_port,
              username: creds?.username || ep.username,
              password: creds?.password || "",
              enabled: ep.enabled,
              current_revision: ep.current_revision,
            };
          })
        );

        sendJson(res, 200, {
          revision: Date.now(),
          proxies,
        });
      } catch (err) {
        sendJson(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    if (req.method === "POST" && pathname === "/api/fleet/agent/deployment-result") {
      try {
        const body = await readBody(req);
        const nodeId = String(body.nodeId || "");
        const status = String(body.status || "applied");
        await repo.recordEvent({
          nodeId,
          eventType: status === "applied" ? "deployment.applied" : "deployment.failed",
          level: status === "applied" ? "info" : "error",
          payload: body,
        });
        sendJson(res, 200, { ok: true });
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

    if (req.method === "GET" && pathname === "/api/fleet/nodes") {
      const parsed = new URL(req.url || "/", "http://localhost");
      const status = parsed.searchParams.get("status") as FleetNodeStatus | undefined;
      const nodes = await repo.listNodes({ status });
      sendJson(res, 200, { nodes });
      return true;
    }

    if (req.method === "GET" && pathname.startsWith("/api/fleet/nodes/")) {
      const id = decodeURIComponent(pathname.slice("/api/fleet/nodes/".length));
      const node = await repo.getNode(id);
      if (!node) {
        sendJson(res, 404, { error: "Node not found" });
        return true;
      }
      const endpoints = await repo.listEndpoints({ nodeId: id });
      const events = await repo.listEvents({ nodeId: id, limit: 20 });
      sendJson(res, 200, { node, endpoints, events });
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
