import type { ProviderContext, RawProviderReport } from "./provider.js";

export interface IpqsData {
  asn?: string;
  isp?: string;
  fraudScore?: number;
  vpn?: boolean;
  proxy?: boolean;
  tor?: boolean;
}

export async function fetchIpqs(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<IpqsData>> {
  if (!context.apiKey) {
    return { provider: "ipqs", status: "unavailable" };
  }

  const endpoint = (context.endpoint ?? "https://ipqualityscore.com/api/json/ip").replace(/\/$/, "");
  const url = `${endpoint}/${encodeURIComponent(context.apiKey)}/${encodeURIComponent(ip)}?strictness=1`;
  const fetchImpl = context.fetch ?? fetch;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(context.timeoutMs ?? 5000),
    });

    if (!res.ok) {
      return {
        provider: "ipqs",
        status: "error",
        statusCode: res.status,
        error: `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as {
      success?: boolean;
      fraud_score?: number;
      vpn?: boolean;
      proxy?: boolean;
      tor?: boolean;
      ISP?: string;
      ASN?: number | string;
      message?: string;
    };

    if (payload.success === false) {
      return {
        provider: "ipqs",
        status: "error",
        statusCode: res.status,
        error: payload.message || "IPQS request was not successful",
      };
    }

    let asn: string | undefined;
    if (payload.ASN !== undefined && payload.ASN !== null) {
      asn = String(payload.ASN).startsWith("AS")
        ? String(payload.ASN)
        : `AS${String(payload.ASN)}`;
    }

    return {
      provider: "ipqs",
      status: "ok",
      statusCode: res.status,
      data: {
        asn,
        isp: typeof payload.ISP === "string" ? payload.ISP : undefined,
        fraudScore: typeof payload.fraud_score === "number" ? payload.fraud_score : undefined,
        vpn: Boolean(payload.vpn),
        proxy: Boolean(payload.proxy),
        tor: Boolean(payload.tor),
      },
    };
  } catch (err) {
    return {
      provider: "ipqs",
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
