import type { DnsResult, ParsedProxyInput } from "../types.js";

export interface DnsProbeOptions {
  targetDomain: string;
  resolveDnsLocally?: boolean;
  timeoutMs?: number;
}

export async function probeDnsBehavior(
  proxy: ParsedProxyInput,
  options: DnsProbeOptions
): Promise<DnsResult & { resolutionMode: "local" | "remote" }> {
  let resolutionMode: "local" | "remote";

  if (proxy.protocol === "socks5") {
    resolutionMode = options.resolveDnsLocally ? "local" : "remote";
  } else {
    resolutionMode = "local";
  }

  return {
    dnsLeakDetected: null,
    resolutionMode,
  };
}
