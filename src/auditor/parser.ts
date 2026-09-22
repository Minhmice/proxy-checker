import type {
  ParsedProxyInput,
  ProxyInput,
  ProxyProtocol,
  RedactedProxyInfo,
} from "./types.js";

const SUPPORTED_PROTOCOLS: Record<ProxyProtocol, true> = {
  http: true,
  https: true,
  socks4: true,
  socks5: true,
};

function normalizeProtocol(raw: string): ProxyProtocol {
  const protocol = raw.toLowerCase().replace(/:$/, "") as ProxyProtocol;
  if (!SUPPORTED_PROTOCOLS[protocol]) {
    throw new Error(`Unsupported proxy protocol: ${raw}`);
  }
  return protocol;
}

function normalizePort(port: number | string): number {
  const parsed = typeof port === "number" ? port : Number.parseInt(port, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid proxy port: ${port}`);
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
  const redactedUser = username ? `${username}:********` : undefined;
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
      throw new Error(`Malformed proxy URL: ${input}`);
    }

    const protocol = normalizeProtocol(url.protocol);
    const host = normalizeHost(url.hostname);
    const port = normalizePort(url.port || (protocol === "https" ? 443 : 80));
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    const parsed: ParsedProxyInput = {
      protocol,
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };

    return {
      parsed,
      redacted: createRedactedProxyInfo(protocol, host, port, username),
    };
  }

  if (typeof input === "object" && input !== null) {
    const protocol = normalizeProtocol(input.protocol);
    const host = normalizeHost(input.host);
    const port = normalizePort(input.port);
    const username = input.username?.trim() || undefined;
    const password = input.password?.trim() || undefined;

    const parsed: ParsedProxyInput = {
      protocol,
      host,
      port,
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
    };

    return {
      parsed,
      redacted: createRedactedProxyInfo(protocol, host, port, username),
    };
  }

  throw new Error("Proxy input must be a string URL or object");
}
