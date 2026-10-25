#!/usr/bin/env node
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function readBytes(socket, count, timeoutMs = 15000, signal) {
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
  const { promise, resolve, reject } = Promise.withResolvers();
  let buf = Buffer.alloc(0);

  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
    if (signal) signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  };

  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`Timeout reading ${count} bytes`));
  }, timeoutMs);

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length >= count) {
      socket.pause();
      cleanup();
      const result = buf.subarray(0, count);
      const remaining = buf.subarray(count);
      if (remaining.length > 0) socket.unshift(remaining);
      resolve(result);
    }
  };

  const onError = (err) => {
    cleanup();
    reject(err);
  };

  const onClose = () => {
    cleanup();
    reject(new Error("Socket closed prematurely"));
  };

  const onAbort = () => {
    cleanup();
    reject(new Error("Operation aborted"));
  };

  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.resume();
  return promise;
}

export function readUntil(socket, delimiter, timeoutMs = 15000, signal, maxBytes = 65536) {
  if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));
  const { promise, resolve, reject } = Promise.withResolvers();
  const delimBuf = Buffer.isBuffer(delimiter) ? delimiter : Buffer.from(delimiter);
  let buf = Buffer.alloc(0);

  const cleanup = () => {
    socket.off("data", onData);
    socket.off("error", onError);
    socket.off("close", onClose);
    if (signal) signal.removeEventListener("abort", onAbort);
    clearTimeout(timer);
  };

  const timer = setTimeout(() => {
    cleanup();
    reject(new Error("Timeout reading until delimiter"));
  }, timeoutMs);

  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf(delimBuf);
    if (idx !== -1) {
      if (idx > maxBytes) {
        socket.pause();
        cleanup();
        reject(new Error(`Header size limit of ${maxBytes} bytes exceeded`));
        return;
      }
      socket.pause();
      cleanup();
      const end = idx + delimBuf.length;
      const result = buf.subarray(0, end);
      const remaining = buf.subarray(end);
      if (remaining.length > 0) socket.unshift(remaining);
      resolve(result);
      return;
    }
    if (buf.length > maxBytes) {
      socket.pause();
      cleanup();
      reject(new Error(`Header size limit of ${maxBytes} bytes exceeded`));
    }
  };

  const onError = (err) => {
    cleanup();
    reject(err);
  };

  const onClose = () => {
    cleanup();
    reject(new Error("Socket closed prematurely"));
  };

  const onAbort = () => {
    cleanup();
    reject(new Error("Operation aborted"));
  };

  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);
  socket.resume();
  return promise;
}

export function sanitizeSecrets(text, secrets = []) {
  if (typeof text !== "string") {
    if (text instanceof Error) {
      const cloned = new Error(sanitizeSecrets(text.message, secrets));
      cloned.code = text.code;
      if (text.stack) cloned.stack = sanitizeSecrets(text.stack, secrets);
      return cloned;
    }
    return String(text);
  }
  let result = text;
  for (const s of secrets) {
    if (s && typeof s === "string") result = result.replaceAll(s, "***REDACTED***");
  }
  return result.replace(/:\/\/([^:@\s]+):([^@\s]+)@/g, "://$1:***@");
}

function parseStrictInt(val, name, min, max) {
  if (!val || !/^\d+$/.test(String(val).trim())) {
    throw new Error(`Validation error: --${name} must be a positive integer, got '${val}'.`);
  }
  const n = Number(val);
  if (n < min || n > max) {
    throw new Error(`Validation error: --${name} must be between ${min} and ${max}, got '${val}'.`);
  }
  return n;
}

export function parseIPv6ToBuffer(ip) {
  const buf = Buffer.alloc(16);
  const parts = ip.split("::");
  const left = parts[0] ? parts[0].split(":").map((h) => parseInt(h, 16)) : [];
  const right = parts[1] ? parts[1].split(":").map((h) => parseInt(h, 16)) : [];
  const pad = 8 - (left.length + right.length);
  const words = [...left, ...new Array(pad).fill(0), ...right];
  for (let i = 0; i < 8; i++) {
    buf.writeUInt16BE(words[i] || 0, i * 2);
  }
  return buf;
}

