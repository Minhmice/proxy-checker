import type { FleetRepository } from "./db.js";
import type { ProxyIntelligenceRepository } from "../server/proxy-intelligence-repository.js";

export interface ResolvedAuditEndpoint {
  targetUrl: string;
  protocol: string;
  host: string;
  port: number;
  options: {
    allowPrivateTargets?: boolean;
    allowedPrivateIps?: string[];
    timeoutMs?: number;
    attempts?: number;
  };
}

export async function resolveManagedEndpointForAudit(
  fleetRepo: FleetRepository,
  endpointId: string,
): Promise<ResolvedAuditEndpoint | null> {
  const endpoint = await fleetRepo.getEndpoint(endpointId);
  if (!endpoint) return null;

  const creds = await fleetRepo.getEndpointCredentials(endpointId);
  const username = creds?.username || endpoint.username;
  const password = creds?.password || "";

  let authPrefix = "";
  if (username) {
    authPrefix = password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : `${encodeURIComponent(username)}@`;
  }

  const targetUrl = `${endpoint.protocol}://${authPrefix}${endpoint.listen_ip}:${endpoint.listen_port}`;

  return {
    targetUrl,
    protocol: endpoint.protocol,
    host: endpoint.listen_ip,
    port: endpoint.listen_port,
    options: {
      allowPrivateTargets: true,
      allowedPrivateIps: [endpoint.listen_ip],
      timeoutMs: 5000,
      attempts: 2,
    },
  };
}

export async function syncFleetEndpointsToIntelligence(
  fleetRepo: FleetRepository,
  intelRepo: ProxyIntelligenceRepository,
): Promise<number> {
  const endpoints = await fleetRepo.listEndpoints({ enabled: true });
  if (endpoints.length === 0) return 0;

  const rows: Array<{ nodeId: string; endpointId: string; proxyUrl: string }> = [];
  for (const ep of endpoints) {
    const creds = await fleetRepo.getEndpointCredentials(ep.id);
    const username = creds?.username || ep.username;
    const password = creds?.password || "";

    let authPart = "";
    if (username) {
      authPart = password
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : `${encodeURIComponent(username)}@`;
    }
    const proxyUrl = `${ep.protocol}://${authPart}${ep.listen_ip}:${ep.listen_port}`;
    rows.push({
      nodeId: ep.node_id,
      endpointId: ep.id,
      proxyUrl,
    });
  }

  return await intelRepo.syncManagedFleetEndpoints(rows);
}
