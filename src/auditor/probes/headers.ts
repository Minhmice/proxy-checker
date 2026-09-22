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

function redactValue(val: string, baselineIps: string[]): string {
  let redacted = val;
  for (const ip of baselineIps) {
    if (!ip) continue;
    const regex = new RegExp(ip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    redacted = redacted.replace(regex, "[REDACTED_IP]");
  }
  redacted = redacted.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[REDACTED_IP]");
  redacted = redacted.replace(/\b[0-9a-fA-F:]{3,39}\b/g, (match) =>
    match.includes(":") ? "[REDACTED_IP]" : match
  );
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

    const leakHeaders: Array<{ name: string; value: string; revealsRealIp?: boolean }> = [];
    let viaPresent = false;
    let xForwardedForPresent = false;
    let originIpExposed = false;

    const normalizedBaseline = baselineIps
      .map((ip) => ip.trim().toLowerCase())
      .filter((ip) => Boolean(ip));

    for (const [k, v] of Object.entries(res.headers)) {
      const lower = k.toLowerCase();
      if (lower === "via") viaPresent = true;
      if (lower === "x-forwarded-for") xForwardedForPresent = true;

      const matchedTargetHeader = TARGET_LEAK_HEADERS[lower] === true;
      const suspicious =
        matchedTargetHeader ||
        lower.startsWith("x-") ||
        lower.includes("proxy");

      if (suspicious) {
        const lowerVal = v.toLowerCase();
        const revealsRealIp = normalizedBaseline.some((bIp) => lowerVal.includes(bIp));
        if (revealsRealIp) {
          originIpExposed = true;
        }
        leakHeaders.push({
          name: k,
          value: redactValue(v, normalizedBaseline),
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
    socket.destroy();
  }
}
