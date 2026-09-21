import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { DiagnosticJob, ParsedProxy, ProxyProtocol } from "../lib/types.js";
import { parseProxy } from "./proxy-core.js";

export interface DetailedDiagnosticResult {
  id: string;
  endpoint: string;
  protocol: ParsedProxy["protocol"];
  status: "SUCCESS" | "FAILED";
  statusCode: number | null;
  latencyMs: number;
  exitIp: string | null;
  country: string | null;
  isp: string | null;
  isProxyOrHosting: boolean | null;
  headerLeakage: boolean | null;
  leakedHeaders: string[];
  checkedAt: number;
  error?: string;
}

export type { DiagnosticJob };

class Reader {
  buffer = Buffer.alloc(0);
  waiters: Array<{ length: number; resolve: (data: Buffer) => void; reject: (error: Error) => void }> = [];
  events: Array<() => void> = [];
  ended = false;

  constructor(socket: net.Socket | tls.TLSSocket) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.flush();
      for (const resolve of this.events.splice(0)) resolve();
    });
    socket.on("end", () => { this.ended = true; this.flush(); });
    socket.on("error", (error: Error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  private flush() {
    for (const waiter of [...this.waiters]) {
      if (this.buffer.length < waiter.length) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      const data = this.buffer.subarray(0, waiter.length);
      this.buffer = this.buffer.subarray(waiter.length);
      waiter.resolve(data);
    }
  }

  read(length: number, timeout: number): Promise<Buffer> {
    if (this.buffer.length >= length) {
      const data = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return Promise.resolve(data);
    }
    return new Promise((resolve, reject) => {
      const waiter = { length, resolve, reject };
      this.waiters.push(waiter);
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) { this.waiters.splice(index, 1); reject(new Error("response timeout")); }
      }, timeout);
    });
  }

  async until(marker: Buffer, timeout: number): Promise<Buffer> {
    const deadline = Date.now() + timeout;
    while (!this.buffer.includes(marker)) {
      if (this.ended) throw new Error("connection closed before response headers");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("response timeout");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("response timeout")), remaining);
        this.events.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    const end = this.buffer.indexOf(marker) + marker.length;
    const data = this.buffer.subarray(0, end);
    this.buffer = this.buffer.subarray(end);
    return data;
  }
}

function connect(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("proxy connection timeout")); }, timeout);
    socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function openTunnel(proxy: ParsedProxy, host: string, port: number, timeout: number): Promise<net.Socket> {
  const socket = await connect(proxy.host, proxy.port, timeout);
  const reader = new Reader(socket);
  if (proxy.protocol === "http") {
    const auth = proxy.username === null ? "" : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}\r\n`;
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const header = (await reader.until(Buffer.from("\r\n\r\n"), timeout)).toString("latin1");
    if (!/^HTTP\/\d\.\d 200\b/.test(header)) throw new Error(header.split("\r\n")[0] || "HTTP proxy refused tunnel");
    return socket;
  }
  const methods = proxy.username === null ? [0] : [0, 2];
  socket.write(Buffer.from([5, methods.length, ...methods]));
  const hello = await reader.read(2, timeout);
  if (hello[0] !== 5 || hello[1] === 255) throw new Error("SOCKS5 authentication failed");
  if (hello[1] === 2) {
    if (proxy.username === null) throw new Error("SOCKS5 authentication required");
    const user = Buffer.from(proxy.username); const pass = Buffer.from(proxy.password ?? "");
    if (user.length > 255 || pass.length > 255) throw new Error("SOCKS5 credentials too long");
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await reader.read(2, timeout);
    if (auth[1] !== 0) throw new Error("SOCKS5 credentials rejected");
  }
  const domain = Buffer.from(host);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([port >> 8, port & 255])]));
  const reply = await reader.read(4, timeout);
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 connect refused (${reply[1]})`);
  const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : (await reader.read(1, timeout))[0];
  await reader.read(addressLength + 2, timeout);
  return socket;
}

interface HttpResponse { statusCode: number; headers: Record<string, string>; body: string; }

