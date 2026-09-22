import {
  type ProviderContext,
  type RawProviderReport,
  providerCheckedAt,
  providerRequestSignal,
  readBoundedJson,
  redactProviderPayload,
  validateProviderEndpoint,
} from "./provider.js";

export interface IpinfoData {
  asn?: string;
  isp?: string;
  name?: string;
  country?: string;
  region?: string;
  city?: string;
  hosting?: boolean;
  vpn?: boolean;
  proxy?: boolean;
  tor?: boolean;
  relay?: boolean;
  mobile?: boolean;
  residential?: boolean;
}

export async function fetchIpinfo(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<IpinfoData>> {
  const checkedAt = providerCheckedAt(context);
  if (!context.apiKey) {
    return { provider: "ipinfo", status: "unavailable", checkedAt };
  }

  const endpoint = (context.endpoint ?? "https://ipinfo.io").replace(/\/$/, "");
  const fetchImpl = context.fetch ?? fetch;

  try {
    const parsedEndpoint = await validateProviderEndpoint(endpoint, context);
    const url = new URL(`${parsedEndpoint.pathname.replace(/\/$/, "")}/${encodeURIComponent(ip)}/json`, parsedEndpoint.origin);
    url.searchParams.set("token", context.apiKey);

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: providerRequestSignal(context),
    });

    if (!res.ok) {
      return {
        provider: "ipinfo",
        status: res.status === 429 ? "unavailable" : "error",
        checkedAt,
        statusCode: res.status,
        error: res.status === 429 ? "Quota exceeded (HTTP 429)" : `HTTP ${res.status}`,
      };
    }

    const payload = (await readBoundedJson(res)) as {
      asn?: { asn?: string; name?: string; type?: string };
      org?: string;
      country?: string;
      region?: string;
      city?: string;
      privacy?: {
        hosting?: boolean;
        vpn?: boolean;
        proxy?: boolean;
        tor?: boolean;
        relay?: boolean;
        service?: string;
      };
      carrier?: unknown;
      mobile?: boolean;
      company?: { type?: string };
    } | undefined;

    let asn = typeof payload?.asn?.asn === "string" ? payload.asn.asn.toUpperCase() : undefined;
    let isp = typeof payload?.asn?.name === "string" ? payload.asn.name : undefined;

    if (!asn && typeof payload?.org === "string") {
      const match = payload.org.match(/^(AS\d+)\s*(.*)$/i);
      if (match) {
        asn = match[1]?.toUpperCase();
        isp = match[2]?.trim() || undefined;
      } else {
        isp = payload.org.trim();
      }
    }

    const privacy = payload?.privacy;
    const isExplicitBool = (value: unknown): value is boolean => typeof value === "boolean";
    const explicitResidential = payload?.company?.type === "isp"
      ? true
      : payload?.company?.type === "business"
        ? false
        : undefined;

    return {
      provider: "ipinfo",
      status: "success",
      checkedAt,
      statusCode: res.status,
      raw: redactProviderPayload(payload),
      data: {
        asn,
        isp,
        name: isp,
        country: typeof payload?.country === "string" ? payload.country : undefined,
        region: typeof payload?.region === "string" ? payload.region : undefined,
        city: typeof payload?.city === "string" ? payload.city : undefined,
        hosting: isExplicitBool(privacy?.hosting) ? privacy.hosting : undefined,
        vpn: isExplicitBool(privacy?.vpn) ? privacy.vpn : undefined,
        proxy: isExplicitBool(privacy?.proxy) ? privacy.proxy : undefined,
        tor: isExplicitBool(privacy?.tor) ? privacy.tor : undefined,
        relay: isExplicitBool(privacy?.relay) ? privacy.relay : undefined,
        mobile: isExplicitBool(payload?.mobile) ? payload.mobile : payload?.carrier ? true : undefined,
        residential: explicitResidential,
      },
    };
  } catch (err) {
    return {
      provider: "ipinfo",
      status: "error",
      checkedAt,
      error: "Network request failed for ipinfo",
    };
  }
}
