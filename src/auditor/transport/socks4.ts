import net from "node:net";
import type { ParsedProxyInput } from "../types.js";
import {
  BufferedSocketReader,
  type TimingBreakdown,
  type TransportOptions,
  connectSocketToProxy,
  resolveAndPinTargetAddress,
} from "./common.js";

export async function openSocks4ProxyTunnel(
  proxy: ParsedProxyInput,
  target: { host: string; port: number },
  options: TransportOptions = {}
): Promise<{ socket: net.Socket; timings: TimingBreakdown }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  const remainingDeadline = () => deadline - Date.now();
  if (remainingDeadline() <= 0) {
    throw new Error(`Timeout after ${timeoutMs}ms before resolving target host`);
  }

  const startTargetDns = Date.now();
  const pinnedTargetIp = await resolveAndPinTargetAddress(target, {
    ...options,
    timeoutMs: remainingDeadline(),
  });
  const targetDnsMs = Math.max(0, Date.now() - startTargetDns);

  if (!net.isIPv4(pinnedTargetIp)) {
    throw new Error(`SOCKS4 protocol requires an IPv4 destination host, got: ${pinnedTargetIp}`);
  }

  const remainingBeforeConnect = remainingDeadline();
  if (remainingBeforeConnect <= 0) {
    throw new Error(`Timeout after ${timeoutMs}ms before connecting to proxy`);
  }

  const { socket, dnsMs: proxyDnsMs, tcpConnectMs } = await connectSocketToProxy(
    proxy,
    remainingBeforeConnect,
    options
  );
  const startHandshake = Date.now();
  const reader = new BufferedSocketReader(socket);

  try {
    const ipOctets = pinnedTargetIp.split(".").map(Number);
    const userId = proxy.username ? Buffer.from(proxy.username, "utf8") : Buffer.alloc(0);

    const reqBuf = Buffer.alloc(8 + userId.length + 1);
    reqBuf[0] = 0x04; // VN: SOCKS4
    reqBuf[1] = 0x01; // CD: CONNECT
    reqBuf.writeUInt16BE(target.port, 2); // DSTPORT
    reqBuf[4] = ipOctets[0]; // DSTIP
    reqBuf[5] = ipOctets[1];
    reqBuf[6] = ipOctets[2];
    reqBuf[7] = ipOctets[3];
    if (userId.length > 0) {
      userId.copy(reqBuf, 8);
    }
    reqBuf[8 + userId.length] = 0x00; // NULL terminator

    socket.write(reqBuf);

    const remainingTimeout = deadline - Date.now();
    if (remainingTimeout <= 0) {
      throw new Error(`Timeout after ${timeoutMs}ms waiting for SOCKS4 reply`);
    }

    const response = await reader.readBytes(8, remainingTimeout);

    if (response[0] !== 0x00) {
      throw new Error(`Invalid SOCKS4 reply version: ${response[0]}`);
    }
    const cd = response[1];

    if (cd !== 0x5a) {
      const errorMap: Record<number, string> = {
        0x5b: "Request rejected or failed",
        0x5c: "Request failed because client is not running identd",
        0x5d: "Request failed because client's identd could not confirm user ID",
      };
      const msg = errorMap[cd] || `Unknown SOCKS4 error code: ${cd}`;
      throw new Error(`SOCKS4 connection rejected (code ${cd}): ${msg}`);
    }

    const leftover = reader.release();
    if (leftover.length > 0) {
      socket.unshift(leftover);
    }

    const proxyHandshakeMs = Math.max(0, Date.now() - startHandshake);
    const totalMs = Math.max(0, Date.now() - startTime);

    return {
      socket,
      timings: {
        dnsMs: proxyDnsMs + targetDnsMs,
        tcpConnectMs,
        proxyHandshakeMs,
        totalMs,
      },
    };
  } catch (err) {
    reader.release();
    socket.destroy();
    throw err;
  }
}
