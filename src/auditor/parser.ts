import type {
  ParsedProxyInput,
  ProxyInput,
  ProxyProtocol,
  RedactedProxyInfo,
} from "./types.js";

const SUPPORTED_PROTOCOLS = new Set<ProxyProtocol>(["http", "https", "socks4", "socks5"]);

function normalizeProtocol(raw: string): ProxyProtocol {
  if (typeof raw !== "string") {
    throw new Error("Proxy protocol must be a string");
  }
  const protocol = raw.toLowerCase().replace(/:$/, "") as ProxyProtocol;
  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
  return protocol;
}

function normalizePort(port: number | string): number {
  const parsed = typeof port === "number" ? port : Number(String(port).trim());
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("Invalid proxy port: must be an integer between 1 and 65535");
  }
  return parsed;
}

function normalizeHost(host: string): string {
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

function createRedactedProxyInfo(
  protocol: ProxyProtocol,
  host: string,
  port: number,
  username?: string
): RedactedProxyInfo {
  const redactedUser = username !== undefined && username !== "" ? `${username}:********` : undefined;
  const formattedHost = host.includes(":") ? `[${host}]` : host;
  const representation = redactedUser
    ? `${protocol}://${redactedUser}@${formattedHost}:${port}`
    : `${protocol}://${formattedHost}:${port}`;

  const info: RedactedProxyInfo = {
    protocol,
    host,
    port,
    username: redactedUser,
    password: undefined,
  };

  Object.defineProperty(info, "toString", {
    value: () => representation,
    enumerable: false,
  });

  return info;
}

export function parseProxyInput(input: ProxyInput): {
  parsed: ParsedProxyInput;
  redacted: RedactedProxyInfo;
} {
  if (typeof input === "string") {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      // Do not include raw input to prevent leaking plaintext credentials
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

      return {
        parsed,
        redacted: createRedactedProxyInfo(protocol, host, port, username),
      };
    } catch (err: unknown) {
      // Rethrow normalized error without exposing any sensitive parameters
      const message = err instanceof Error ? err.message : "Failed to parse proxy URL";
      throw new Error(`Invalid proxy URL configuration: ${message}`);
    }
  }

  if (typeof input === "object" && input !== null) {
    const protocol = normalizeProtocol(input.protocol);
    const host = normalizeHost(input.host);
    const port = normalizePort(input.port);
    // Preserve exact credential whitespace
    const username = input.username !== undefined && input.username !== "" ? input.username : undefined;
    const password = input.password !== undefined && input.password !== "" ? input.password : undefined;

    const parsed: ParsedProxyInput = {
      protocol,
      host,
      port,
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    };

    return {
      parsed,
      redacted: createRedactedProxyInfo(protocol, host, port, username),
    };
  }

  throw new Error("Proxy input must be a string URL or object");
}
