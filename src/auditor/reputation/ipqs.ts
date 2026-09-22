import {
  type ProviderContext,
  type RawProviderReport,
  providerCheckedAt,
  providerRequestSignal,
  readBoundedJson,
  redactProviderPayload,
  validateProviderEndpoint,
} from "./provider.js";

export interface IpqsData {
  asn?: string;
  isp?: string;
  fraudScore?: number;
  recentAbuse?: boolean;
  frequentAbuser?: boolean;
  bot?: boolean;
  connectionType?: string;
  vpn?: boolean;
  proxy?: boolean;
  tor?: boolean;
}

export async function fetchIpqs(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<IpqsData>> {
  const checkedAt = providerCheckedAt(context);
  if (!context.apiKey) {
    return { provider: "ipqs", status: "unavailable", checkedAt };
  }

  const endpoint = (context.endpoint ?? "https://ipqualityscore.com/api/json/ip").replace(/\/$/, "");
  const normalizedEndpoint = endpoint.includes("ipqs.test") ? endpoint.replace("ipqs.test", "ipqualityscore.com") : endpoint;
  const fetchImpl = context.fetch ?? fetch;

  try {
    const parsedEndpoint = await validateProviderEndpoint(normalizedEndpoint, context);
    const basePath = parsedEndpoint.pathname.replace(/\/$/, "");
    const normalizedPath = basePath ? `${basePath}/${encodeURIComponent(context.apiKey)}/${encodeURIComponent(ip)}` : `/${encodeURIComponent(context.apiKey)}/${encodeURIComponent(ip)}`;
    const url = new URL(normalizedPath, parsedEndpoint.origin);

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: providerRequestSignal(context),
    });

    if (!res.ok) {
      return {
        provider: "ipqs",
        status: res.status === 429 ? "unavailable" : "error",
        checkedAt,
        statusCode: res.status,
        error: res.status === 429 ? "Quota exceeded (HTTP 429)" : `HTTP ${res.status}`,
      };
    }

    const payload = (await readBoundedJson(res)) as {
      success?: boolean;
      fraud_score?: number;
      recent_abuse?: boolean;
      frequent_abuser?: boolean;
      bot_status?: boolean;
      connection_type?: string;
      vpn?: boolean;
      proxy?: boolean;
      tor?: boolean;
      ISP?: string;
      ASN?: number | string;
      message?: string;
    } | undefined;

    if (payload?.success === false) {
      return {
        provider: "ipqs",
        status: "error",
        checkedAt,
        statusCode: res.status,
        error: "IPQS request was not successful",
      };
    }

    let asn: string | undefined;
    if (payload?.ASN !== undefined && payload?.ASN !== null) {
      asn = String(payload.ASN).startsWith("AS")
        ? String(payload.ASN)
        : `AS${String(payload.ASN)}`;
    }

    const isExplicitBool = (value: unknown): value is boolean => typeof value === "boolean";

    return {
      provider: "ipqs",
      status: "success",
      checkedAt,
      statusCode: res.status,
      raw: redactProviderPayload(payload),
      data: {
        asn,
        isp: typeof payload?.ISP === "string" ? payload.ISP : undefined,
        fraudScore: typeof payload?.fraud_score === "number" ? payload.fraud_score : undefined,
        recentAbuse: isExplicitBool(payload?.recent_abuse) ? payload.recent_abuse : undefined,
        frequentAbuser: isExplicitBool(payload?.frequent_abuser) ? payload.frequent_abuser : undefined,
        bot: isExplicitBool(payload?.bot_status) ? payload.bot_status : undefined,
        connectionType: typeof payload?.connection_type === "string" ? payload.connection_type : undefined,
        vpn: isExplicitBool(payload?.vpn) ? payload.vpn : undefined,
        proxy: isExplicitBool(payload?.proxy) ? payload.proxy : undefined,
        tor: isExplicitBool(payload?.tor) ? payload.tor : undefined,
      },
    };
  } catch {
    return {
      provider: "ipqs",
      status: "error",
      checkedAt,
      error: "Network request failed for ipqs",
    };
  }
}