async function requestThrough(socket: net.Socket, host: string, requestPath: string, secure: boolean, timeout: number): Promise<HttpResponse> {
  const transport = secure ? tls.connect({ socket, servername: host, rejectUnauthorized: true }) : socket;
  if (secure) await new Promise<void>((resolve, reject) => { transport.once("secureConnect", resolve); transport.once("error", reject); });
  const reader = new Reader(transport);
  transport.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\nUser-Agent: minhmiceProxy-diagnostics/1.0\r\n\r\n`);
  const headerText = (await reader.until(Buffer.from("\r\n\r\n"), timeout)).toString("latin1");
  const lines = headerText.split("\r\n");
  const statusCode = Number(lines[0]?.split(" ")[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) { const split = line.indexOf(":"); if (split > 0) headers[line.slice(0, split).toLowerCase()] = line.slice(split + 1).trim(); }
  const contentLength = Number(headers["content-length"] ?? 0);
  let body: Buffer;
  if (contentLength > 0) body = await reader.read(contentLength, timeout);
  else if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    const chunks: Buffer[] = [];
    while (true) {
      const sizeLine = (await reader.until(Buffer.from("\r\n"), timeout)).toString("ascii").trim();
      const size = Number.parseInt(sizeLine.split(";", 1)[0], 16);
      if (!Number.isFinite(size) || size < 0) throw new Error("invalid chunked response");
      if (size === 0) { await reader.until(Buffer.from("\r\n"), timeout); break; }
      chunks.push(await reader.read(size, timeout));
      await reader.read(2, timeout);
    }
    body = Buffer.concat(chunks);
  }
  else {
    await Promise.race([new Promise<void>((resolve) => transport.once("end", resolve)), new Promise<void>((_, reject) => setTimeout(() => reject(new Error("body timeout")), timeout))]);
    body = reader.buffer;
  }
  return { statusCode, headers, body: body.toString("utf8") };
}

function idFor(endpoint: string) { return Buffer.from(endpoint).toString("base64url"); }

export async function testProxyDetailed(proxy: ParsedProxy, timeout = 7000): Promise<DetailedDiagnosticResult> {
  const started = Date.now();
  let socket: net.Socket | undefined;
  let observedStatus: number | null = null;
  let observedData: { query?: string; country?: string; isp?: string; proxy?: boolean; hosting?: boolean } = {};
  let observedLeakage: string[] = [];
  let targetLatencyMs = 0;
  let activeProtocol: ProxyProtocol = proxy.protocol;
  // Try assigned protocol, and fall back to alternate protocol if tunnel fails
  const protocolsToTry: ProxyProtocol[] = [proxy.protocol];
  const altProtocol: ProxyProtocol = proxy.protocol === "http" ? "socks5" : "http";
  protocolsToTry.push(altProtocol);

  let lastTunnelError: Error | null = null;
  for (const proto of protocolsToTry) {
    try {
      socket = await openTunnel({ ...proxy, protocol: proto }, "ip-api.com", 80, timeout);
      activeProtocol = proto;
      lastTunnelError = null;
      break;
    } catch (err) {
      lastTunnelError = err as Error;
      socket?.destroy();
      socket = undefined;
    }
  }

  if (lastTunnelError || !socket) {
    return {
      id: idFor(proxy.endpoint),
      endpoint: proxy.endpoint,
      protocol: activeProtocol,
      status: "FAILED",
      statusCode: null,
      latencyMs: Date.now() - started,
      exitIp: null,
      country: null,
      isp: null,
      isProxyOrHosting: null,
      headerLeakage: null,
      leakedHeaders: [],
      checkedAt: Date.now(),
      error: lastTunnelError?.message || "proxy connection failed",
    };
  }

  try {
    const targetStarted = Date.now();
    const ipApi = await requestThrough(socket, "ip-api.com", "/json/?fields=status,message,country,query,isp,proxy,hosting", false, timeout);
    targetLatencyMs = Date.now() - targetStarted;
    observedStatus = ipApi.statusCode;
    const data = JSON.parse(ipApi.body) as { status?: string; message?: string; query?: string; country?: string; isp?: string; proxy?: boolean; hosting?: boolean };
    observedData = data;
    if (ipApi.statusCode !== 200 || data.status !== "success" || !data.query || !net.isIP(data.query)) {
      throw new Error(data.message || `ip-api HTTP ${ipApi.statusCode}`);
    }
  } catch (error) {
    return {
      id: idFor(proxy.endpoint),
      endpoint: proxy.endpoint,
      protocol: activeProtocol,
      status: "FAILED",
      statusCode: observedStatus,
      latencyMs: targetLatencyMs || Date.now() - started,
      exitIp: observedData.query ?? null,
      country: observedData.country ?? null,
      isp: observedData.isp ?? null,
      isProxyOrHosting: observedData.query ? Boolean(observedData.proxy || observedData.hosting) : null,
      headerLeakage: observedStatus === 200 ? observedLeakage.length > 0 : null,
      leakedHeaders: observedLeakage,
      checkedAt: Date.now(),
      error: (error as Error).message,
    };
  } finally {
    socket?.destroy();
    socket = undefined;
  }

  // Secondary probe: header leakage via httpbin (optional; failure does not fail the verified proxy)
  try {
    socket = await openTunnel({ ...proxy, protocol: activeProtocol }, "httpbin.org", 443, Math.min(timeout, 3500));
    const echo = await requestThrough(socket, "httpbin.org", "/anything", true, Math.min(timeout, 3500));
    const echoBody = JSON.parse(echo.body) as { headers?: Record<string, string> };
    const suspicious = ["forwarded", "via", "x-forwarded-for", "x-real-ip", "client-ip", "proxy-connection"];
    const echoedHeaders = Object.keys(echoBody.headers ?? {}).map((key) => key.toLowerCase());
    observedLeakage = suspicious.filter((key) => echoedHeaders.includes(key));
  } catch {
    observedLeakage = [];
  } finally {
    socket?.destroy();
    socket = undefined;
  }

  return {
    id: idFor(proxy.endpoint),
    endpoint: proxy.endpoint,
    protocol: activeProtocol,
    status: "SUCCESS",
    statusCode: observedStatus,
    latencyMs: targetLatencyMs,
    exitIp: observedData.query!,
    country: observedData.country ?? null,
    isp: observedData.isp ?? null,
    isProxyOrHosting: Boolean(observedData.proxy || observedData.hosting),
    headerLeakage: observedLeakage.length > 0,
    leakedHeaders: observedLeakage,
    checkedAt: Date.now(),
  };
}

function emptyJob(): DiagnosticJob {
  return {
    status: "idle",
    sourceFile: null,
    samplePercent: 30,
    sampleCount: null,
    eligible: 0,
    total: 0,
    checked: 0,
    passedCount: 0,
    failedCount: 0,
    startedAt: null,
    finishedAt: null,
    results: [],
    error: "",
  };
}

export interface DiagnosticRunnerDeps {
  testProxy?: typeof testProxyDetailed;
  getConcurrency?: () => number;
  persistIntervalMs?: number;
}

function shuffle<T>(array: T[]): T[] {
  const items = [...array];
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = items[i];
    items[i] = items[j];
    items[j] = temp;
  }
  return items;
}

export function createDiagnosticRunner(
  { inputDir, dataDir }: { inputDir: string; dataDir: string },
  injectedDeps: DiagnosticRunnerDeps = {}
) {
  const stateFile = path.join(dataDir, "diagnostics.json");
  const testProxy = injectedDeps.testProxy ?? testProxyDetailed;
  const getConcurrency = injectedDeps.getConcurrency ?? (() => 10);
  const persistIntervalMs = injectedDeps.persistIntervalMs ?? 500;

  let job: DiagnosticJob = emptyJob();
  let running = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Partial<DiagnosticJob>;
    const storedResults = Array.isArray(parsed.results) ? parsed.results : [];
    const derivedPassed = storedResults.filter((r) => r.status === "SUCCESS").length;
    const derivedFailed = storedResults.filter((r) => r.status === "FAILED").length;
    job = {
      ...emptyJob(),
      ...parsed,
      status: parsed.status === "running" ? (parsed.checked && parsed.checked > 0 ? "done" : "idle") : (parsed.status ?? "idle"),
      passedCount: typeof parsed.passedCount === "number" ? parsed.passedCount : (storedResults.length > 0 ? derivedPassed : undefined),
      failedCount: typeof parsed.failedCount === "number" ? parsed.failedCount : (storedResults.length > 0 ? derivedFailed : undefined),
      sampleCount: typeof parsed.sampleCount === "number" ? parsed.sampleCount : null,
    };
    if (parsed.status === "running") {
      save();
    }
  } catch {
    /* first run */
  }

  function files() {
    if (!fs.existsSync(inputDir)) return [];
    return fs
      .readdirSync(inputDir)
      .filter((name) => name.toLowerCase().endsWith(".txt"))
      .map((name) => {
        let text: string;
        try {
          text = fs.readFileSync(path.join(inputDir, name), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw error;
        }
        const defaultProtocol: ProxyProtocol = name.toLowerCase().includes("socks") ? "socks5" : "http";
        const seen = new Set<string>();
        for (const token of text.split(/[\s,;]+/)) {
          const proxy = parseProxy(token, defaultProtocol);
          if (proxy) seen.add(proxy.endpoint);
        }
        return { name, count: seen.size };
      })
      .filter((file): file is { name: string; count: number } => file !== null);
  }

  function load(name?: string) {
    const available = files();
    const selected = name && available.some((file) => file.name === name) ? name : available[0]?.name;
    if (!selected) return [] as ParsedProxy[];
    const defaultProtocol: ProxyProtocol = selected.toLowerCase().includes("socks") ? "socks5" : "http";
    const seen = new Set<string>();
    const result: ParsedProxy[] = [];
    let text: string;
    try {
      text = fs.readFileSync(path.join(inputDir, selected), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    for (const token of text.split(/[\s,;]+/)) {
      const proxy = parseProxy(token, defaultProtocol);
      if (proxy && !seen.has(proxy.endpoint)) {
        seen.add(proxy.endpoint);
        result.push(proxy);
      }
    }
    return result;
  }

  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2));
    fs.renameSync(tmp, stateFile);
  }

  async function run(options: { file?: string; samplePercent?: number; sampleCount?: number } = {}) {
    if (running) return false;
    running = true;
    const eligible = load(options.file);
    const eligibleCount = eligible.length;

    let sampleSize = 0;
    let effectivePercent = 30;
    let effectiveCount: number | null = null;

    if (options.sampleCount !== undefined) {
      const parsedCount = Math.floor(Number(options.sampleCount));
      effectiveCount = Math.max(1, Math.min(eligibleCount || 1, Number.isFinite(parsedCount) ? parsedCount : 1));
      sampleSize = eligibleCount ? effectiveCount : 0;
      effectivePercent = eligibleCount ? Math.min(100, Math.max(1, Math.round((sampleSize / eligibleCount) * 100))) : 30;
    } else {
      effectivePercent = Math.min(100, Math.max(1, Number(options.samplePercent ?? 30)));
      sampleSize = eligibleCount ? Math.max(1, Math.ceil((eligibleCount * effectivePercent) / 100)) : 0;
    }

    const sample = shuffle(eligible).slice(0, sampleSize);
    job = {
      ...emptyJob(),
      status: "running",
      sourceFile: options.file ?? files()[0]?.name ?? null,
      samplePercent: effectivePercent,
      sampleCount: effectiveCount,
      eligible: eligibleCount,
      total: sample.length,
      checked: 0,
      passedCount: 0,
      failedCount: 0,
      startedAt: Date.now(),
    };
    save();

    let lastSavedAt = Date.now();
    let nextIndex = 0;

    async function worker() {
      while (running && nextIndex < sample.length) {
        const currentIndex = nextIndex++;
        const proxy = sample[currentIndex];
        try {
          const result = await testProxy(proxy);
          if (result.status === "SUCCESS") {
            job.passedCount = (job.passedCount ?? 0) + 1;
          } else {
            job.failedCount = (job.failedCount ?? 0) + 1;
          }
          job.results = [result, ...job.results].slice(0, 500);
        } catch (error) {
          const failedResult: DetailedDiagnosticResult = {
            id: Buffer.from(proxy.endpoint).toString("base64url"),
            endpoint: proxy.endpoint,
            protocol: proxy.protocol,
            status: "FAILED",
            statusCode: null,
            latencyMs: 0,
            exitIp: null,
            country: null,
            isp: null,
            isProxyOrHosting: null,
            headerLeakage: null,
            leakedHeaders: [],
            checkedAt: Date.now(),
            error: (error as Error).message || "Diagnostic check error",
          };
          job.failedCount = (job.failedCount ?? 0) + 1;
          job.results = [failedResult, ...job.results].slice(0, 500);
        }
        job.checked += 1;
        const now = Date.now();
        if (now - lastSavedAt >= persistIntervalMs) {
          lastSavedAt = now;
          save();
        }
      }
    }

    try {
      const concurrency = Math.max(1, Math.min(getConcurrency(), sample.length || 1));
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      job.status = "done";
      job.finishedAt = Date.now();
      save();
      return true;
    } catch (error) {
      job.status = "error";
      job.error = (error as Error).message;
      job.finishedAt = Date.now();
      save();
      return false;
    } finally {
      running = false;
    }
  }

  function stop() {
    if (!running) {
      if (job.status === "running") {
        job.status = job.checked > 0 ? "done" : "idle";
        job.finishedAt = Date.now();
        save();
        return true;
      }
      return false;
    }
    running = false;
    job.status = "done";
    job.finishedAt = Date.now();
    save();
    return true;
  }

  return {
    files,
    getJob: () => ({
      ...job,
      status: running ? "running" : (job.status === "running" ? (job.checked > 0 ? "done" : "idle") : job.status),
      running,
    }),
    run,
    stop,
    isRunning: () => running,
  };
}