/**
 * @param {string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 */
export function parseBenchmarkConfig(argv = [], env = process.env) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--confirm-required") flags.confirmRequired = true;
    else if (a === "--target" && i + 1 < argv.length) flags.target = argv[++i];
    else if (a === "--concurrency" && i + 1 < argv.length) flags.concurrency = argv[++i];
    else if (a === "--requests" && i + 1 < argv.length) flags.requests = argv[++i];
    else if (a === "--duration" && i + 1 < argv.length) flags.duration = argv[++i];
    else if (a === "--protocol" && i + 1 < argv.length) flags.protocol = argv[++i];
    else if (a === "--ca-cert" && i + 1 < argv.length) flags.caCert = argv[++i];
    else if (a === "--node-id" && i + 1 < argv.length) flags.nodeId = argv[++i];
    else if (a.startsWith("--proxy-url")) {
      throw new Error(
        "Security validation error: --proxy-url cannot be passed via CLI. Set BENCHMARK_PROXY_URL.",
      );
    } else if (a.startsWith("--")) {
      throw new Error(`Validation error: Unknown argument '${a}'.`);
    }
  }

  if (!flags.confirmRequired) {
    throw new Error(
      "Validation error: --confirm-required flag is required to run controlled benchmark.",
    );
  }

  const rawProxy = env.BENCHMARK_PROXY_URL;
  if (!rawProxy || !rawProxy.trim()) {
    throw new Error("Validation error: BENCHMARK_PROXY_URL environment variable must be set.");
  }

  let pUrl;
  try {
    pUrl = new URL(rawProxy);
  } catch {
    throw new Error("Validation error: BENCHMARK_PROXY_URL is not a valid URL.");
  }

  if (!["http:", "socks5:", "socks5h:"].includes(pUrl.protocol)) {
    throw new Error(
      `Validation error: Unsupported proxy scheme '${pUrl.protocol}'. Supported: http:, socks5:, socks5h:.`,
    );
  }

  const defaultPort = pUrl.protocol === "http:" ? 80 : 1080;
  const proxyPort = pUrl.port ? parseStrictInt(pUrl.port, "proxy-port", 1, 65535) : defaultPort;

  if (!flags.target) throw new Error("Validation error: --target <url> is required.");

  let tUrl;
  try {
    tUrl = new URL(flags.target);
  } catch {
    throw new Error("Validation error: --target is not a valid URL.");
  }

  if (tUrl.protocol !== "https:") {
    throw new Error(
      `Validation error: Target URL scheme must be 'https:', got '${tUrl.protocol}'.`,
    );
  }

  if (tUrl.username || tUrl.password) {
    throw new Error("Validation error: Target URL must not contain embedded credentials.");
  }

  const rawTargetHost = tUrl.hostname.replace(/^\[|\]$/g, "");
  const targetPort = tUrl.port ? parseStrictInt(tUrl.port, "target-port", 1, 65535) : 443;
  const authority = net.isIPv6(rawTargetHost)
    ? `[${rawTargetHost}]:${targetPort}`
    : `${rawTargetHost}:${targetPort}`;

  let protocol = flags.protocol;
  if (!protocol) {
    protocol = pUrl.protocol.startsWith("socks5") ? "socks5" : "http-connect";
  } else if (!["http-connect", "socks5"].includes(protocol)) {
    throw new Error(
      `Validation error: --protocol must be 'http-connect' or 'socks5', got '${protocol}'.`,
    );
  }

  const concurrency = parseStrictInt(flags.concurrency || "1", "concurrency", 1, 100);
  const requests = parseStrictInt(flags.requests || "100", "requests", 1, 50000);
  const duration = parseStrictInt(flags.duration || "30", "duration", 1, 300);

  let caCertData = null;
  if (flags.caCert) {
    caCertData = fs.readFileSync(flags.caCert);
  }

  const secretsToRedact = [];
  if (pUrl.password) secretsToRedact.push(pUrl.password, encodeURIComponent(pUrl.password));
  if (rawProxy) secretsToRedact.push(rawProxy);

  return {
    proxy: {
      protocol,
      hostname: pUrl.hostname,
      port: proxyPort,
      username: pUrl.username ? decodeURIComponent(pUrl.username) : null,
      password: pUrl.password ? decodeURIComponent(pUrl.password) : null,
      hasAuth: Boolean(pUrl.username || pUrl.password),
    },
    target: {
      url: tUrl.href,
      hostname: rawTargetHost,
      authority,
      port: targetPort,
      path: tUrl.pathname + tUrl.search,
    },
    concurrency,
    maxRequests: requests,
    durationSeconds: duration,
    caCertData,
    nodeId: flags.nodeId || env.FLEET_NODE_ID || null,
    controllerUrl: env.FLEET_CONTROLLER_URL || null,
    controllerToken: env.FLEET_CONTROLLER_TOKEN || null,
    secretsToRedact,
  };
}

