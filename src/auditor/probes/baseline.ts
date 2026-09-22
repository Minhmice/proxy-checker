import http from "node:http";
import https from "node:https";
import type { BaselineResult } from "../types.js";
import { validateTargetHost } from "../security/ssrf.js";

export interface ProbeOptions {
  timeoutMs?: number;
  allowPrivateTargets?: boolean;
  endpoints?: string[];
  endpoint?: string;
  maxBytes?: number;
  rejectUnauthorized?: boolean;
  ca?: string | Buffer;
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

export async function probeDirectBaseline(
  options: ProbeOptions = {}
): Promise<BaselineResult & { ip?: string }> {
  const endpoint = options.endpoint || (options.endpoints && options.endpoints[0]);
  if (!endpoint) {
    return { established: false, error: "No endpoint provided" };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 64 * 1024;
  const target = parseUrl(endpoint);

  const ssrf = await validateTargetHost(target.host, {
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    timeoutMs,
  });

  if (!ssrf.valid) {
    return {
      established: false,
      error: ssrf.reason || "Target host blocked by SSRF policy",
    };
  }

  const isHttps = target.protocol === "https";
  const client = isHttps ? https : http;

  const { promise, resolve } = Promise.withResolvers<BaselineResult & { ip?: string }>();
  const startTime = Date.now();
  let settled = false;

  const finish = (result: BaselineResult & { ip?: string }) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const req = client.request(
    {
      host: target.host,
      port: target.port,
      path: target.path,
      method: "GET",
      timeout: timeoutMs,
      headers: { Connection: "close" },
      ca: options.ca,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
    },
    (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          const err = new Error(`Response size exceeded limit of ${maxBytes} bytes`);
          res.destroy(err);
          req.destroy(err);
          finish({
            established: false,
            latencyMs: Date.now() - startTime,
            error: err.message,
          });
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const ip = extractIp(body);
        finish({
          established: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 400),
          statusCode: res.statusCode,
          latencyMs: Date.now() - startTime,
          ip,
        });
      });
    }
  );

  req.on("timeout", () => {
    req.destroy(new Error(`Timeout after ${timeoutMs}ms`));
  });

  req.on("error", (err) => {
    finish({
      established: false,
      latencyMs: Date.now() - startTime,
      error: err.message,
    });
  });

  req.end();
  return promise;
}
