import type {
  AuditProbe,
  AuditProvenance,
  AuditReason,
  ProbeStatus,
  ProxyAuditDetail,
  ProxyAuditResult,
} from "./types.js";

export function serializeAuditDetail(
  result: ProxyAuditResult,
  proxyKey: string,
  auditId = "audit-current"
): ProxyAuditDetail {
  const probes: AuditProbe[] = [];

  // 1. Exit IP probe
  if (result.connectivity?.reachable === false) {
    probes.push({
      name: "exitIp",
      status: "FAIL",
      summary: result.connectivity.error || "Proxy connection unreachable",
      evidence: result.connectivity,
    });
  } else if (result.exitIp?.ip) {
    probes.push({
      name: "exitIp",
      status: "PASS",
      summary: `Exit IP verified: ${result.exitIp.ip}`,
      evidence: result.exitIp,
    });
  } else {
    probes.push({
      name: "exitIp",
      status: "ERROR",
      summary: "Could not determine exit IP",
      evidence: result.exitIp,
    });
  }

  // 2. Header leak probe
  if (result.headerLeak?.originIpExposed) {
    probes.push({
      name: "headers",
      status: "FAIL",
      summary: "Origin IP exposed in HTTP forwarding headers",
      evidence: result.headerLeak,
    });
  } else if (result.headerLeak?.detected) {
    probes.push({
      name: "headers",
      status: "WARN",
      summary: "Proxy metadata or forwarding headers detected",
      evidence: result.headerLeak,
    });
  } else if (result.headerLeak) {
    probes.push({
      name: "headers",
      status: "PASS",
      summary: "No source IP or revealing headers leaked",
      evidence: result.headerLeak,
    });
  } else {
    probes.push({
      name: "headers",
      status: "SKIPPED",
      summary: "Header leak check not performed",
    });
  }

  // 3. TLS probe
  if (result.tls) {
    if (result.tls.certificateValid === false || result.tls.secure === false) {
      probes.push({
        name: "tls",
        status: "FAIL",
        summary: result.tls.error || "TLS certificate or handshake invalid",
        evidence: result.tls,
      });
    } else if (result.tls.secure) {
      probes.push({
        name: "tls",
        status: "PASS",
        summary: `TLS handshake and certificate valid (${result.tls.protocol || "TLS"}, ${result.tls.cipher || "cipher"})`,
        evidence: result.tls,
      });
    } else {
      probes.push({
        name: "tls",
        status: "SKIPPED",
        summary: "TLS check skipped",
      });
    }
  } else if (result.proxy.protocol === "http" || result.proxy.protocol === "socks4") {
    probes.push({
      name: "tls",
      status: "UNSUPPORTED",
      summary: `${result.proxy.protocol.toUpperCase()} proxy transport does not negotiate client TLS tunnel`,
    });
  } else {
    probes.push({
      name: "tls",
      status: "SKIPPED",
      summary: "TLS check not performed",
    });
  }

  // 4. Content integrity
  if (result.contentIntegrity) {
    if (result.contentIntegrity.intact === false || result.contentIntegrity.tlsStripping) {
      probes.push({
        name: "contentIntegrity",
        status: "FAIL",
        summary: result.contentIntegrity.error || "Content altered or tampering detected",
        evidence: result.contentIntegrity,
      });
    } else if (result.contentIntegrity.intact === true) {
      probes.push({
        name: "contentIntegrity",
        status: "PASS",
        summary: "Payload and headers transferred intact without modification",
        evidence: result.contentIntegrity,
      });
    } else {
      probes.push({
        name: "contentIntegrity",
        status: "SKIPPED",
        summary: "Content integrity probe skipped",
      });
    }
  } else {
    probes.push({
      name: "contentIntegrity",
      status: "SKIPPED",
      summary: "Content integrity probe not performed",
    });
  }

  // 5. DNS probe
  if (result.dns) {
    if (result.dns.dnsLeakDetected === true) {
      probes.push({
        name: "dns",
        status: "FAIL",
        summary: "DNS queries leaked outside proxy tunnel",
        evidence: result.dns,
      });
    } else if (result.dns.dnsLeakDetected === false) {
      probes.push({
        name: "dns",
        status: "PASS",
        summary: "DNS resolved remotely through proxy path",
        evidence: result.dns,
      });
    } else {
      // dnsLeakDetected is null -> unsupported / unmeasured
      probes.push({
        name: "dns",
        status: "UNSUPPORTED",
        summary: "DNS resolver leak detection not supported by standard proxy socket",
        evidence: result.dns,
      });
    }
  } else {
    probes.push({
      name: "dns",
      status: "UNSUPPORTED",
      summary: "DNS resolver isolation not measured",
    });
  }

  // 6. UDP probe
  const netObj = result.network as { udp?: boolean } | undefined;
  if (netObj && typeof netObj.udp === "boolean") {
    probes.push({
      name: "udp",
      status: netObj.udp ? "PASS" : "WARN",
      summary: netObj.udp ? "UDP datagram transport supported" : "UDP routing not available",
      evidence: netObj,
    });
  } else if (result.proxy.protocol === "http") {
    probes.push({
      name: "udp",
      status: "UNSUPPORTED",
      summary: "HTTP proxies do not support UDP datagram forwarding",
    });
  } else {
    probes.push({
      name: "udp",
      status: "UNSUPPORTED",
      summary: "UDP associate capability not directly measured",
    });
  }

  // 7. Stability probe
  if (result.stability) {
    if (result.stability.stable === false || (typeof result.stability.packetLossPercent === "number" && result.stability.packetLossPercent > 20)) {
      probes.push({
        name: "stability",
        status: "WARN",
        summary: `Stability concerns: jitter ${result.stability.jitterMs ?? 0}ms, loss ${result.stability.packetLossPercent ?? 0}%`,
        evidence: result.stability,
      });
    } else if (result.stability.stable === true) {
      probes.push({
        name: "stability",
        status: "PASS",
        summary: `Latency stable across samples (jitter ${result.stability.jitterMs ?? 0}ms)`,
        evidence: result.stability,
      });
    } else {
      probes.push({
        name: "stability",
        status: "SKIPPED",
        summary: "Stability probe skipped",
      });
    }
  }

  // 8. Browser audit
  if (result.browserAudit) {
    if (result.browserAudit.supported === false) {
      probes.push({
        name: "browser",
        status: "UNSUPPORTED",
        summary: result.browserAudit.error || "Browser environment unsupported",
        evidence: result.browserAudit,
      });
    } else if (result.browserAudit.webrtcLeakDetected) {
      probes.push({
        name: "browser",
        status: "FAIL",
        summary: "Browser WebRTC STUN candidate leaked client IP",
        evidence: result.browserAudit,
      });
    } else if (result.browserAudit.navigationSucceeded) {
      probes.push({
        name: "browser",
        status: "PASS",
        summary: "Isolated browser context navigated successfully with WebRTC sealed",
        evidence: result.browserAudit,
      });
    }
  }

  // 9. Reputation probe
  if (result.reputation) {
    const hasMalicious = Boolean(
      (result.reputation as Record<string, unknown>).maliciousSignals &&
      ((result.reputation as Record<string, unknown>).maliciousSignals as unknown[]).length > 0
    );
    if (hasMalicious) {
      probes.push({
        name: "reputation",
        status: "WARN",
        summary: `Threat intelligence reported abuse or blacklist signals (score ${result.reputation.score ?? 0})`,
        evidence: result.reputation,
      });
    } else if (typeof result.reputation.score === "number") {
      probes.push({
        name: "reputation",
        status: "PASS",
        summary: `Reputation verified clean (risk score ${result.reputation.score}/100)`,
        evidence: result.reputation,
      });
    } else {
      probes.push({
        name: "reputation",
        status: "SKIPPED",
        summary: "Reputation enrichment unavailable or skipped",
      });
    }
  }

  // Map reasons
  const reasons: AuditReason[] = (result.riskFactors || []).map((rf) => {
    let sev: "info" | "warning" | "critical" = "info";
    if (rf.severity === "critical") sev = "critical";
    else if (rf.severity === "high" || rf.severity === "medium") sev = "warning";

    return {
      code: rf.code || rf.id,
      severity: sev,
      probe: rf.category || "audit",
      summary: rf.title || rf.description || rf.message || "Risk factor reported",
    };
  });

  const netContext = result.network as Record<string, unknown> | undefined;

  const exit = {
    ip: result.exitIp?.ip,
    country: result.exitIp?.country || (netContext?.country as string | undefined),
    region: result.exitIp?.region || (netContext?.region as string | undefined),
    isp: (netContext?.organization as string | undefined) || (result.exitIp as Record<string, unknown> | undefined)?.isp as string | undefined,
    asn: (netContext?.asn as string | undefined) || (result.exitIp as Record<string, unknown> | undefined)?.asn as string | undefined,
    timezone: result.exitIp?.timezone || (result.exitIp as Record<string, unknown> | undefined)?.timezone as string | undefined,
  };

  const provenance: AuditProvenance = {
    auditorVersion: result.metadata?.version || "1.0.0",
    scoringVersion: result.metadata?.schemaVersion || "1.0.0",
    probeVersions: {
      exitIp: "1.0.0",
      headers: "1.0.0",
      tls: "1.0.0",
      dns: "1.0.0",
      stability: "1.0.0",
      contentIntegrity: "1.0.0",
      reputation: "1.0.0",
    },
    timeoutMs: result.metadata?.durationMs || 15000,
    baseline: result.baseline?.ip
      ? {
          id: "baseline-primary",
          ip: result.baseline.ip,
          capturedAt: result.metadata?.startedAt || new Date().toISOString(),
        }
      : undefined,
  };

  return {
    auditId,
    proxyKey,
    verdict: result.verdict,
    scores: result.scores,
    exit,
    reasons,
    probes,
    checkedAt: result.metadata?.completedAt || new Date().toISOString(),
    scoringVersion: result.metadata?.schemaVersion || "1.0.0",
    provenance,
  };
}
