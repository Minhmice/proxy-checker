import net from "node:net";
import type { ParsedProxyInput } from "../types.js";
import {
  BufferedSocketReader,
  type TimingBreakdown,
  type TransportOptions,
  connectSocketToProxy,
} from "./common.js";

export async function openSocks5ProxyTunnel(
  proxy: ParsedProxyInput,
  target: { host: string; port: number },
  options: TransportOptions = {}
): Promise<{ socket: net.Socket; timings: TimingBreakdown }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const startTime = Date.now();

  const { socket, dnsMs, tcpConnectMs } = await connectSocketToProxy(proxy, timeoutMs);

  const startHandshake = Date.now();
  const reader = new BufferedSocketReader(socket);

  try {
    const hasAuth = Boolean(proxy.username || proxy.password);
    const methods = hasAuth ? [0x00, 0x02] : [0x00];

    const greeting = Buffer.from([0x05, methods.length, ...methods]);
    socket.write(greeting);

    let remainingTimeout = Math.max(100, timeoutMs - (Date.now() - startTime));
    const methodResp = await reader.readBytes(2, remainingTimeout);

    if (methodResp[0] !== 0x05) {
      throw new Error(`Invalid SOCKS5 greeting version: ${methodResp[0]}`);
    }

    const selectedMethod = methodResp[1];
    if (selectedMethod === 0xff) {
      throw new Error("SOCKS5 proxy rejected authentication methods (0xFF)");
    }

    if (selectedMethod === 0x02) {
      const uBytes = Buffer.from(proxy.username || "", "utf8");
      const pBytes = Buffer.from(proxy.password || "", "utf8");

      if (uBytes.length > 255 || pBytes.length > 255) {
        throw new Error("SOCKS5 username and password must be <= 255 bytes");
      }

      const authReq = Buffer.alloc(3 + uBytes.length + pBytes.length);
      authReq[0] = 0x01; // auth version 1
      authReq[1] = uBytes.length;
      uBytes.copy(authReq, 2);
      authReq[2 + uBytes.length] = pBytes.length;
      pBytes.copy(authReq, 3 + uBytes.length);

      socket.write(authReq);

      remainingTimeout = Math.max(100, timeoutMs - (Date.now() - startTime));
      const authResp = await reader.readBytes(2, remainingTimeout);

      if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
        throw new Error(`SOCKS5 authentication failed with status ${authResp[1]}`);
      }
    } else if (selectedMethod !== 0x00) {
      throw new Error(`Unsupported SOCKS5 auth method returned by proxy: ${selectedMethod}`);
    }

    const useRemoteDnsDomain =
      !options.resolveDnsLocally && Boolean(options.targetDomain);
    const targetDomainName = options.targetDomain || "";

    let connectReq: Buffer;

    if (useRemoteDnsDomain) {
      const dBytes = Buffer.from(targetDomainName, "utf8");
      if (dBytes.length > 255) {
        throw new Error("Target domain name exceeds 255 bytes for SOCKS5");
      }
      connectReq = Buffer.alloc(4 + 1 + dBytes.length + 2);
      connectReq[0] = 0x05; // VER
      connectReq[1] = 0x01; // CMD: CONNECT
      connectReq[2] = 0x00; // RSV
      connectReq[3] = 0x03; // ATYP: DOMAINNAME
      connectReq[4] = dBytes.length;
      dBytes.copy(connectReq, 5);
      connectReq.writeUInt16BE(target.port, 5 + dBytes.length);
    } else {
      if (!net.isIPv4(target.host)) {
        throw new Error(
          `SOCKS5 IPv4 target expected a valid IPv4 address, got: ${target.host}. Provide targetDomain and resolveDnsLocally=false for remote DNS.`
        );
      }
      const octets = target.host.split(".").map(Number);
      connectReq = Buffer.alloc(10);
      connectReq[0] = 0x05; // VER
      connectReq[1] = 0x01; // CMD: CONNECT
      connectReq[2] = 0x00; // RSV
      connectReq[3] = 0x01; // ATYP: IP V4 address
      connectReq[4] = octets[0];
      connectReq[5] = octets[1];
      connectReq[6] = octets[2];
      connectReq[7] = octets[3];
      connectReq.writeUInt16BE(target.port, 8);
    }

    socket.write(connectReq);

    remainingTimeout = Math.max(100, timeoutMs - (Date.now() - startTime));
    const head = await reader.readBytes(4, remainingTimeout);

    const ver = head[0];
    const rep = head[1];
    const atyp = head[3];

    if (ver !== 0x05) {
      throw new Error(`Invalid SOCKS5 reply version: ${ver}`);
    }

    if (rep !== 0x00) {
      const errorMap: Record<number, string> = {
        0x01: "General SOCKS server failure",
        0x02: "Connection not allowed by ruleset",
        0x03: "Network unreachable",
        0x04: "Host unreachable",
        0x05: "Connection refused",
        0x06: "TTL expired",
        0x07: "Command not supported",
        0x08: "Address type not supported",
      };
      const msg = errorMap[rep] || `Unknown error code: ${rep}`;
      throw new Error(`SOCKS5 CONNECT request failed (status ${rep}): ${msg}`);
    }

    let bndAddrLen = 0;
    if (atyp === 0x01) {
      bndAddrLen = 4;
    } else if (atyp === 0x04) {
      bndAddrLen = 16;
    } else if (atyp === 0x03) {
      const dlenBuf = await reader.readBytes(1, remainingTimeout);
      bndAddrLen = dlenBuf[0];
    } else {
      throw new Error(`Unknown ATYP in SOCKS5 reply: ${atyp}`);
    }

    await reader.readBytes(bndAddrLen + 2, remainingTimeout);

    const leftover = reader.release();
    if (leftover.length > 0) {
      socket.unshift(leftover);
    }

    const proxyHandshakeMs = Math.max(0, Date.now() - startHandshake);
    const totalMs = Math.max(0, Date.now() - startTime);

    return {
      socket,
      timings: {
        dnsMs,
        tcpConnectMs,
        proxyHandshakeMs,
        totalMs,
      },
    };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}
