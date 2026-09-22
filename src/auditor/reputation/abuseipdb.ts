import {
  type ProviderContext,
  type RawProviderReport,
  providerCheckedAt,
  providerRequestSignal,
  readBoundedJson,
  redactProviderPayload,
  validateProviderEndpoint,
} from "./provider.js";

export interface AbuseIpDbData {
  abuseConfidenceScore?: number;
  totalReports?: number;
  numDistinctUsers?: number;
  lastReportedAt?: string;
  usageType?: string;
  domain?: string;
}

export async function fetchAbuseIpDb(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<AbuseIpDbData>> {
  const checkedAt = providerCheckedAt(context);
  if (!context.apiKey) {
    return { provider: "abuseipdb", status: "unavailable", checkedAt };
  }

  const endpoint = (context.endpoint ?? "https://api.abuseipdb.com/api/v2").replace(/\/$/, "");
  const fetchImpl = context.fetch ?? fetch;

  try {
    const parsedEndpoint = await validateProviderEndpoint(endpoint, context);
    const basePath = parsedEndpoint.pathname.replace(/\/$/, "");
    const url = new URL(`${basePath}/check`, parsedEndpoint.origin);
    url.searchParams.set("ipAddress", ip);
    url.searchParams.set("maxAgeInDays", "90");
    url.searchParams.set("verbose", "");

    const res = await fetchImpl(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        Key: context.apiKey,
      },
      redirect: "error",
      signal: providerRequestSignal(context),
    });

    if (!res.ok) {
      return {
        provider: "abuseipdb",
        status: res.status === 429 ? "unavailable" : "error",
        checkedAt,
        statusCode: res.status,
        error: res.status === 429 ? "Quota exceeded (HTTP 429)" : `HTTP ${res.status}`,
      };
    }

    const payload = (await readBoundedJson(res)) as {
      data?: {
        abuseConfidenceScore?: number;
        totalReports?: number;
        numDistinctUsers?: number;
        lastReportedAt?: string;
        usageType?: string;
        domain?: string;
      };
    } | undefined;

    return {
      provider: "abuseipdb",
      status: "success",
      checkedAt,
      statusCode: res.status,
      raw: redactProviderPayload(payload),
      data: {
        abuseConfidenceScore:
          typeof payload?.data?.abuseConfidenceScore === "number"
            ? payload.data.abuseConfidenceScore
            : undefined,
        totalReports:
          typeof payload?.data?.totalReports === "number"
            ? payload.data.totalReports
            : undefined,
        numDistinctUsers:
          typeof payload?.data?.numDistinctUsers === "number"
            ? payload.data.numDistinctUsers
            : undefined,
        lastReportedAt:
          typeof payload?.data?.lastReportedAt === "string"
            ? payload.data.lastReportedAt
            : undefined,
        usageType:
          typeof payload?.data?.usageType === "string"
            ? payload.data.usageType
            : undefined,
        domain:
          typeof payload?.data?.domain === "string"
            ? payload.data.domain
            : undefined,
      },
    };
  } catch {
    return {
      provider: "abuseipdb",
      status: "error",
      checkedAt,
      error: "Network request failed for abuseipdb",
    };
  }
}
