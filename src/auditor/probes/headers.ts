import net from "node:net";
import tls from "node:tls";
import type { HeaderLeakResult, ParsedProxyInput } from "../types.js";
import { openProxyTunnel, requestThroughProxy } from "../transport/index.js";
import type { ProbeOptions } from "./baseline.js";

const TARGET_LEAK_HEADERS: Record<string, true> = {
  forwarded: true,
  "x-forwarded-for": true,
  "x-real-ip": true,
  via: true,
  "client-ip": true,
  "true-client-ip": true,
  "cf-connecting-ip": true,
  "proxy-connection": true,
};

const ALWAYS_REDACT_HEADER_NAMES: Record<string, true> = {
  authorization: true,
  "proxy-authorization": true,
  cookie: true,
  "set-cookie": true,
  "x-api-key": true,
  "x-auth-token": true,
};

export function canonicalizeIp(ip: string): string {
  const trimmed = ip.trim().toLowerCase();
  if (net.isIPv4(trimmed)) {
    return trimmed;
  }
  if (net.isIPv6(trimmed)) {
    let clean = trimmed;
    // Handle IPv4-mapped IPv6 like ::ffff:192.0.2.1
    if (clean.includes(".")) {
      const lastColon = clean.lastIndexOf(":");
      const ipv4Part = clean.slice(lastColon + 1);
      const v4Octets = ipv4Part.split(".").map(Number);
      const hex1 = ((v4Octets[0] << 8) | v4Octets[1]).toString(16);
      const hex2 = ((v4Octets[2] << 8) | v4Octets[3]).toString(16);
      clean = clean.slice(0, lastColon) + `:${hex1}:${hex2}`;
    }

    // Split on ::
    const doubleColonParts = clean.split("::");
    let fullWords: string[] = [];

    if (doubleColonParts.length === 2) {
      const leftWords = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
      const rightWords = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
      const missingCount = 8 - (leftWords.length + rightWords.length);
      const zeroFill = new Array(Math.max(0, missingCount)).fill("0");
      fullWords = [...leftWords, ...zeroFill, ...rightWords];
    } else {
      fullWords = clean.split(":");
    }

    // Normalize each 16-bit word to lower-case hex without leading zeros (or 0)
    const normalizedWords = fullWords.map((w) => {
      const parsed = Number.parseInt(w || "0", 16);
      return Number.isNaN(parsed) ? "0" : parsed.toString(16);
    });

    return normalizedWords.join(":");
  }
  return trimmed;
}

export function extractIpCandidates(headerValue: string): string[] {
  const candidates: string[] = [];
  // Split on commas, semicolons, and whitespace
  const rawTokens = headerValue.split(/[,;\s]+/);

  for (const raw of rawTokens) {
    if (!raw) continue;
    // Strip quotes and leading "for=" prefix (case-insensitive)
    let token = raw.replace(/^"+|"+$/g, "");
    token = token.replace(/^for=/i, "");
    token = token.replace(/^"+|"+$/g, "");
    if (!token) continue;

    // Pattern 1: [IPv6]:port or [IPv6]
    const bracketMatch = token.match(/^\[([0-9a-fA-F:]+)\](?::\d+)?$/);
    if (bracketMatch && bracketMatch[1] && net.isIPv6(bracketMatch[1])) {
      candidates.push(bracketMatch[1].toLowerCase());
      continue;
    }

    // Pattern 2: IPv4:port
    const colonIdx = token.indexOf(":");
    if (colonIdx !== -1) {
      const partBefore = token.slice(0, colonIdx);
      const partAfter = token.slice(colonIdx + 1);
      if (net.isIPv4(partBefore) && /^\d+$/.test(partAfter)) {
        candidates.push(partBefore);
        continue;
      }
    }

    // Pattern 3: Bare IPv4 or IPv6
    if (net.isIP(token)) {
      candidates.push(token.toLowerCase());
      continue;
    }
  }

  return candidates;
}

