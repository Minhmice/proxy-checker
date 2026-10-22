import net from "node:net";

export type FleetPublicIpStatus =
  | "unknown"
  | "verified"
  | "expected_mismatch"
  | "duplicate"
  | "lookup_failed";

export interface IpDecision {
  status: FleetPublicIpStatus;
  reason: string | null;
}

function parseIpv4Octets(ip: string): number[] | null {
  if (net.isIPv4(ip) !== true) return null;
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (nums.some((n) => n === -1)) return null;
  return nums;
}

export function validateTailscaleIpv4(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    throw new Error("Tailscale IP is required");
  }
  const octets = parseIpv4Octets(trimmed);
  if (!octets) {
    throw new Error(`Tailscale address must be a valid IPv4 address (got '${trimmed}')`);
  }
  // Tailscale CGNAT subnet: 100.64.0.0/10 (100.64.0.0 - 100.127.255.255)
  const isCgnat = octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
  if (!isCgnat) {
    throw new Error(`Tailscale address must be in 100.64.0.0/10 subnet (got '${trimmed}')`);
  }
  return trimmed;
}

export function validatePublicIpv4(value: string): string {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    throw new Error("Public IP is required");
  }
  const octets = parseIpv4Octets(trimmed);
  if (!octets) {
    throw new Error(`Public address must be a valid IPv4 address (got '${trimmed}')`);
  }

  const [a, b, c] = octets;
  // Non-global / private / loopback / link-local / multicast / reserved exclusions
  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  const isLoopback = a === 127;
  const isLinkLocal = a === 169 && b === 254;
  const isTailscaleCgnat = a === 100 && b >= 64 && b <= 127;
  const isMulticast = a >= 224 && a <= 239;
  const isReserved = a >= 240;
  const isTestNet1 = a === 192 && b === 0 && c === 2; // 192.0.2.0/24
  const isTestNet2 = a === 198 && b === 51 && c === 100; // 198.51.100.0/24
  const isTestNet3 = a === 203 && b === 0 && c === 113; // 203.0.113.0/24
  const isCurrentNetwork = a === 0;

  if (
    isPrivate ||
    isLoopback ||
    isLinkLocal ||
    isTailscaleCgnat ||
    isMulticast ||
    isReserved ||
    isTestNet1 ||
    isTestNet2 ||
    isTestNet3 ||
    isCurrentNetwork
  ) {
    throw new Error(`Public address must be a global unicast IPv4 address (got '${trimmed}')`);
  }

  return trimmed;
}

export function evaluatePublicIp(input: {
  observed: string | null;
  expected: string | null;
  activePeerIps: readonly string[];
}): IpDecision {
  if (!input.observed) {
    return {
      status: "lookup_failed",
      reason: "Public IP lookup returned no result",
    };
  }

  let observedClean: string;
  try {
    observedClean = validatePublicIpv4(input.observed);
  } catch {
    return {
      status: "lookup_failed",
      reason: "Observed public IP is not valid global unicast IPv4",
    };
  }

  if (input.expected) {
    let expectedClean = input.expected.trim();
    try {
      expectedClean = validatePublicIpv4(expectedClean);
    } catch {
      // Expected address was invalid format
      return {
        status: "expected_mismatch",
        reason: `Expected public IP ${input.expected} is not valid, observed ${observedClean}`,
      };
    }

    if (observedClean !== expectedClean) {
      return {
        status: "expected_mismatch",
        reason: `Expected public IP ${expectedClean}, observed ${observedClean}`,
      };
    }
  }

  const isDuplicate = input.activePeerIps.some((peerIp) => {
    const peerClean = (peerIp || "").trim();
    return peerClean === observedClean;
  });

  if (isDuplicate) {
    return {
      status: "duplicate",
      reason: `Duplicate public IP ${observedClean} already active on another node`,
    };
  }

  return {
    status: "verified",
    reason: null,
  };
}
