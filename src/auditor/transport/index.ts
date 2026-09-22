import type net from "node:net";
import type { ParsedProxyInput } from "../types.js";
import {
  type HttpRequestOptions,
  type HttpResponse,
  type TimingBreakdown,
  type TransportOptions,
} from "./common.js";
import { openHttpProxyTunnel, requestThroughProxy } from "./http.js";
import { openSocks4ProxyTunnel } from "./socks4.js";
import { openSocks5ProxyTunnel } from "./socks5.js";

export {
  BufferedSocketReader,
  type HttpRequestOptions,
  type HttpResponse,
  type TimingBreakdown,
  type TransportOptions,
} from "./common.js";
export { openHttpProxyTunnel, requestThroughProxy } from "./http.js";
export { openSocks4ProxyTunnel } from "./socks4.js";
export { openSocks5ProxyTunnel } from "./socks5.js";

export async function openProxyTunnel(
  proxy: ParsedProxyInput,
  target: { host: string; port: number },
  options: TransportOptions = {}
): Promise<{ socket: net.Socket; timings: TimingBreakdown }> {
  switch (proxy.protocol) {
    case "http":
    case "https":
      return openHttpProxyTunnel(proxy, target, options);
    case "socks4":
      return openSocks4ProxyTunnel(proxy, target, options);
    case "socks5":
      return openSocks5ProxyTunnel(proxy, target, options);
    default: {
      const exhaustiveCheck: never = proxy.protocol;
      throw new Error(`Unsupported proxy protocol: ${String(exhaustiveCheck)}`);
    }
  }
}
