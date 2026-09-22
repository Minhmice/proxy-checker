import net from "node:net";
import tls from "node:tls";
import { isPrivateIp } from "../security/ip-policy.js";
import { validateTargetHost } from "../security/ssrf.js";
import type { ParsedProxyInput } from "../types.js";

export const MAX_HEADERS_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

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
  signal?: AbortSignal;
  ca?: string | Buffer;
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

  async readUntil(delimiter: Buffer | string, timeoutMs = 5000, maxBytes = MAX_HEADERS_BYTES): Promise<{ matched: Buffer; remainder: Buffer }> {
    const delim = typeof delimiter === "string" ? Buffer.from(delimiter) : delimiter;
    const startTime = Date.now();

    while (true) {
      const idx = this.buffer.indexOf(delim);
      if (idx !== -1) {
        if (idx + delim.length > maxBytes) {
          throw new Error(`Header/data size exceeded maximum limit of ${maxBytes} bytes`);
        }
        const matched = this.buffer.subarray(0, idx + delim.length);
        this.buffer = this.buffer.subarray(idx + delim.length);
        return { matched, remainder: this.buffer };
      }

      // If delimiter not found yet, only check if the unparsed buffer exceeds maxBytes
      if (this.buffer.length > maxBytes) {
        throw new Error(`Header/data size exceeded maximum limit of ${maxBytes} bytes`);
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

  async readAll(timeoutMs = 5000, maxBytes = MAX_BODY_BYTES): Promise<Buffer> {
    const startTime = Date.now();
    while (true) {
      if (this.error) {
        this.socket.destroy();
        throw this.error;
      }
      if (this.closed) {
        break;
      }
      if (this.buffer.length > maxBytes) {
        this.socket.destroy();
        throw new Error(`Response body size exceeded limit of ${maxBytes} bytes`);
      }

      const elapsed = Date.now() - startTime;
      const remaining = timeoutMs - elapsed;
      if (remaining <= 0) {
        this.socket.destroy();
        throw new Error(`Timeout after ${timeoutMs}ms while reading response body`);
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

    if (this.buffer.length > maxBytes) {
      this.socket.destroy();
      throw new Error(`Response body size exceeded limit of ${maxBytes} bytes`);
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
      try {
        this.socket.pause();
      } catch {
        // Socket may already be destroyed or closed
      }
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
  const timeoutMs = options.timeoutMs ?? 10000;
  const validation = await validateTargetHost(target.host, {
    allowPrivateTargets: options.allowPrivateTargets,
    timeoutMs,
  });

  if (!validation.valid || validation.resolvedIps.length === 0) {
    throw new Error(`SSRF validation rejected target ${target.host}: ${validation.reason || "restricted"}`);
  }
  return validation.resolvedIps[0];
}

export async function connectSocketToProxy(
  proxy: ParsedProxyInput,
  timeoutMs: number,
  options: TransportOptions = {}
): Promise<{ socket: net.Socket; dnsMs: number; tcpConnectMs: number; targetIp: string }> {
  if (options.signal?.aborted) {
    throw new Error("Operation aborted");
  }
  const startDns = Date.now();
  const remainingDeadline = () => Math.max(1, timeoutMs - (Date.now() - startDns));
  const proxyValidation = await validateTargetHost(proxy.host, {
    allowPrivate: options.allowPrivateTargets,
    allowPrivateTargets: options.allowPrivateTargets,
    timeoutMs: remainingDeadline(),
  });

  if (!proxyValidation.valid || proxyValidation.resolvedIps.length === 0) {
    throw new Error(
      `SSRF validation rejected proxy host ${proxy.host}: ${proxyValidation.reason || "restricted"}`
    );
  }

  const dnsMs = Math.max(0, Date.now() - startDns);
  const targetIp = proxyValidation.resolvedIps[0];

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

  const onAbort = () => {
    if (timer) clearTimeout(timer);
    socket.destroy();
    reject(new Error("Operation aborted"));
  };
  if (options.signal) {
    options.signal.addEventListener("abort", onAbort, { once: true });
  }

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
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
    resolve(socket);
  });

  if (proxy.protocol === "https") {
    socket.once("secureConnect", () => {
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener("abort", onAbort);
      resolve(socket);
    });
  }

  socket.once("error", (err) => {
    if (timer) clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onAbort);
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
