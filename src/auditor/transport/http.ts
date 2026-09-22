import type net from "node:net";
import type { ParsedProxyInput } from "../types.js";
import {
  BufferedSocketReader,
  type HttpRequestOptions,
  type HttpResponse,
  type TimingBreakdown,
  type TransportOptions,
  MAX_BODY_BYTES,
  connectSocketToProxy,
  resolveAndPinTargetAddress,
} from "./common.js";

export async function openHttpProxyTunnel(
  proxy: ParsedProxyInput,
  target: { host: string; port: number },
  options: TransportOptions = {}
): Promise<{ socket: net.Socket; timings: TimingBreakdown }> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;
  const startTime = Date.now();

  const pinnedTargetIp = await resolveAndPinTargetAddress(target, options);

  const { socket, dnsMs, tcpConnectMs } = await connectSocketToProxy(proxy, timeoutMs, options);

  const startHandshake = Date.now();
  const reader = new BufferedSocketReader(socket);

  try {
    const connectHost = pinnedTargetIp;
    const lines = [
      `CONNECT ${connectHost}:${target.port} HTTP/1.1`,
      `Host: ${target.host}:${target.port}`,
    ];

    if (proxy.username || proxy.password) {
      const creds = `${proxy.username || ""}:${proxy.password || ""}`;
      const encoded = Buffer.from(creds, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${encoded}`);
    }

    lines.push("Proxy-Connection: Keep-Alive", "", "");
    const connectPayload = lines.join("\r\n");

    socket.write(connectPayload);

    const remainingTimeout = deadline - Date.now();
    if (remainingTimeout <= 0) {
      throw new Error(`Timeout after ${timeoutMs}ms during HTTP CONNECT handshake`);
    }

    const { matched } = await reader.readUntil("\r\n\r\n", remainingTimeout);

    const headerText = matched.toString("utf8");
    const statusLine = headerText.split("\r\n")[0] || "";
    const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d{3})/i);
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP proxy CONNECT failed with status code ${statusCode || "unknown"}`);
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
        dnsMs,
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

export async function requestThroughProxy(
  socket: net.Socket,
  req: HttpRequestOptions
): Promise<HttpResponse> {
  const method = req.method || "GET";
  const path = req.path || "/";
  const timeoutMs = req.timeoutMs ?? 10000;
  const deadline = Date.now() + timeoutMs;

  const headers: Record<string, string> = {
    Host: req.host,
    Connection: "close",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ProxySafetyAuditor/1.0",
    ...(req.headers || {}),
  };

  const lines: string[] = [`${method} ${path} HTTP/1.1`];
  for (const [key, value] of Object.entries(headers)) {
    lines.push(`${key}: ${value}`);
  }
  lines.push("", "");

  const headerBytes = Buffer.from(lines.join("\r\n"), "utf8");
  socket.write(headerBytes);

  if (req.body) {
    const bodyBytes = typeof req.body === "string" ? Buffer.from(req.body, "utf8") : req.body;
    socket.write(bodyBytes);
  }
  const reader = new BufferedSocketReader(socket);
  socket.resume();
  try {
    let remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms before reading HTTP response headers`);

    const { matched } = await reader.readUntil("\r\n\r\n", remaining);

    const headerStr = matched.toString("utf8");
    const headerLines = headerStr.split("\r\n");
    const statusLine = headerLines[0] || "";
    const parts = statusLine.split(" ");
    const statusCode = Number(parts[1]) || 0;
    const statusText = parts.slice(2).join(" ");

    const resHeaders: Record<string, string> = {};
    for (let i = 1; i < headerLines.length; i++) {
      const line = headerLines[i];
      if (!line) continue;
      const colon = line.indexOf(":");
      if (colon !== -1) {
        const key = line.slice(0, colon).trim().toLowerCase();
        const val = line.slice(colon + 1).trim();
        resHeaders[key] = val;
      }
    }

    let rawBody: Buffer;
    if (method.toUpperCase() === "HEAD") {
      rawBody = Buffer.alloc(0);
    } else {
      const transferEncoding = (resHeaders["transfer-encoding"] || "").toLowerCase();
      const isChunked = transferEncoding.includes("chunked");
      const contentLengthHeader = resHeaders["content-length"];
    if (isChunked) {
      const chunks: Buffer[] = [];
      let totalChunkBytes = 0;
      while (true) {
        remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while reading chunked body`);

        const lineMatch = await reader.readUntil("\r\n", remaining);
        const sizeLine = lineMatch.matched.toString("utf8").trim();
        const chunkSizeHex = sizeLine.split(";")[0].trim();
        const chunkSize = Number.parseInt(chunkSizeHex, 16);

        if (Number.isNaN(chunkSize) || chunkSize < 0) {
          throw new Error(`Invalid chunk size encountered in response: ${sizeLine}`);
        }

        if (chunkSize === 0) {
          remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while terminating chunked body`);
          // Read trailing headers or empty line
          await reader.readUntil("\r\n", remaining);
          break;
        }
        if (totalChunkBytes + chunkSize > MAX_BODY_BYTES) {
          throw new Error(`Body exceeds max allowed size of ${MAX_BODY_BYTES} bytes`);
        }

        remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while reading chunk data`);
        const chunkData = await reader.readBytes(chunkSize, remaining);
        totalChunkBytes += chunkSize;
        chunks.push(chunkData);
        remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while reading chunk terminator`);
        const terminator = await reader.readBytes(2, remaining);
        if (terminator[0] !== 0x0d || terminator[1] !== 0x0a) {
          throw new Error("Missing CRLF terminator after chunk data");
        }
      }
      rawBody = Buffer.concat(chunks);
    } else if (contentLengthHeader !== undefined) {
      const expectedLength = Number.parseInt(contentLengthHeader.trim(), 10);
      if (Number.isNaN(expectedLength) || expectedLength < 0) {
        throw new Error(`Invalid Content-Length header: ${contentLengthHeader}`);
      }
      if (expectedLength > MAX_BODY_BYTES) {
        throw new Error(`Body exceeds max allowed size of ${MAX_BODY_BYTES} bytes`);
      }
      remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while reading content-length body`);
      rawBody = await reader.readBytes(expectedLength, remaining);
    } else {
      remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout after ${timeoutMs}ms while reading body to EOF`);
      rawBody = await reader.readAll(remaining);
    }
    }

    const leftover = reader.release();
    if (leftover.length > 0) {
      socket.unshift(leftover);
    }

    const body = rawBody.toString("utf8");

    return {
      statusCode,
      statusText,
      headers: resHeaders,
      body,
      rawBody,
    };
  } catch (err) {
    reader.release();
    socket.destroy();
    throw err;
  }
}
