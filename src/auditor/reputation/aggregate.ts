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
  const acquireOpts = {
    signal: options.signal,
    deadlineMs: options.deadlineMs,
  };

  const [ipinfoReport, ipqsReport, abuseReport] = await Promise.all([
    (async () => {
      await limiter.acquire("ipinfo", acquireOpts);
      return fetchIpinfo(ip, {
        apiKey: options.apiKeys?.ipinfo,
        endpoint: options.endpoints?.ipinfo,
        timeoutMs,
        fetch: fetchImpl,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        now: options.now,
      });
    })(),
    (async () => {
      await limiter.acquire("ipqs", acquireOpts);
      return fetchIpqs(ip, {
        apiKey: options.apiKeys?.ipqs,
        endpoint: options.endpoints?.ipqs,
        timeoutMs,
        fetch: fetchImpl,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        now: options.now,
      });
    })(),
    (async () => {
      await limiter.acquire("abuseipdb", acquireOpts);
      return fetchAbuseIpDb(ip, {
        apiKey: options.apiKeys?.abuseipdb,
        endpoint: options.endpoints?.abuseipdb,
        timeoutMs,
        fetch: fetchImpl,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        now: options.now,
      });
    })(),
  ]);

  const rawReports: RawProviderReport[] = [ipinfoReport, ipqsReport, abuseReport];
  const ipinfoData = ipinfoReport.status === "success" ? ipinfoReport.data : undefined;
  const ipqsData = ipqsReport.status === "success" ? ipqsReport.data : undefined;
  const abuseData = abuseReport.status === "success" ? abuseReport.data : undefined;

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
  if (ipinfoData?.country) network.country = ipinfoData.country;
  if (ipinfoData?.region) network.region = ipinfoData.region;
  if (ipinfoData?.city) network.city = ipinfoData.city;

  if (typeof ipinfoData?.hosting === "boolean") network.isDatacenter = ipinfoData.hosting;
  if (typeof ipinfoData?.vpn === "boolean" || typeof ipqsData?.vpn === "boolean") {
    network.isVpn = Boolean(ipinfoData?.vpn || ipqsData?.vpn);
  }
  if (typeof ipinfoData?.proxy === "boolean" || typeof ipqsData?.proxy === "boolean") {
    network.isProxy = Boolean(ipinfoData?.proxy || ipqsData?.proxy);
  }
  if (typeof ipinfoData?.tor === "boolean" || typeof ipqsData?.tor === "boolean") {
    network.isTor = Boolean(ipinfoData?.tor || ipqsData?.tor);
  }
  if (typeof ipinfoData?.mobile === "boolean") {
    network.isMobile = ipinfoData.mobile;
  }
  if (typeof ipinfoData?.residential === "boolean") {
    network.isResidential = ipinfoData.residential;
  }

  const explicitTypes: string[] = [];
  if (network.isMobile) explicitTypes.push("mobile");
  if (network.isResidential) explicitTypes.push("residential");
  if (network.isDatacenter) explicitTypes.push("datacenter");
  network.type = explicitTypes.length === 1 ? explicitTypes[0] : "unknown";

  const privacySignals: string[] = [];
  if (network.isVpn) privacySignals.push("vpn");
  if (network.isProxy) privacySignals.push("proxy");
  if (network.isTor) privacySignals.push("tor");
  if (ipinfoData?.relay) privacySignals.push("relay");
  if (network.isDatacenter) privacySignals.push("hosting");

  const maliciousSignals: string[] = [];
  const validScores: number[] = [];

  if (typeof ipqsData?.fraudScore === "number") {
    validScores.push(ipqsData.fraudScore);
    if (ipqsData.fraudScore >= 75) {
      maliciousSignals.push(`high_fraud_score_${ipqsData.fraudScore}`);
    }
  }

  if (ipqsData?.recentAbuse) maliciousSignals.push("recent_abuse");
  if (ipqsData?.frequentAbuser) maliciousSignals.push("frequent_abuser");
  if (ipqsData?.bot) maliciousSignals.push("bot_activity");

  if (typeof abuseData?.abuseConfidenceScore === "number") {
    validScores.push(abuseData.abuseConfidenceScore);
    if (abuseData.abuseConfidenceScore >= 25) {
      maliciousSignals.push(`abuse_confidence_${abuseData.abuseConfidenceScore}`);
    }
  }

  if (abuseData?.totalReports && abuseData.totalReports >= 5) {
    maliciousSignals.push(`high_abuse_reports_${abuseData.totalReports}`);
  }

  let finalScore: number | null = null;
  if (validScores.length >= 2) {
    finalScore = roundTwo(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  }

  const blacklists = abuseData?.totalReports !== undefined
    ? [{ name: "AbuseIPDB", listed: abuseData.totalReports > 0, details: `${abuseData.totalReports} reports` }]
    : undefined;

  const reputation: ReputationResult & {
    privacySignals?: string[];
    maliciousSignals?: string[];
  } = {
    score: finalScore,
    fraudScore: ipqsData?.fraudScore,
    spamScore: abuseData?.abuseConfidenceScore,
    blacklists,
    privacySignals,
    maliciousSignals,
  };

  if (rawReports.every((report) => report.status === "success")) {
    await cache.set(ip, "reputation", {
      reputation,
      network: {
        isDatacenter: network.isDatacenter,
        isVpn: network.isVpn,
        isProxy: network.isProxy,
        isTor: network.isTor,
        isMobile: network.isMobile,
        isResidential: network.isResidential,
        type: network.type,
        country: network.country,
        region: network.region,
        city: network.city,
        organization: network.organization,
      },
      rawReports,
    });
  }

  return { network, reputation, raw: rawReports };
}