export async function createTunneledTlsSocket(config, signal, activeSockets) {
  const { proxy, target, caCertData } = config;
  const { promise, resolve, reject } = Promise.withResolvers();

  if (signal?.aborted) return Promise.reject(new Error("Operation aborted"));

  const rawSocket = net.connect({ host: proxy.hostname, port: proxy.port });
  rawSocket.setTimeout(15000);
  if (activeSockets) {
    activeSockets.add(rawSocket);
    rawSocket.once("close", () => activeSockets.delete(rawSocket));
  }

  const cleanup = () => {
    rawSocket.setTimeout(0);
    rawSocket.removeAllListeners("timeout");
  };

  rawSocket.once("timeout", () => {
    cleanup();
    rawSocket.destroy();
    reject(new Error(`Timeout connecting to proxy ${proxy.hostname}:${proxy.port}`));
  });

  rawSocket.once("error", (err) => {
    cleanup();
    reject(err);
  });

  const onAbort = () => {
    cleanup();
    rawSocket.destroy();
    reject(new Error("Operation aborted"));
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  rawSocket.once("connect", async () => {
    try {
      if (proxy.protocol === "http-connect") {
        let req = `CONNECT ${target.authority} HTTP/1.1\r\nHost: ${target.authority}\r\nProxy-Connection: Keep-Alive\r\n`;
        if (proxy.hasAuth) {
          const b64 = Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`).toString(
            "base64",
          );
          req += `Proxy-Authorization: Basic ${b64}\r\n`;
        }
        rawSocket.write(req + "\r\n");

        const headers = await readUntil(rawSocket, "\r\n\r\n", 15000, signal);
        const match = headers.toString("latin1").match(/^HTTP\/1\.[01]\s+(\d{3})/i);
        if (!match || parseInt(match[1], 10) !== 200) {
          throw new Error(`Proxy CONNECT failed with status ${match ? match[1] : "unknown"}`);
        }
      } else {
        const greeting = proxy.hasAuth
          ? Buffer.from([0x05, 0x02, 0x00, 0x02])
          : Buffer.from([0x05, 0x01, 0x00]);
        rawSocket.write(greeting);

        const methodResp = await readBytes(rawSocket, 2, 15000, signal);
        if (methodResp[0] !== 0x05 || methodResp[1] === 0xff) {
          throw new Error("SOCKS5 proxy rejected authentication methods");
        }

        if (methodResp[1] === 0x02) {
          const uBuf = Buffer.from(proxy.username || "", "utf8");
          const pBuf = Buffer.from(proxy.password || "", "utf8");
          rawSocket.write(
            Buffer.concat([
              Buffer.from([0x01, uBuf.length]),
              uBuf,
              Buffer.from([pBuf.length]),
              pBuf,
            ]),
          );
          const authResp = await readBytes(rawSocket, 2, 15000, signal);
          if (authResp[0] !== 0x01 || authResp[1] !== 0x00) {
            throw new Error(`SOCKS5 authentication failed (status: ${authResp[1]})`);
          }
        }

        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(target.port, 0);

        let cmd;
        if (net.isIPv4(target.hostname)) {
          const ip = target.hostname.split(".").map(Number);
          cmd = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip]), portBuf]);
        } else if (net.isIPv6(target.hostname)) {
          const ipBuf = parseIPv6ToBuffer(target.hostname);
          cmd = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), ipBuf, portBuf]);
        } else {
          const dom = Buffer.from(target.hostname, "utf8");
          cmd = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, dom.length]), dom, portBuf]);
        }
        rawSocket.write(cmd);

        const replyHead = await readBytes(rawSocket, 4, 15000, signal);
        if (replyHead[1] !== 0x00) {
          throw new Error(`SOCKS5 CONNECT failed with reply code ${replyHead[1]}`);
        }

        const atyp = replyHead[3];
        if (atyp === 0x01) await readBytes(rawSocket, 6, 15000, signal);
        else if (atyp === 0x03) {
          const len = (await readBytes(rawSocket, 1, 15000, signal))[0];
          await readBytes(rawSocket, len + 2, 15000, signal);
        } else if (atyp === 0x04) await readBytes(rawSocket, 18, 15000, signal);
      }

      cleanup();
      if (signal) signal.removeEventListener("abort", onAbort);

      const tlsSocket = tls.connect({
        socket: rawSocket,
        host: target.hostname,
        port: target.port,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        ca: caCertData || undefined,
        rejectUnauthorized: true,
      });

      if (activeSockets) {
        activeSockets.add(tlsSocket);
        tlsSocket.once("close", () => activeSockets.delete(tlsSocket));
      }

      tlsSocket.once("secureConnect", () => resolve(tlsSocket));
      tlsSocket.once("error", (err) => {
        tlsSocket.destroy();
        reject(err);
      });
    } catch (err) {
      cleanup();
      rawSocket.destroy();
      reject(err);
    }
  });

  return promise;
}

export async function executeRequest(config, signal, activeSockets) {
  const startTime = Date.now();
  const { promise, resolve } = Promise.withResolvers();
  try {
    const agent = new https.Agent({
      keepAlive: false,
      maxSockets: 1,
    });
    agent.createConnection = (_options, callback) => {
      createTunneledTlsSocket(config, signal, activeSockets).then(
        (tlsSocket) => callback(null, tlsSocket),
        callback,
      );
    };

    const req = https.request(
      config.target.url,
      {
        method: "GET",
        agent,
        headers: {
          Host: config.target.authority,
          "User-Agent": "fleet-capacity-benchmark/1.0",
          Connection: "close",
        },
        signal,
      },
      (res) => {
        let bytesRead = 0;
        res.on("data", (chunk) => {
          bytesRead += chunk.length;
        });
        res.on("end", () => {
          const latencyMs = Date.now() - startTime;
          const isSuccess = res.statusCode >= 200 && res.statusCode < 400;
          resolve({
            success: isSuccess,
            statusCode: res.statusCode,
            bytesRead,
            latencyMs,
            errorCode: isSuccess ? undefined : `HTTP_${res.statusCode}`,
          });
        });
        res.on("error", (err) => {
          resolve({
            success: false,
            error: sanitizeSecrets(err.message, config.secretsToRedact),
            errorCode: err.code || "ERR_STREAM",
            latencyMs: Date.now() - startTime,
            bytesRead: 0,
          });
        });
      },
    );

    req.on("error", (err) => {
      resolve({
        success: false,
        error: sanitizeSecrets(err.message, config.secretsToRedact),
        errorCode: err.code || "ERR_REQUEST",
        latencyMs: Date.now() - startTime,
        bytesRead: 0,
      });
    });

    req.end();
  } catch (err) {
    resolve({
      success: false,
      error: sanitizeSecrets(err.message, config.secretsToRedact),
      errorCode: err.code || "ERR_CONNECT",
      latencyMs: Date.now() - startTime,
      bytesRead: 0,
    });
  }

  return promise;
}

async function fetchControllerSnapshot(config) {
  if (!config.controllerUrl || !config.controllerToken || !config.nodeId) return null;
  try {
    const targetUrl = new URL(
      `/api/fleet/nodes/${encodeURIComponent(config.nodeId)}`,
      config.controllerUrl,
    );
    const res = await fetch(targetUrl.href, {
      headers: { Authorization: `Bearer ${config.controllerToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { available: false, status: res.status };
    const data = await res.json();
    return {
      available: true,
      node: {
        id: data.node?.id,
        status: data.node?.status,
        maxConnections: data.node?.maxConnections,
      },
    };
  } catch (err) {
    return { available: false, error: sanitizeSecrets(err.message, config.secretsToRedact) };
  }
}

export async function runBenchmark(config) {
  const abortCtrl = new AbortController();
  const activeSockets = new Set();

  const onAbortAll = () => {
    for (const sock of activeSockets) {
      try {
        sock.destroy();
      } catch {}
    }
    activeSockets.clear();
  };
  abortCtrl.signal.addEventListener("abort", onAbortAll, { once: true });

  // 1. Snapshot taken BEFORE timer starts so controller latency doesn't consume workload deadline
  const initialSnapshot = await fetchControllerSnapshot(config);

  // 2. Start workload deadline
  const timer = setTimeout(
    () => abortCtrl.abort(new Error("Deadline reached")),
    config.durationSeconds * 1000,
  );

  let dispatched = 0;
  const startTime = Date.now();
  const results = {
    completed: 0,
    successful: 0,
    failed: 0,
    bytes: 0,
    latencies: [],
    statusCodes: {},
    errors: {},
  };

  const worker = async () => {
    while (!abortCtrl.signal.aborted && dispatched < config.maxRequests) {
      dispatched++;
      const res = await executeRequest(config, abortCtrl.signal, activeSockets);
      results.completed++;
      results.latencies.push(res.latencyMs);
      const code = String(res.statusCode || 0);
      results.statusCodes[code] = (results.statusCodes[code] || 0) + 1;
      if (res.bytesRead > 0) results.bytes += res.bytesRead;

      if (res.success) {
        results.successful++;
      } else {
        results.failed++;
        const key = res.errorCode || "ERR_UNKNOWN";
        results.errors[key] = (results.errors[key] || 0) + 1;
      }
    }
  };

  await Promise.all(Array.from({ length: config.concurrency }, () => worker()));
  clearTimeout(timer);
  onAbortAll();

  const durationMs = Math.max(Date.now() - startTime, 1);
  const finalSnapshot = await fetchControllerSnapshot(config);

  const sorted = [...results.latencies].sort((a, b) => a - b);
  const p = (pct) =>
    sorted[Math.min(Math.floor((pct / 100) * sorted.length), Math.max(0, sorted.length - 1))] || 0;
  const sum = sorted.reduce((a, b) => a + b, 0);

  const durationSec = durationMs / 1000;
  return {
    timestamp: new Date().toISOString(),
    configuration: {
      target: config.target.url,
      protocol: config.proxy.protocol,
      proxyHost: config.proxy.hostname,
      proxyPort: config.proxy.port,
      proxyAuthPresent: config.proxy.hasAuth,
      concurrency: config.concurrency,
      maxRequests: config.maxRequests,
      durationLimitSeconds: config.durationSeconds,
      caCertProvided: Boolean(config.caCertData),
    },
    metrics: {
      completedRequests: results.completed,
      successfulRequests: results.successful,
      failedRequests: results.failed,
      totalBytesRead: results.bytes,
      durationMs,
      throughput: {
        requestsPerSecond: Number((results.completed / durationSec).toFixed(2)),
        bytesPerSecond: Number((results.bytes / durationSec).toFixed(2)),
      },
      latencyMs: {
        min: sorted[0] || 0,
        max: sorted[sorted.length - 1] || 0,
        avg: Number((sum / (sorted.length || 1)).toFixed(2)),
        p50: p(50),
        p90: p(90),
        p95: p(95),
        p99: p(99),
      },
      statusCodes: results.statusCodes,
      errors: results.errors,
    },
    controllerTelemetry:
      initialSnapshot || finalSnapshot ? { before: initialSnapshot, after: finalSnapshot } : null,
  };
}

export async function main() {
  try {
    const config = parseBenchmarkConfig(process.argv.slice(2), process.env);
    const report = await runBenchmark(config);
    console.log(JSON.stringify(report, null, 2));
    if (report.metrics.completedRequests === 0 || report.metrics.successfulRequests === 0) {
      process.exit(2);
    }
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile && currentFile === invokedFile) {
  void main();
}
