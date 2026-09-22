import type { HeaderLeakResult, ParsedProxyInput } from "../types.js";
import { openProxyTunnel, requestThroughProxy } from "../transport/index.js";
import type { ProbeOptions } from "./baseline.js";

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

      const suspicious =
        lower.startsWith("x-") ||
        lower === "via" ||
        lower === "forwarded" ||
        lower.includes("proxy");

      if (suspicious) {
        const lowerVal = v.toLowerCase();
        const revealsRealIp = normalizedBaseline.some((bIp) => lowerVal.includes(bIp));
        if (revealsRealIp) {
          originIpExposed = true;
        }
        leakHeaders.push({
          name: k,
          value: v,
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
