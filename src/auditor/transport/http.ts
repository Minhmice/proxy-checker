import type net from "node:net";
import type { ParsedProxyInput } from "../types.js";
import {
  BufferedSocketReader,
  type HttpRequestOptions,
  type HttpResponse,
  type TimingBreakdown,
  type TransportOptions,
  connectSocketToProxy,
} from "./common.js";

export async function openHttpProxyTunnel(
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
    const lines = [`CONNECT ${target.host}:${target.port} HTTP/1.1`, `Host: ${target.host}:${target.port}`];

    if (proxy.username || proxy.password) {
      const creds = `${proxy.username || ""}:${proxy.password || ""}`;
      const encoded = Buffer.from(creds, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${encoded}`);
    }

    lines.push("Proxy-Connection: Keep-Alive", "", "");
    const connectPayload = lines.join("\r\n");

    socket.write(connectPayload);

    const remainingTimeout = Math.max(100, timeoutMs - (Date.now() - startTime));
    const { matched } = await reader.readUntil("\r\n\r\n", remainingTimeout);

    const headerText = matched.toString("utf8");
    const statusLine = headerText.split("\r\n")[0] || "";
    const statusMatch = statusLine.match(/HTTP\/\d\.\d\s+(\d{3})/i);
    const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`HTTP proxy CONNECT failed with status: ${statusLine}`);
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
  const { matched } = await reader.readUntil("\r\n\r\n", timeoutMs);

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

  const rawBody = await reader.readAll(timeoutMs);
  const body = rawBody.toString("utf8");

  return {
    statusCode,
    statusText,
    headers: resHeaders,
    body,
    rawBody,
  };
}
