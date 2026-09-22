import type { NetworkResult, ReputationResult } from "../types.js";
import { fetchAbuseIpDb } from "./abuseipdb.js";
import { ReputationCache } from "./cache.js";
import { fetchIpinfo } from "./ipinfo.js";
import { fetchIpqs } from "./ipqs.js";
import { ProviderRateLimiter } from "./limiter.js";
import type {
  AggregatedReputationResult,
  RawProviderReport,
  ReputationOptions,
} from "./provider.js";

const sharedCache = new ReputationCache();
const customCaches = new Map<string, ReputationCache>();
const sharedLimiter = new ProviderRateLimiter();
function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

interface CachedReputationData {
  reputation: ReputationResult & {
    privacySignals?: string[];
    maliciousSignals?: string[];
  };
  network: Partial<NetworkResult>;
  rawReports: RawProviderReport[];
}

export async function fetchReputationSignals(
  ip: string,
  options: ReputationOptions = {}
): Promise<AggregatedReputationResult> {
  const hasCustomTtl = options.cacheTtlAsnMs !== undefined || options.cacheTtlReputationMs !== undefined;
  const ttlKey = `${options.cacheTtlAsnMs ?? 24 * 60 * 60 * 1_000}:${options.cacheTtlReputationMs ?? 6 * 60 * 60 * 1_000}`;
  let cache: ReputationCache;
  if (options.cachePath) {
    cache = new ReputationCache({
      filePath: options.cachePath,
      asnTtlMs: options.cacheTtlAsnMs,
      reputationTtlMs: options.cacheTtlReputationMs,
      now: options.now,
    });
  } else if (hasCustomTtl) {
    cache = customCaches.get(ttlKey) ?? new ReputationCache({
      asnTtlMs: options.cacheTtlAsnMs,
      reputationTtlMs: options.cacheTtlReputationMs,
      now: options.now,
    });
    customCaches.set(ttlKey, cache);
  } else {
    cache = sharedCache;
  }

  const cachedAsn = await cache.get<{ asn?: string; org?: string }>(ip, "asn");
  const cachedReputation = await cache.get<CachedReputationData>(ip, "reputation");

  if (cachedAsn && cachedReputation && Array.isArray(cachedReputation.rawReports)) {
    const fullNetwork: NetworkResult = {
      ...(cachedReputation.network ?? {}),
      asn: cachedAsn.asn,
      organization: cachedAsn.org ?? cachedReputation.network?.organization,
    };
    return {
      network: fullNetwork,
      reputation: cachedReputation.reputation,
      raw: cachedReputation.rawReports.map((report) => ({ ...report, cached: true })),
    };
  }

  const limiter = sharedLimiter;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetch ?? fetch;

  const [ipinfoReport, ipqsReport, abuseReport] = await Promise.all([
    (async () => {
      await limiter.acquire("ipinfo");
      return fetchIpinfo(ip, {
        apiKey: options.apiKeys?.ipinfo,
        endpoint: options.endpoints?.ipinfo,
        timeoutMs,
        fetch: fetchImpl,
      });
    })(),
    (async () => {
      await limiter.acquire("ipqs");
      return fetchIpqs(ip, {
        apiKey: options.apiKeys?.ipqs,
        endpoint: options.endpoints?.ipqs,
        timeoutMs,
        fetch: fetchImpl,
      });
    })(),
    (async () => {
      await limiter.acquire("abuseipdb");
      return fetchAbuseIpDb(ip, {
        apiKey: options.apiKeys?.abuseipdb,
        endpoint: options.endpoints?.abuseipdb,
        timeoutMs,
        fetch: fetchImpl,
      });
    })(),
  ]);

  const rawReports: RawProviderReport[] = [ipinfoReport, ipqsReport, abuseReport];
  const ipinfoData = ipinfoReport.status === "ok" ? ipinfoReport.data : undefined;
  const ipqsData = ipqsReport.status === "ok" ? ipqsReport.data : undefined;
  const abuseData = abuseReport.status === "ok" ? abuseReport.data : undefined;

  let networkAsn = ipinfoData?.asn || ipqsData?.asn;
  let networkOrg = ipinfoData?.isp || ipqsData?.isp;

  if (networkAsn) {
    await cache.set(ip, "asn", { asn: networkAsn, org: networkOrg });
  } else if (cachedAsn?.asn) {
    networkAsn = cachedAsn.asn;
    networkOrg = cachedAsn.org ?? networkOrg;
  }

  const network: NetworkResult = {};
  if (networkAsn) network.asn = networkAsn;
  if (networkOrg) network.organization = networkOrg;
  if (ipinfoData?.hosting) network.isDatacenter = true;
  if (ipinfoData?.vpn || ipqsData?.vpn) network.isVpn = true;
  if (ipinfoData?.proxy || ipqsData?.proxy) network.isProxy = true;
  if (ipinfoData?.tor || ipqsData?.tor) network.isTor = true;

  const privacySignals: string[] = [];
  if (network.isVpn) privacySignals.push("vpn");
  if (network.isProxy) privacySignals.push("proxy");
  if (network.isTor) privacySignals.push("tor");
  if (network.isDatacenter) privacySignals.push("hosting");

  const maliciousSignals: string[] = [];
  const validScores: number[] = [];

  if (typeof ipqsData?.fraudScore === "number") {
    validScores.push(ipqsData.fraudScore);
    if (ipqsData.fraudScore >= 75) {
      maliciousSignals.push(`high_fraud_score_${ipqsData.fraudScore}`);
    }
  }

  if (typeof abuseData?.abuseConfidenceScore === "number") {
    validScores.push(abuseData.abuseConfidenceScore);
    if (abuseData.abuseConfidenceScore >= 25) {
      maliciousSignals.push(`abuse_confidence_${abuseData.abuseConfidenceScore}`);
    }
  }

  let finalScore: number | null = null;
  if (validScores.length >= 2) {
    finalScore = roundTwo(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  }

  const reputation: ReputationResult & {
    privacySignals?: string[];
    maliciousSignals?: string[];
  } = {
    score: finalScore,
    fraudScore: ipqsData?.fraudScore,
    spamScore: abuseData?.abuseConfidenceScore,
    blacklists: abuseData?.totalReports
      ? [{ name: "AbuseIPDB", listed: abuseData.totalReports > 0, details: `${abuseData.totalReports} reports` }]
      : undefined,
    privacySignals,
    maliciousSignals,
  };

  if (rawReports.every((report) => report.status === "ok")) {
    await cache.set(ip, "reputation", {
      reputation,
      network: {
        isDatacenter: network.isDatacenter,
        isVpn: network.isVpn,
        isProxy: network.isProxy,
        isTor: network.isTor,
        organization: network.organization,
      },
      rawReports,
    });
  }

  return { network, reputation, raw: rawReports };
}
