import net from "node:net";

function ipv4ToInt(ip: string): number {
  return ip
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .reduce((acc, octet) => ((acc << 8) | octet) >>> 0, 0);
}

function inIpv4Range(target: number, start: string, end: string): boolean {
  return target >= ipv4ToInt(start) && target <= ipv4ToInt(end);
}

export function isPrivateIpv4(ip: string): boolean {
  const int = ipv4ToInt(ip);

  return (
    inIpv4Range(int, "0.0.0.0", "0.255.255.255") ||
    inIpv4Range(int, "10.0.0.0", "10.255.255.255") ||
    inIpv4Range(int, "100.64.0.0", "100.127.255.255") ||
    inIpv4Range(int, "127.0.0.0", "127.255.255.255") ||
    inIpv4Range(int, "169.254.0.0", "169.254.255.255") ||
    inIpv4Range(int, "172.16.0.0", "172.31.255.255") ||
    inIpv4Range(int, "192.0.0.0", "192.0.0.255") ||
    inIpv4Range(int, "192.0.2.0", "192.0.2.255") ||
    inIpv4Range(int, "192.88.99.0", "192.88.99.255") ||
    inIpv4Range(int, "192.168.0.0", "192.168.255.255") ||
    inIpv4Range(int, "198.18.0.0", "198.19.255.255") ||
    inIpv4Range(int, "198.51.100.0", "198.51.100.255") ||
    inIpv4Range(int, "203.0.113.0", "203.0.113.255") ||
    inIpv4Range(int, "224.0.0.0", "255.255.255.255")
  );
}

function expandIpv6(ip: string): string[] {
  let clean = ip.toLowerCase();
  const zoneIndex = clean.indexOf("%");
  if (zoneIndex !== -1) {
    clean = clean.slice(0, zoneIndex);
  }

  const doubleColonCount = (clean.match(/::/g) || []).length;
  if (doubleColonCount > 1) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  const [head, tail] = clean.split("::");
  const headSegments = head ? head.split(":") : [];
  const tailSegments = tail !== undefined ? (tail ? tail.split(":") : []) : null;

  if (tailSegments === null) {
    if (headSegments.length !== 8) {
      throw new Error(`Invalid IPv6 address: ${ip}`);
    }
    return headSegments.map((seg) => seg.padStart(4, "0"));
  }

  const missing = 8 - (headSegments.length + tailSegments.length);
  if (missing < 0) {
    throw new Error(`Invalid IPv6 address: ${ip}`);
  }

  const expanded = [
    ...headSegments,
    ...Array(missing).fill("0000"),
    ...tailSegments,
  ];

  return expanded.map((seg) => seg.padStart(4, "0"));
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    const embeddedIpv4 = normalized.slice(7);
    if (net.isIPv4(embeddedIpv4)) {
      return isPrivateIpv4(embeddedIpv4);
    }
  }

  let words: number[];
  try {
    words = expandIpv6(normalized).map((hex) => Number.parseInt(hex, 16));
  } catch {
    return true;
  }

  const firstWord = words[0];
  const isLoopbackOrUnspecified =
    words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1);
  const isUniqueLocal = (firstWord & 0xfe00) === 0xfc00;
  const isLinkLocal = (firstWord & 0xffc0) === 0xfe80;
  const isMulticast = (firstWord & 0xff00) === 0xff00;
  const isDiscardPrefix = firstWord === 0x0100;

  return isLoopbackOrUnspecified || isUniqueLocal || isLinkLocal || isMulticast || isDiscardPrefix;
}

export function isPrivateIp(ip: string): boolean {
  const trimmed = ip.trim();
  const version = net.isIP(trimmed);
  if (version === 4) {
    return isPrivateIpv4(trimmed);
  }
  if (version === 6) {
    return isPrivateIpv6(trimmed);
  }
  return true;
}
