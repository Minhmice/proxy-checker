import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateIp } from "./ip-policy.js";

export interface ValidateTargetHostOptions {
  allowPrivate?: boolean;
  allowPrivateTargets?: boolean;
  timeoutMs?: number;
}

export interface ValidateTargetHostResult {
  valid: boolean;
  resolvedIps: string[];
  reason?: string;
}

function cleanHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export async function validateTargetHost(
  host: string,
  options?: ValidateTargetHostOptions
): Promise<ValidateTargetHostResult> {
  const allowPrivate = Boolean(options?.allowPrivate || options?.allowPrivateTargets);
  const normalized = cleanHost(host);

  if (!normalized) {
    return {
      valid: false,
      resolvedIps: [],
      reason: "Host cannot be empty",
    };
  }

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    const resolvedIps = ["127.0.0.1"];
    if (allowPrivate) {
      return { valid: true, resolvedIps };
    }
    return {
      valid: false,
      resolvedIps,
      reason: "Localhost addresses are restricted by SSRF policy",
    };
  }

  if (net.isIP(normalized)) {
    const isPrivate = isPrivateIp(normalized);
    if (isPrivate && !allowPrivate) {
      return {
        valid: false,
        resolvedIps: [normalized],
        reason: `Target IP ${normalized} is a private/restricted address`,
      };
    }
    return {
      valid: true,
      resolvedIps: [normalized],
    };
  }

  const dnsTimeoutMs = options?.timeoutMs ?? 3000;
  const dnsTimeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`DNS resolution timed out after ${dnsTimeoutMs}ms`)), dnsTimeoutMs)
  );

  let resolvedIps: string[] = [];
  try {
    const resolvePromise = Promise.allSettled([
      dns.resolve4(normalized),
      dns.resolve6(normalized),
    ]);
    const [ipv4Addresses, ipv6Addresses] = await Promise.race([
      resolvePromise,
      dnsTimeoutPromise,
    ]);
    const records: string[] = [];
    if (ipv4Addresses.status === "fulfilled") {
      records.push(...ipv4Addresses.value);
    }
    if (ipv6Addresses.status === "fulfilled") {
      records.push(...ipv6Addresses.value);
    }

    resolvedIps = Array.from(new Set(records));
  } catch {
    resolvedIps = [];
  }

  if (resolvedIps.length === 0) {
    try {
      const lookupPromise = dns.lookup(normalized, { all: true });
      const lookup = await Promise.race([lookupPromise, dnsTimeoutPromise]);
      resolvedIps = Array.from(new Set(lookup.map((item) => item.address)));
    } catch (error) {
      return {
        valid: false,
        resolvedIps: [],
        reason: `Failed to resolve host ${normalized}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (resolvedIps.length === 0) {
    return {
      valid: false,
      resolvedIps: [],
      reason: `No DNS records found for host ${normalized}`,
    };
  }

  if (!allowPrivate) {
    const forbidden = resolvedIps.filter((ip) => isPrivateIp(ip));
    if (forbidden.length > 0) {
      return {
        valid: false,
        resolvedIps,
        reason: `Target resolves to restricted IP(s): ${forbidden.join(", ")}`,
      };
    }
  }

  return {
    valid: true,
    resolvedIps,
  };
}
