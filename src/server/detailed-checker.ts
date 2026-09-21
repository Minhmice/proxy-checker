import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { DiagnosticJob, ParsedProxy } from "../lib/types.js";
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

  constructor(socket: net.Socket | tls.TLSSocket) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.flush();
    });
    socket.on("end", () => this.flush());
    socket.on("error", (error: Error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      if (this.buffer.length >= waiter.length) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        const chunk = this.buffer.subarray(0, waiter.length);
        this.buffer = this.buffer.subarray(waiter.length);
        waiter.resolve(chunk);
      }
    }
  }

  read(length: number, timeout = 7000): Promise<Buffer> {
    if (this.buffer.length >= length) {
      const chunk = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      return Promise.resolve(chunk);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((item) => item.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("read timeout"));
      }, timeout);
      this.waiters.push({
        length,
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  async until(marker: Buffer, maximum = 65536, timeout = 7000): Promise<Buffer> {
    const started = Date.now();
    while (!this.buffer.includes(marker)) {
      if (this.buffer.length > maximum) throw new Error("response headers too large");
      if (Date.now() - started > timeout) throw new Error("read timeout");
      await new Promise<void>((resolve, reject) => {
        const check = () => resolve();
        this.waiters.push({
          length: this.buffer.length + 1,
          resolve: check,
          reject,
        });
      });
    }
    const index = this.buffer.indexOf(marker) + marker.length;
    const chunk = this.buffer.subarray(0, index);
    this.buffer = this.buffer.subarray(index);
    return chunk;
  }
}

function connect(host: string, port: number, timeout: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("connect timeout"));
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function openTunnel(proxy: ParsedProxy, host: string, port: number, timeout: number): Promise<net.Socket> {
  const socket = await connect(proxy.host, proxy.port, timeout);
  const reader = new Reader(socket);
  if (proxy.protocol === "http") {
    const auth =
      proxy.username === null
        ? ""
        : `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ""}`).toString("base64")}\r\n`;
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
    const header = (await reader.until(Buffer.from("\r\n\r\n"), 65536, timeout)).toString("latin1");
    if (!/^HTTP\/\d\.\d 200\b/.test(header)) throw new Error(header.split("\r\n")[0]);
    return socket;
  }
  socket.write(Buffer.from([5, proxy.username === null ? 1 : 2, 0, ...(proxy.username === null ? [] : [2])]));
  const hello = await reader.read(2, timeout);
  if (hello[0] !== 5 || hello[1] === 255) throw new Error("SOCKS5 auth failed");
  if (hello[1] === 2) {
    if (proxy.username === null) throw new Error("SOCKS5 auth required");
    const user = Buffer.from(proxy.username);
    const pass = Buffer.from(proxy.password ?? "");
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const auth = await reader.read(2, timeout);
    if (auth[1] !== 0) throw new Error("SOCKS5 credentials rejected");
  }
  const domain = Buffer.from(host);
  const portBuffer = Buffer.alloc(2);
  portBuffer.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, portBuffer]));
  const reply = await reader.read(4, timeout);
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 connect reply ${reply[1]}`);
  const length = reply[3] === 1 ? 6 : reply[3] === 4 ? 18 : (await reader.read(1, timeout))[0] + 2;
  await reader.read(length, timeout);
  return socket;
}

interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

async function requestThrough(
  socket: net.Socket,
  host: string,
  requestPath: string,
  secure: boolean,
  timeout: number
): Promise<HttpResponse> {
  const activeSocket = secure ? tls.connect({ socket, servername: host, rejectUnauthorized: true }) : socket;
  if (secure) {
    await new Promise<void>((resolve, reject) => {
      activeSocket.once("secureConnect", () => resolve());
      activeSocket.once("error", reject);
    });
  }
  const reader = new Reader(activeSocket);
  activeSocket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
  const rawHeader = (await reader.until(Buffer.from("\r\n\r\n"), 65536, timeout)).toString("latin1");
  const [statusLine, ...headerLines] = rawHeader.split("\r\n").filter(Boolean);
  const statusMatch = statusLine.match(/^HTTP\/\d\.\d\s+(\d+)/);
  const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const chunks: Buffer[] = [];
  while (true) {
    try {
      const data = await reader.read(4096, 1200);
      if (!data.length) break;
      chunks.push(data);
    } catch {
      break;
    }
  }
  return { statusCode, headers, body: Buffer.concat(chunks).toString("utf8") };
}

