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
const sharedLimiter = new ProviderRateLimiter();

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

export async function fetchReputationSignals(
  ip: string,
  options: ReputationOptions = {}
): Promise<AggregatedReputationResult> {
  const cache = options.cachePath
    ? new ReputationCache({
        filePath: options.cachePath,
        asnTtlMs: options.cacheTtlAsnMs,
        reputationTtlMs: options.cacheTtlReputationMs,
      })
    : sharedCache;

  const limiter = sharedLimiter;
  const timeoutMs = options.timeoutMs ?? 5000;
  const fetchImpl = options.fetch ?? fetch;

  const rawReports: RawProviderReport[] = [];

  // IPinfo
  await limiter.acquire("ipinfo");
  const ipinfoReport = await fetchIpinfo(ip, {
    apiKey: options.apiKeys?.ipinfo,
    endpoint: options.endpoints?.ipinfo,
    timeoutMs,
    fetch: fetchImpl,
  });
  rawReports.push(ipinfoReport);

  // IPQS
  await limiter.acquire("ipqs");
  const ipqsReport = await fetchIpqs(ip, {
    apiKey: options.apiKeys?.ipqs,
    endpoint: options.endpoints?.ipqs,
    timeoutMs,
    fetch: fetchImpl,
  });
  rawReports.push(ipqsReport);

  // AbuseIPDB
  await limiter.acquire("abuseipdb");
  const abuseReport = await fetchAbuseIpDb(ip, {
    apiKey: options.apiKeys?.abuseipdb,
    endpoint: options.endpoints?.abuseipdb,
    timeoutMs,
    fetch: fetchImpl,
  });
  rawReports.push(abuseReport);

  const ipinfoData = ipinfoReport.status === "ok" ? ipinfoReport.data : undefined;
  const ipqsData = ipqsReport.status === "ok" ? ipqsReport.data : undefined;
  const abuseData = abuseReport.status === "ok" ? abuseReport.data : undefined;

  // Cache resolution / population for ASN
  let networkAsn = ipinfoData?.asn || ipqsData?.asn;
  let networkOrg = ipinfoData?.isp || ipqsData?.isp;

  if (networkAsn) {
    await cache.set(ip, "asn", { asn: networkAsn, org: networkOrg });
  } else {
    const cachedAsn = await cache.get<{ asn?: string; org?: string }>(ip, "asn");
    if (cachedAsn?.asn) {
      networkAsn = cachedAsn.asn;
      networkOrg = cachedAsn.org ?? networkOrg;
    }
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
  if (validScores.length > 0) {
    finalScore = roundTwo(validScores.reduce((a, b) => a + b, 0) / validScores.length);
  } else {
    const cachedReputation = await cache.get<{ score?: number }>(ip, "reputation");
    if (typeof cachedReputation?.score === "number") {
      finalScore = cachedReputation.score;
    }
  }

  if (finalScore !== null) {
    await cache.set(ip, "reputation", { score: finalScore });
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

  return { network, reputation, raw: rawReports };
}
