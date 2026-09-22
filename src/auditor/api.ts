import { parseProxyInput } from "./parser.js";
import { validateTargetHost } from "./security/ssrf.js";
import {
  probeContentIntegrity,
  probeDnsBehavior,
  probeDirectBaseline,
  probeExitIp,
  probeHeaderLeak,
  probeStabilityAndRotation,
  probeTlsIntegrity,
} from "./probes/index.js";
import { fetchReputationSignals } from "./reputation/index.js";
import { calculateScores } from "./scoring/scores.js";
import { determineVerdict } from "./scoring/verdict.js";
import type {
  AuditEvidence,
} from "./scoring/scores.js";
import type {
  AuditMetadata,
  ParsedProxyInput,
  ProxyAuditResult,
  ProxyInput,
  RedactedProxyInfo,
} from "./types.js";
import type { ProxyAuditOptions } from "./index.js";

const DEFAULT_ENDPOINTS = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
];

const DEFAULT_HEADER_ENDPOINT = "https://httpbin.org/anything";

function safeRedactedProxy(input: ProxyInput): { parsed?: ParsedProxyInput; redacted: RedactedProxyInfo; parseError?: string } {
  try {
    const { parsed, redacted } = parseProxyInput(input);
    return { parsed, redacted };
  } catch (err) {
    return {
      redacted: {
        protocol: "http",
        host: "unknown",
        port: 0,
        username: undefined,
        password: undefined,
      },
      parseError: err instanceof Error ? err.message : "Malformed proxy input",
    };
  }
}

function buildMetadata(startedAt: string, startTime: number): AuditMetadata {
  const completedAt = new Date().toISOString();
  return {
    startedAt,
    completedAt,
    durationMs: Math.max(0, Date.now() - startTime),
    version: "1.0.0",
    toolVersion: "1.0.0",
    schemaVersion: "1.0.0",
  };
}

