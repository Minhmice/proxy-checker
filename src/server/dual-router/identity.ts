/**
 * Canonical semantic identity helpers for Dual 9Router synchronization.
 */

const DEFAULT_PORTS: Record<string, number> = {
  "http:": 80,
  "https:": 443,
  "socks5:": 1080,
  "socks5h:": 1080,
  "socks4:": 1080,
  "socks4a:": 1080,
  "socks:": 1080,
  "ws:": 80,
  "wss:": 443,
};

/**
 * Normalizes proxy URL into a canonical semantic key.
 * Preserves protocol (lowercase), host (lowercase), explicit port (resolved defaults),
 * verbatim auth credentials (case-preserved), and normalized pathname components.
 */
export function poolKey(proxyUrl: string): string {
  const trimmed = proxyUrl.trim();
  const urlString = /^[a-z0-9+.-]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  const parsed = new URL(urlString);
  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const resolvedPort =
    parsed.port || (DEFAULT_PORTS[protocol] !== undefined ? String(DEFAULT_PORTS[protocol]) : "");

  // Auth: username and password preserved verbatim
  const auth = parsed.username
    ? parsed.password
      ? `${parsed.username}:${parsed.password}@`
      : `${parsed.username}@`
    : "";

  // Normalize path components: collapse redundant slashes, strip non-root trailing slash
  let pathname = parsed.pathname.replace(/\/+/g, "/");
  if (pathname === "/") {
    pathname = "";
  } else if (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }

  parsed.searchParams.sort();
  const portSuffix = resolvedPort ? `:${resolvedPort}` : "";
  return `${protocol}//${auth}${host}${portSuffix}${pathname}${parsed.search}`;
}

/**
 * Normalizes account identity key combining lowercase provider and stable subject/email.
 * Throws on identity ambiguity when neither subject nor email can be resolved.
 */
export function accountKey(provider: string, subject: string | null, email: string | null): string {
  if (!provider || !provider.trim()) {
    throw new Error("Identity ambiguity: provider is required");
  }
  const normProvider = provider.trim().toLowerCase();
  const cleanSubject = subject ? subject.trim() : "";
  const cleanEmail = email ? email.trim() : "";

  if (!cleanSubject && !cleanEmail) {
    throw new Error("Identity ambiguity: both subject and email are missing or empty");
  }

  // Stable subject takes precedence over mutable email addresses
  if (cleanSubject) {
    return `${normProvider}:${cleanSubject}`;
  }

  // Normalize email: domain lowercased; localpart provider-dependent
  const atIndex = cleanEmail.lastIndexOf("@");
  if (atIndex === -1) {
    return `${normProvider}:${cleanEmail}`;
  }

  const local = cleanEmail.slice(0, atIndex);
  const domain = cleanEmail.slice(atIndex + 1).toLowerCase();

  // Antigravity & Google email localparts are case-insensitive
  const isGoogleOrAntigravity =
    normProvider === "antigravity" ||
    normProvider === "google" ||
    domain === "gmail.com" ||
    domain === "googlemail.com";

  const normLocal = isGoogleOrAntigravity ? local.toLowerCase() : local;
  return `${normProvider}:${normLocal}@${domain}`;
}

function routerOriginKey(rawUrl: string): {
  key: string;
  normalizedUrl: string;
} {
  let url = rawUrl.trim();
  if (!/^[a-z0-9+.-]+:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  const parsed = new URL(url);
  const protocol = parsed.protocol.toLowerCase();
  let host = parsed.hostname.toLowerCase();

  // Normalize loopback aliases (localhost, 127.0.0.1, ::1, 0.0.0.0)
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0"
  ) {
    host = "127.0.0.1";
  }

  const port = parsed.port || (protocol === "https:" ? "443" : "80");
  const key = `${protocol}//${host}:${port}`;
  const normalizedUrl = url.replace(/\/+$/, "");
  return { key, normalizedUrl };
}

/**
 * Detects router registrations that point to the same host/port/scheme (aliases).
 * Returns pairs of [primaryRouterId, aliasRouterId] and deduplicated unique URLs.
 */
export function detectRouterAlias(registrations: Array<{ routerId: string; url: string }>): {
  aliases: Array<[string, string]>;
  uniqueUrls: string[];
} {
  const aliases: Array<[string, string]> = [];
  const uniqueUrls: string[] = [];
  const seenKeyToFirstRouterId = new Map<string, string>();
  const seenKeys = new Set<string>();

  for (const reg of registrations) {
    const { key, normalizedUrl } = routerOriginKey(reg.url);
    if (seenKeyToFirstRouterId.has(key)) {
      const primaryId = seenKeyToFirstRouterId.get(key)!;
      aliases.push([primaryId, reg.routerId]);
    } else {
      seenKeyToFirstRouterId.set(key, reg.routerId);
    }

    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      uniqueUrls.push(normalizedUrl);
    }
  }

  return { aliases, uniqueUrls };
}
