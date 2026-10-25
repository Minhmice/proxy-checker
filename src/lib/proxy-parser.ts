export type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

export interface ParsedProxyInput {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface RedactedProxyInfo {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
}

const SUPPORTED_PROTOCOLS = new Set<ProxyProtocol>(["http", "https", "socks4", "socks5"]);

export function normalizeProtocol(raw: string): ProxyProtocol {
  if (typeof raw !== "string") {
    throw new Error("Proxy protocol must be a string");
  }
  const protocol = raw.toLowerCase().replace(/:$/, "") as ProxyProtocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
  return protocol;
}

export function normalizePort(port: number | string): number {
  const parsed = typeof port === "number" ? port : Number(String(port).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Invalid proxy port: must be an integer between 1 and 65535");
  }
  return parsed;
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error("Proxy host cannot be empty");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const unwrapped = trimmed.slice(1, -1).trim();
    if (!unwrapped) {
      throw new Error("Proxy host cannot be empty");
    }
    return unwrapped;
  }
  return trimmed;
}

export function parseProxyInput(
  input:
    | string
    | { protocol: string; host: string; port: number; username?: string; password?: string },
  defaultScheme?: string,
): {
  parsed: ParsedProxyInput;
  redacted: RedactedProxyInfo;
} {
  if (typeof input === "string") {
    const bareHostPort = !input.includes("://") && /^[^\s/:]+:\d+$/.test(input.trim());

    let url: URL;
    try {
      url = new URL(
        input.includes("://") || !bareHostPort
          ? input.trim()
          : `${defaultScheme ?? "http"}://${input.trim()}`,
      );
    } catch {
      throw new Error("Malformed proxy URL");
    }

    try {
      const protocol = normalizeProtocol(url.protocol);
      const host = normalizeHost(url.hostname);
      const port = normalizePort(url.port || (protocol === "https" ? 443 : 80));
      const username = url.username ? decodeURIComponent(url.username) : undefined;
      const password = url.password ? decodeURIComponent(url.password) : undefined;

      const parsed: ParsedProxyInput = {
        protocol,
        host,
        port,
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
      };

      const redacted: RedactedProxyInfo = {
        protocol,
        host,
        port,
        ...(username !== undefined ? { username } : {}),
      };

      return { parsed, redacted };
    } catch {
      throw new Error("Invalid proxy URL configuration");
    }
  }

  if (typeof input === "object" && input !== null) {
    const protocol = normalizeProtocol(input.protocol);
    const host = normalizeHost(input.host);
    const port = normalizePort(input.port);
    const username =
      typeof input.username === "string" && input.username ? input.username : undefined;
    const password =
      typeof input.password === "string" && input.password ? input.password : undefined;

    return {
      parsed: { protocol, host, port, username, password },
      redacted: { protocol, host, port, username },
    };
  }

  throw new Error("Invalid proxy input");
}
