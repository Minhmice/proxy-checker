import type { ParsedProxy, ProxyProtocol } from "../lib/types.js";

export function endpoint(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function parseProxy(token: string): ParsedProxy | null {
  try {
    const source = token.trim().replace(/^[,;"']+|[,;"']+$/g, "");
    if (!source) return null;
    const url = new URL(source.includes("://") ? source : `http://${source}`);
    const scheme = url.protocol.slice(0, -1).toLowerCase();
    if (!["http", "https", "socks5"].includes(scheme) || !url.hostname || !url.port) return null;
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return {
      host,
      port,
      username: url.username ? decodeURIComponent(url.username) : null,
      password: url.password ? decodeURIComponent(url.password) : null,
      protocol: (scheme === "https" ? "http" : scheme) as ProxyProtocol,
      endpoint: endpoint(host, port),
    };
  } catch {
    return null;
  }
}

export function proxyUrl(proxy: ParsedProxy, includeCredentials = false): string {
  const auth =
    includeCredentials && proxy.username !== null
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
      : "";
  return `${proxy.protocol}://${auth}${proxy.endpoint}`;
}