export async function checkProxy(
  input: ProxyInput,
  options: ProxyAuditOptions = {}
): Promise<ProxyAuditResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const totalTimeoutMs = options.timeoutMs ?? 15_000;
  const deadline = startTime + totalTimeoutMs;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Global audit deadline exceeded")), totalTimeoutMs);

  const onCallerAbort = () => controller.abort(options.signal?.reason || new Error("Audit aborted by caller"));
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
    } else {
      options.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  const remainingMs = () => Math.max(0, deadline - Date.now());

  const { parsed, redacted, parseError } = safeRedactedProxy(input);

  if (!parsed || parseError) {
    clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
    const evidence: AuditEvidence = {
      security: {
        inputValidation: { valid: false, reason: parseError },
        ssrfProtection: { passed: false, resolvedIps: [], reason: "Input parsing failed" },
      },
      connectivity: { reachable: false, error: parseError },
    };
    const scores = calculateScores(evidence);
    const verdict = determineVerdict(evidence, scores);
    return {
      proxy: redacted,
      verdict: "FAIL",
      scores,
      security: evidence.security,
      connectivity: evidence.connectivity,
      riskFactors: verdict.riskFactors,
      recommendations: verdict.recommendations,
      metadata: buildMetadata(startedAt, startTime),
    };
  }

  // Strict SSRF validation before opening any proxy socket
  const ssrf = await validateTargetHost(parsed.host, {
    allowPrivateTargets: options.allowPrivateTargets ?? false,
    timeoutMs: Math.min(3_000, remainingMs() || 1),
  });

  if (!ssrf.valid) {
    clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
    const evidence: AuditEvidence = {
      security: {
        inputValidation: { valid: true },
        ssrfProtection: {
          passed: false,
          resolvedIps: ssrf.resolvedIps,
          reason: ssrf.reason,
          allowPrivateTargets: options.allowPrivateTargets,
        },
      },
      connectivity: { reachable: false, error: ssrf.reason },
    };
    const scores = calculateScores(evidence);
    const verdict = determineVerdict(evidence, scores);
    return {
      proxy: redacted,
      verdict: "FAIL",
      scores,
      security: evidence.security,
      connectivity: evidence.connectivity,
      riskFactors: verdict.riskFactors,
      recommendations: verdict.recommendations,
      metadata: buildMetadata(startedAt, startTime),
    };
  }

  const evidence: AuditEvidence = {
    security: {
      inputValidation: { valid: true },
      ssrfProtection: {
        passed: true,
        resolvedIps: ssrf.resolvedIps,
        allowPrivateTargets: options.allowPrivateTargets,
      },
    },
  };

  const configuredEndpoints: string[] = options.endpoints && options.endpoints.length > 0
    ? Array.from(options.endpoints)
    : Array.from(DEFAULT_ENDPOINTS);
  const headerEndpoint = options.headerEndpoint || DEFAULT_HEADER_ENDPOINT;
  const tlsEndpoint = options.tlsEndpoint || configuredEndpoints[0]!;

  let rawReputationReports: unknown[] | undefined;

  try {
    // 1. Exit IP and basic connectivity probe
    if (remainingMs() <= 0 || controller.signal.aborted) throw new Error("Audit timeout exceeded");
    const exitIpResult = await probeExitIp(parsed, {
      endpoints: configuredEndpoints,
      timeoutMs: Math.min(5_000, remainingMs()),
      allowPrivateTargets: options.allowPrivateTargets,
      ca: options.ca,
      signal: controller.signal,
    });
    evidence.exitIp = exitIpResult;
    const reachable = Boolean(exitIpResult.ip || exitIpResult.observations.some((o) => !o.error));
    evidence.connectivity = {
      reachable,
      error: reachable ? undefined : exitIpResult.observations[0]?.error || "Connection failed",
    };
    if (!reachable) {
      if (remainingMs() > 50 && tlsEndpoint.startsWith("https:") && !controller.signal.aborted) {
        evidence.tls = await probeTlsIntegrity(parsed, {
          endpoint: tlsEndpoint,
          timeoutMs: Math.min(4_000, remainingMs()),
          allowPrivateTargets: options.allowPrivateTargets,
          expectedSpkiSha256: options.tlsEndpoint ? options.controlSpkiSha256 : undefined,
          ca: options.ca,
          signal: controller.signal,
        });
      }
      const scores = calculateScores(evidence);
      const verdict = determineVerdict(evidence, scores);
      return {
        proxy: redacted,
        verdict: "FAIL",
        scores,
        security: evidence.security,
        connectivity: evidence.connectivity,
        exitIp: evidence.exitIp,
        tls: evidence.tls,
        riskFactors: verdict.riskFactors,
        recommendations: verdict.recommendations,
        metadata: buildMetadata(startedAt, startTime),
      };
    }

    // 2. Direct baseline probe (optional, enabled by default)
    const baselineIps: string[] = [];
    if (options.baseline !== false && remainingMs() > 50 && !controller.signal.aborted) {
      const baselineRes = await probeDirectBaseline({
        endpoint: configuredEndpoints[0],
        timeoutMs: Math.min(3_000, remainingMs()),
        allowPrivateTargets: options.allowPrivateTargets,
        ca: options.ca,
        signal: controller.signal,
      });
      evidence.baseline = baselineRes;
      if (baselineRes.ip) baselineIps.push(baselineRes.ip);
    }

    // 3. Header origin leak probe
    if (remainingMs() > 50 && !controller.signal.aborted) {
      evidence.headerLeak = await probeHeaderLeak(parsed, baselineIps, {
        endpoint: headerEndpoint,
        timeoutMs: Math.min(4_000, remainingMs()),
        allowPrivateTargets: options.allowPrivateTargets,
        ca: options.ca,
        signal: controller.signal,
      });
    }

    // 4. TLS Integrity probe
    if (remainingMs() > 50 && tlsEndpoint.startsWith("https:") && !controller.signal.aborted) {
      evidence.tls = await probeTlsIntegrity(parsed, {
        endpoint: tlsEndpoint,
        timeoutMs: Math.min(4_000, remainingMs()),
        allowPrivateTargets: options.allowPrivateTargets,
        expectedSpkiSha256: options.tlsEndpoint ? options.controlSpkiSha256 : undefined,
        ca: options.ca,
        signal: controller.signal,
      });
    }

    // 5. Controlled content integrity probe (if controlEndpoint configured)
    if (remainingMs() > 50 && options.controlEndpoint && options.controlEndpoint.startsWith("https:") && !controller.signal.aborted) {
      evidence.contentIntegrity = await probeContentIntegrity(parsed, {
        endpoint: options.controlEndpoint,
        expectedBody: options.controlExpectedBody,
        expectedSpkiSha256: options.controlSpkiSha256,
        expectedHmacSha256: options.controlHmacKey ? { secret: options.controlHmacKey } : undefined,
        timeoutMs: Math.min(4_000, remainingMs()),
        allowPrivateTargets: options.allowPrivateTargets,
        ca: options.ca,
        signal: controller.signal,
      });
    }

    // 6. DNS Assessment
    if (remainingMs() > 50 && !controller.signal.aborted) {
      const targetHost = new URL(configuredEndpoints[0]!).hostname;
      evidence.dns = await probeDnsBehavior(parsed, {
        targetDomain: targetHost,
        timeoutMs: Math.min(2_000, remainingMs()),
      });
    }

    // 7. Stability & Rotation (exactly 5 requests across configured primary endpoint)
    if (remainingMs() > 50 && !controller.signal.aborted) {
      const attempts = options.attempts ?? 5;
      const stabRes = await probeStabilityAndRotation(parsed, attempts, {
        endpoint: configuredEndpoints[0],
        timeoutMs: Math.min(5_000, Math.floor(remainingMs() / attempts)),
        allowPrivateTargets: options.allowPrivateTargets,
        ca: options.ca,
        signal: controller.signal,
      });
      evidence.stability = stabRes.stability;
      evidence.rotation = stabRes.rotation;
    }

    // 8. Reputation & Network Classification (if enabled, default true)
    if (options.reputation !== false && evidence.exitIp?.ip && remainingMs() > 50 && !controller.signal.aborted) {
      const repKeys = {
        ipinfo: options.providerKeys?.ipinfo ?? process.env.IPINFO_TOKEN,
        ipqs: options.providerKeys?.ipqs ?? process.env.IPQS_API_KEY,
        abuseipdb: options.providerKeys?.abuseipdb ?? process.env.ABUSEIPDB_API_KEY,
      };
      const repRes = await fetchReputationSignals(evidence.exitIp.ip, {
        apiKeys: repKeys,
        cachePath: options.cachePath,
        timeoutMs: Math.min(4_000, remainingMs()),
        signal: controller.signal,
      });
      evidence.network = repRes.network;
      evidence.reputation = repRes.reputation;
      rawReputationReports = repRes.raw;
    }

    // 9. Optional Browser Audit (only if options.browser === true)
    if (options.browser === true && remainingMs() > 50 && !controller.signal.aborted) {
      const { auditProxyInBrowser } = await import("./browser/api.js");
      evidence.browserAudit = await auditProxyInBrowser(parsed, {
        timeoutMs: Math.min(8_000, remainingMs()),
        allowPrivateTargets: options.allowPrivateTargets,
        expectedExitIp: evidence.exitIp?.ip,
        baselinePublicIp: evidence.baseline?.ip,
        signal: controller.signal,
        endpoint: configuredEndpoints[0],
      });
    }

    const scores = calculateScores(evidence);
    const verdict = determineVerdict(evidence, scores);

    return {
      proxy: redacted,
      verdict: verdict.verdict,
      scores,
      security: evidence.security,
      connectivity: evidence.connectivity,
      baseline: evidence.baseline,
      exitIp: evidence.exitIp,
      network: evidence.network,
      tls: evidence.tls,
      dns: evidence.dns,
      headerLeak: evidence.headerLeak,
      contentIntegrity: evidence.contentIntegrity,
      reputation: evidence.reputation ? { ...evidence.reputation, rawReports: rawReputationReports } : undefined,
      stability: evidence.stability,
      rotation: evidence.rotation,
      browserAudit: evidence.browserAudit,
      riskFactors: verdict.riskFactors,
      recommendations: verdict.recommendations,
      metadata: buildMetadata(startedAt, startTime),
    };
  } catch (err) {
    if (!evidence.connectivity) {
      evidence.connectivity = {
        reachable: false,
        error: err instanceof Error ? err.message : "Pipeline execution failed",
      };
    }
    const scores = calculateScores(evidence);
    const verdict = determineVerdict(evidence, scores);
    return {
      proxy: redacted,
      verdict: verdict.verdict,
      scores,
      security: evidence.security,
      connectivity: evidence.connectivity,
      baseline: evidence.baseline,
      exitIp: evidence.exitIp,
      network: evidence.network,
      tls: evidence.tls,
      dns: evidence.dns,
      headerLeak: evidence.headerLeak,
      contentIntegrity: evidence.contentIntegrity,
      reputation: evidence.reputation ? { ...evidence.reputation, rawReports: rawReputationReports } : undefined,
      stability: evidence.stability,
      rotation: evidence.rotation,
      browserAudit: evidence.browserAudit,
      riskFactors: verdict.riskFactors,
      recommendations: verdict.recommendations,
      metadata: buildMetadata(startedAt, startTime),
    };
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
  }
}