function redactValue(val: string, baselineIps: string[]): string {
  let redacted = val;
  for (const ip of baselineIps) {
    if (!ip) continue;
    const escaped = ip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`(?<![0-9a-zA-Z.:])${escaped}(?![0-9a-zA-Z.:])`, "gi");
    redacted = redacted.replace(regex, "[REDACTED_IP]");
  }
  redacted = redacted.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]");
  redacted = redacted.replace(/\b[0-9a-fA-F:]{3,39}\b/g, (match) =>
    match.includes(":") ? "[REDACTED_IP]" : match
  );

  redacted = redacted.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]");
  redacted = redacted.replace(/Authorization:\s*[^;\r\n]+/gi, "Authorization: [REDACTED]");
  redacted = redacted.replace(/\b(token|key|cookie)=([^;\s,]+)/gi, "$1=[REDACTED]");

  return redacted;
}

export async function probeHeaderLeak(
  proxy: ParsedProxyInput,
  baselineIps: string[],
  options: ProbeOptions = {}
): Promise<HeaderLeakResult & { originIpExposed: boolean }> {
  const endpoint = options.endpoint || (options.endpoints && options.endpoints[0]);
  if (!endpoint) {
    return {
      detected: false,
      originIpExposed: false,
      viaPresent: false,
      xForwardedForPresent: false,
      headers: [],
    };
  }

  const timeoutMs = options.timeoutMs ?? 5000;
  const parsed = new URL(endpoint);
  const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
  const port = parsed.port ? Number(parsed.port) : protocol === "https" ? 443 : 80;
  const target = {
    host: parsed.hostname,
    port,
    path: parsed.pathname + parsed.search,
  };

  const { socket: rawSocket } = await openProxyTunnel(
    proxy,
    { host: target.host, port: target.port },
    {
      timeoutMs,
      allowPrivateTargets: options.allowPrivateTargets ?? false,
      targetDomain: target.host,
    }
  );

  const isHttps = protocol === "https";
  let appSocket: net.Socket = rawSocket;

  try {
    if (isHttps) {
      const { promise: pTls, resolve: resTls, reject: rejTls } = Promise.withResolvers<tls.TLSSocket>();
      const tlsSocket = tls.connect({
        socket: rawSocket,
        servername: target.host,
        rejectUnauthorized: true,
        ca: options.ca,
        timeout: timeoutMs,
      });

      tlsSocket.once("secureConnect", () => resTls(tlsSocket));
      tlsSocket.once("timeout", () => {
        tlsSocket.destroy();
        rawSocket.destroy();
        rejTls(new Error(`Timeout after ${timeoutMs}ms waiting for TLS handshake`));
      });
      tlsSocket.once("error", (err) => {
        tlsSocket.destroy();
        rawSocket.destroy();
        rejTls(err);
      });

      appSocket = await pTls;
    }

    const res = await requestThroughProxy(appSocket, {
      host: target.host,
      path: target.path,
      method: "GET",
      timeoutMs,
    });

    const leakHeaders: Array<{ name: string; value: string; revealsRealIp?: boolean }> = [];
    let viaPresent = false;
    let xForwardedForPresent = false;
    let originIpExposed = false;

    const canonicalBaseline = baselineIps
      .map(canonicalizeIp)
      .filter((ip) => Boolean(ip));

    for (const [k, v] of Object.entries(res.headers)) {
      const lower = k.toLowerCase();
      if (lower === "via") viaPresent = true;
      if (lower === "x-forwarded-for") xForwardedForPresent = true;

      const isAlwaysRedact = ALWAYS_REDACT_HEADER_NAMES[lower] === true;
      const matchedTargetHeader = TARGET_LEAK_HEADERS[lower] === true;
      const suspicious =
        isAlwaysRedact ||
        matchedTargetHeader ||
        lower.startsWith("x-") ||
        lower.includes("proxy");

      if (suspicious) {
        const candidates = extractIpCandidates(v).map(canonicalizeIp);
        const revealsRealIp = canonicalBaseline.some((bIp) =>
          candidates.includes(bIp)
        );

        if (revealsRealIp) {
          originIpExposed = true;
        }

        const value = isAlwaysRedact ? "[REDACTED]" : redactValue(v, baselineIps);

        leakHeaders.push({
          name: k,
          value,
          revealsRealIp,
        });
      }
    }

    const detected = viaPresent || xForwardedForPresent || originIpExposed || leakHeaders.length > 0;

    return {
      detected,
      originIpExposed,
      viaPresent,
      xForwardedForPresent,
      headers: leakHeaders,
    };
  } finally {
    appSocket.destroy();
    rawSocket.destroy();
  }
}
