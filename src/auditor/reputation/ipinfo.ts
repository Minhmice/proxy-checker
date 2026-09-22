import type { ProviderContext, RawProviderReport } from "./provider.js";

export interface IpinfoData {
  asn?: string;
  isp?: string;
  country?: string;
  hosting?: boolean;
  vpn?: boolean;
  proxy?: boolean;
  tor?: boolean;
}

export async function fetchIpinfo(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<IpinfoData>> {
  if (!context.apiKey) {
    return { provider: "ipinfo", status: "unavailable" };
  }

  const endpoint = (context.endpoint ?? "https://ipinfo.io").replace(/\/$/, "");
  const url = `${endpoint}/${encodeURIComponent(ip)}/json?token=${encodeURIComponent(context.apiKey)}`;
  const fetchImpl = context.fetch ?? fetch;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(context.timeoutMs ?? 5000),
    });

    if (!res.ok) {
      return {
        provider: "ipinfo",
        status: "error",
        statusCode: res.status,
        error: `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as {
      org?: string;
      country?: string;
      privacy?: {
        hosting?: boolean;
        vpn?: boolean;
        proxy?: boolean;
        tor?: boolean;
      };
    };

    let asn: string | undefined;
    let isp: string | undefined;
    if (typeof payload.org === "string") {
      const match = payload.org.match(/^(AS\d+)\s*(.*)$/i);
      if (match) {
        asn = match[1]?.toUpperCase();
        isp = match[2]?.trim() || undefined;
      } else {
        isp = payload.org.trim();
      }
    }

    return {
      provider: "ipinfo",
      status: "ok",
      statusCode: res.status,
      data: {
        asn,
        isp,
        country: typeof payload.country === "string" ? payload.country : undefined,
        hosting: Boolean(payload.privacy?.hosting),
        vpn: Boolean(payload.privacy?.vpn),
        proxy: Boolean(payload.privacy?.proxy),
        tor: Boolean(payload.privacy?.tor),
      },
    };
  } catch (err) {
    return {
      provider: "ipinfo",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
