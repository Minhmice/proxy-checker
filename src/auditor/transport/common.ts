import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { isPrivateIp } from "../security/ip-policy.js";
import { validateTargetHost } from "../security/ssrf.js";
import type { ParsedProxyInput } from "../types.js";

export interface TimingBreakdown {
  dnsMs: number;
  tcpConnectMs: number;
  proxyHandshakeMs: number;
  totalMs: number;
}

export interface TransportOptions {
  timeoutMs?: number;
  resolveDnsLocally?: boolean;
  targetDomain?: string;
  allowPrivateTargets?: boolean;
  resolvedIp?: string;
}

export interface HttpRequestOptions {
  method?: string;
  path?: string;
  host: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
}

export class BufferedSocketReader {
  private buffer: Buffer = Buffer.alloc(0);
  private closed = false;
  private error: Error | null = null;
  private waitingResolvers: Array<() => void> = [];
  private onData: (chunk: Buffer) => void;
  private onEnd: () => void;
  private onClose: () => void;
  private onError: (err: Error) => void;
  private isReleased = false;

  constructor(private socket: net.Socket) {
    this.onData = (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flushWaiters();
    };

    this.onEnd = () => {
      this.closed = true;
      this.flushWaiters();
    };

    this.onClose = () => {
      this.closed = true;
      this.flushWaiters();
    };

    this.onError = (err: Error) => {
      this.error = err;
      this.closed = true;
      this.flushWaiters();
    };

    this.socket.on("data", this.onData);
    this.socket.once("end", this.onEnd);
    this.socket.once("close", this.onClose);
    this.socket.once("error", this.onError);
  }

  private flushWaiters(): void {
    const list = this.waitingResolvers;
    this.waitingResolvers = [];
    for (const resolve of list) {
      resolve();
    }
  }

  async readBytes(count: number, timeoutMs = 5000): Promise<Buffer> {
    const startTime = Date.now();
    while (this.buffer.length < count) {
      if (this.error) throw this.error;
      if (this.closed) {
        throw new Error(`Socket closed before reading ${count} bytes (had ${this.buffer.length})`);
      }
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting for ${count} bytes`);
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        resolve();
      }, Math.min(remaining, 100));

      this.waitingResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });

      await promise;
    }

    const chunk = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return chunk;
  }

  async readUntil(delimiter: Buffer | string, timeoutMs = 5000): Promise<{ matched: Buffer; remainder: Buffer }> {
    const delim = typeof delimiter === "string" ? Buffer.from(delimiter) : delimiter;
    const startTime = Date.now();

    while (true) {
      const idx = this.buffer.indexOf(delim);
      if (idx !== -1) {
        const matched = this.buffer.subarray(0, idx + delim.length);
        this.buffer = this.buffer.subarray(idx + delim.length);
        return { matched, remainder: this.buffer };
      }

      if (this.error) throw this.error;
      if (this.closed) {
        throw new Error("Socket closed before delimiter was received");
      }

      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        throw new Error(`Timeout after ${timeoutMs}ms waiting for delimiter`);
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        resolve();
      }, Math.min(remaining, 100));

      this.waitingResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });

      await promise;
    }
  }

  async readAll(timeoutMs = 5000): Promise<Buffer> {
    const startTime = Date.now();
    while (!this.closed) {
      if (this.error) throw this.error;
      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) break;

      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(() => {
        resolve();
      }, Math.min(remaining, 100));

      this.waitingResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });

      await promise;
    }

    const result = this.buffer;
    this.buffer = Buffer.alloc(0);
    return result;
  }

  unread(data: Buffer): void {
    if (data.length > 0) {
      this.buffer = Buffer.concat([data, this.buffer]);
      this.flushWaiters();
    }
  }

  release(): Buffer {
    if (!this.isReleased) {
      this.isReleased = true;
      this.socket.removeListener("data", this.onData);
      this.socket.removeListener("end", this.onEnd);
      this.socket.removeListener("close", this.onClose);
      this.socket.removeListener("error", this.onError);
      this.flushWaiters();
    }
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }
}

export async function resolveAndPinTargetAddress(
  target: { host: string; port: number },
  options: TransportOptions = {}
): Promise<string> {
  if (options.resolvedIp) {
    if (!net.isIP(options.resolvedIp)) {
      throw new Error(`Invalid resolvedIp provided: ${options.resolvedIp}`);
    }
    if (!options.allowPrivateTargets && isPrivateIp(options.resolvedIp)) {
      throw new Error(`Target IP ${options.resolvedIp} is restricted by SSRF policy`);
    }
    return options.resolvedIp;
  }

  const validation = await validateTargetHost(target.host, {
    allowPrivateTargets: options.allowPrivateTargets,
  });

  if (!validation.valid || validation.resolvedIps.length === 0) {
    throw new Error(`SSRF validation rejected target ${target.host}: ${validation.reason || "restricted"}`);
  }

  return validation.resolvedIps[0];
}

export async function connectSocketToProxy(
  proxy: ParsedProxyInput,
  timeoutMs: number
): Promise<{ socket: net.Socket; dnsMs: number; tcpConnectMs: number; targetIp: string }> {
  let dnsMs = 0;
  let targetIp = proxy.host;

  if (!net.isIP(proxy.host)) {
    const startDns = Date.now();
    const lookupResult = await Promise.race([
      dns.lookup(proxy.host, { family: 4 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`DNS resolution timed out for proxy host: ${proxy.host}`)), timeoutMs)
      ),
    ]);
    dnsMs = Math.max(0, Date.now() - startDns);
    targetIp = lookupResult.address;
  }

  const startTcp = Date.now();
  const remainingTimeout = timeoutMs - dnsMs;
  if (remainingTimeout <= 0) {
    throw new Error(`Timeout after ${timeoutMs}ms before TCP connect to proxy ${proxy.host}`);
  }

  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  let timer: NodeJS.Timeout | null = null;

  const onTimeout = () => {
    socket.destroy();
    reject(new Error(`Connection to proxy ${proxy.host}:${proxy.port} timed out after ${timeoutMs}ms`));
  };

  timer = setTimeout(onTimeout, remainingTimeout);

  const socket: net.Socket =
    proxy.protocol === "https"
      ? tls.connect({
          host: targetIp,
          port: proxy.port,
          servername: proxy.host,
          // Security policy: Never disable TLS verification on HTTPS proxies
          rejectUnauthorized: true,
        })
      : net.connect({
          host: targetIp,
          port: proxy.port,
        });

  socket.once("connect", () => {
    if (timer) clearTimeout(timer);
    resolve(socket);
  });

  if (proxy.protocol === "https") {
    socket.once("secureConnect", () => {
      if (timer) clearTimeout(timer);
      resolve(socket);
    });
  }

  socket.once("error", (err) => {
    if (timer) clearTimeout(timer);
    reject(err);
  });

  const connectedSocket = await promise;
  const tcpConnectMs = Math.max(0, Date.now() - startTcp);

  return {
    socket: connectedSocket,
    dnsMs,
    tcpConnectMs,
    targetIp,
  };
}
