import type {
  ExitIpResult,
  ParsedProxyInput,
} from "../types.js";
import { openProxyTunnel, requestThroughProxy } from "../transport/index.js";
import type { ProbeOptions } from "./baseline.js";

export type { ProbeOptions };

export interface ExitIpObservation {
  endpoint: string;
  ip?: string;
  error?: string;
}

function parseUrl(rawUrl: string): { protocol: string; host: string; port: number; path: string } {
  const parsed = new URL(rawUrl);
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  const port = parsed.port
    ? Number(parsed.port)
    : protocol === "https"
      ? 443
      : 80;
  return {
    protocol,
    host: parsed.hostname,
    port,
    path: parsed.pathname + parsed.search,
  };
}

function extractIp(body: string): string | undefined {
  const trimmed = body.trim();
  try {
    const json = JSON.parse(trimmed) as { ip?: string; origin?: string };
    if (json.ip && typeof json.ip === "string") return json.ip.trim();
    if (json.origin && typeof json.origin === "string") return json.origin.split(",")[0].trim();
  } catch {
    // plain text fallback
  }
  const match = trimmed.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (match) return match[0];
  const ipv6Match = trimmed.match(/\b[0-9a-fA-F:]{3,39}\b/);
  if (ipv6Match && ipv6Match[0].includes(":")) return ipv6Match[0];
  return undefined;
}

export async function probeExitIp(
  proxy: ParsedProxyInput,
  options: ProbeOptions = {}
): Promise<ExitIpResult & { observations: ExitIpObservation[]; consistent: boolean }> {
  const endpoints = options.endpoints || (options.endpoint ? [options.endpoint] : []);
  if (endpoints.length === 0) {
    return {
      ip: undefined,
      observations: [],
      consistent: false,
    };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const observations: ExitIpObservation[] = [];

  for (const endpoint of endpoints) {
    try {
      const target = parseUrl(endpoint);
      const { socket } = await openProxyTunnel(
        proxy,
        { host: target.host, port: target.port },
        {
          timeoutMs,
          allowPrivateTargets: options.allowPrivateTargets ?? false,
          targetDomain: target.host,
        }
      );
      try {
        const res = await requestThroughProxy(socket, {
          host: target.host,
          path: target.path,
          method: "GET",
          timeoutMs,
        });
        const ip = extractIp(res.body);
        observations.push({ endpoint, ip });
      } finally {
        socket.destroy();
      }
    } catch (err) {
      observations.push({
        endpoint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const validIps = observations.map((o) => o.ip).filter((ip): ip is string => Boolean(ip));
  const seenIps: Record<string, true> = {};
  for (const ip of validIps) {
    seenIps[ip] = true;
  }
  const uniqueIps = Object.keys(seenIps);
  const consistent = uniqueIps.length === 1 && validIps.length === endpoints.length;
  const primaryIp = uniqueIps[0];

  return {
    ip: primaryIp,
    observations,
    consistent,
  };
}
