import type { ProviderContext, RawProviderReport } from "./provider.js";

export interface AbuseIpDbData {
  abuseConfidenceScore?: number;
  totalReports?: number;
}

export async function fetchAbuseIpDb(
  ip: string,
  context: ProviderContext = {}
): Promise<RawProviderReport<AbuseIpDbData>> {
  if (!context.apiKey) {
    return { provider: "abuseipdb", status: "unavailable" };
  }

  const endpoint = (context.endpoint ?? "https://api.abuseipdb.com/api/v2").replace(/\/$/, "");
  const url = `${endpoint}/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90&verbose`;
  const fetchImpl = context.fetch ?? fetch;

  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        Key: context.apiKey,
      },
      signal: AbortSignal.timeout(context.timeoutMs ?? 5000),
    });

    if (!res.ok) {
      return {
        provider: "abuseipdb",
        status: res.status === 429 ? "unavailable" : "error",
        statusCode: res.status,
        error: res.status === 429 ? "Quota exceeded (HTTP 429)" : `HTTP ${res.status}`,
      };
    }

    const payload = (await res.json()) as {
      data?: {
        abuseConfidenceScore?: number;
        totalReports?: number;
      };
    };

    return {
      provider: "abuseipdb",
      status: "ok",
      statusCode: res.status,
      data: {
        abuseConfidenceScore:
          typeof payload.data?.abuseConfidenceScore === "number"
            ? payload.data.abuseConfidenceScore
            : undefined,
        totalReports:
          typeof payload.data?.totalReports === "number"
            ? payload.data.totalReports
            : undefined,
      },
    };
  } catch (err) {
    return {
      provider: "abuseipdb",
      status: "error",
      error: "Network request failed for abuseipdb",
    };
  }
}