function idFor(endpoint: string) {
  return Buffer.from(endpoint).toString("base64url");
}

export async function testProxyDetailed(proxy: ParsedProxy, timeout = 7000): Promise<DetailedDiagnosticResult> {
  const started = Date.now();
  let socket: net.Socket | null = null;
  let observedStatus: number | null = null;
  let observedData: Record<string, unknown> = {};
  const observedLeakage: string[] = [];

  try {
    socket = await openTunnel(proxy, "ip-api.com", 80, timeout);
    const ipResponse = await requestThrough(
      socket,
      "ip-api.com",
      "/json/?fields=status,message,country,isp,query,proxy,hosting",
      false,
      timeout
    );
    observedStatus = ipResponse.statusCode;
    try {
      observedData = JSON.parse(ipResponse.body) as Record<string, unknown>;
    } catch {
      /* ignore */
    }

    const leakHeaders = ["x-forwarded-for", "via", "forwarded", "x-real-ip"];
    for (const key of leakHeaders) {
      if (ipResponse.headers[key]) observedLeakage.push(key);
    }

    if (ipResponse.statusCode !== 200) {
      throw new Error(`Endpoint returned HTTP ${ipResponse.statusCode}`);
    }

    return {
      id: idFor(proxy.endpoint),
      endpoint: proxy.endpoint,
      protocol: proxy.protocol,
      status: "SUCCESS",
      statusCode: ipResponse.statusCode,
      latencyMs: Date.now() - started,
      exitIp: (observedData.query as string) || null,
      country: (observedData.country as string) || null,
      isp: (observedData.isp as string) || null,
      isProxyOrHosting: Boolean(observedData.proxy || observedData.hosting),
      headerLeakage: observedLeakage.length > 0,
      leakedHeaders: observedLeakage,
      checkedAt: Date.now(),
    };
  } catch (error) {
    return {
      id: idFor(proxy.endpoint),
      endpoint: proxy.endpoint,
      protocol: proxy.protocol,
      status: "FAILED",
      statusCode: observedStatus,
      latencyMs: Date.now() - started,
      exitIp: (observedData.query as string) || null,
      country: (observedData.country as string) || null,
      isp: (observedData.isp as string) || null,
      isProxyOrHosting: observedData.query ? Boolean(observedData.proxy || observedData.hosting) : null,
      headerLeakage: observedStatus === 200 ? observedLeakage.length > 0 : null,
      leakedHeaders: observedLeakage,
      checkedAt: Date.now(),
      error: (error as Error).message,
    };
  } finally {
    socket?.destroy();
  }
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
    job = {
      ...emptyJob(),
      ...parsed,
      passedCount: typeof parsed.passedCount === "number" ? parsed.passedCount : 0,
      failedCount: typeof parsed.failedCount === "number" ? parsed.failedCount : 0,
      sampleCount: typeof parsed.sampleCount === "number" ? parsed.sampleCount : null,
    };
  } catch {
    /* first run */
  }

  function files() {
    if (!fs.existsSync(inputDir)) return [];
    return fs
      .readdirSync(inputDir)
      .filter((name) => name.toLowerCase().endsWith(".txt"))
      .sort()
      .map((name) => {
        const text = fs.readFileSync(path.join(inputDir, name), "utf8");
        const seen = new Set<string>();
        for (const token of text.split(/[\s,;]+/)) {
          const proxy = parseProxy(token);
          if (proxy) seen.add(proxy.endpoint);
        }
        return { name, count: seen.size };
      });
  }

  function load(name?: string) {
    const available = files();
    const selected = name && available.some((file) => file.name === name) ? name : available[0]?.name;
    if (!selected) return [] as ParsedProxy[];
    const seen = new Set<string>();
    const result: ParsedProxy[] = [];
    const text = fs.readFileSync(path.join(inputDir, selected), "utf8");
    for (const token of text.split(/[\s,;]+/)) {
      const proxy = parseProxy(token);
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
      while (nextIndex < sample.length) {
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

  return { files, getJob: () => ({ ...job, running }), run, isRunning: () => running };
}
