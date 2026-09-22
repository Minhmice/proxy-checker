import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import type { CheckResult, ParsedProxy } from "../lib/types.js";
import { getSettingsSecrets } from "./app-config.js";
import { testProxyDetailed } from "./detailed-checker.js";
import { parseProxy } from "./proxy-core.js";


function checkTimeoutMs() {
  return getSettingsSecrets().checkTimeoutMs;
}

function once(emitter: NodeJS.EventEmitter, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    emitter.once(event, resolve);
    emitter.once("error", reject);
  });
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

class Reader {
  buffer = Buffer.alloc(0);
  waiters: Array<{ length: number; resolve: (data: Buffer) => void; reject: (error: Error) => void }> = [];
  events: Array<() => void> = [];

  constructor(socket: net.Socket | tls.TLSSocket) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.flush();
      for (const resolve of this.events.splice(0)) resolve();
    });
    socket.on("end", () => this.flush());
    socket.on("error", (error: Error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      if (this.buffer.length < waiter.length) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      const data = this.buffer.subarray(0, waiter.length);
      this.buffer = this.buffer.subarray(waiter.length);
      waiter.resolve(data);
    }
  }

  read(length: number, timeout = checkTimeoutMs()): Promise<Buffer> {
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
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new Error("read timeout"));
        }
      }, timeout);
    });
  }

  async until(marker: Buffer, maximum = 65536, timeout = checkTimeoutMs()): Promise<Buffer> {
    const deadline = Date.now() + timeout;
    while (!this.buffer.includes(marker)) {
      if (this.buffer.length > maximum) throw new Error("response headers too large");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("read timeout");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.events.indexOf(onData);
          if (index >= 0) this.events.splice(index, 1);
          reject(new Error("read timeout"));
        }, remaining);
        const onData = () => {
          clearTimeout(timer);
          resolve();
        };
        this.events.push(onData);
      });
    }
    const index = this.buffer.indexOf(marker) + marker.length;
    const data = this.buffer.subarray(0, index);
    this.buffer = this.buffer.subarray(index);
    return data;
  }
}

async function exitIp(socket: net.Socket, reader: Reader, host: string, timeout: number): Promise<string> {
  const secure = tls.connect({ socket, servername: host, rejectUnauthorized: true });
  await once(secure, "secureConnect");
  const tlsReader = new Reader(secure);
  secure.write(`GET /?format=json HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nAccept: application/json\r\n\r\n`);
  const header = (await tlsReader.until(Buffer.from("\r\n\r\n"), 65536, timeout)).toString("latin1");
  if (!header.startsWith("HTTP/1.1 200") && !header.startsWith("HTTP/1.0 200")) {
    throw new Error(header.split("\r\n")[0]);
  }
  await Promise.race([
    once(secure, "end"),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error("response timeout")), timeout)),
  ]);
  const raw = tlsReader.buffer.toString("utf8").trim();
  const ip = (JSON.parse(raw) as { ip: string }).ip;
  if (!net.isIP(ip)) throw new Error("invalid exit IP");
  return ip;
}

export async function checkProxy(proxy: ParsedProxy, timeout = checkTimeoutMs()): Promise<CheckResult> {
  const result = await testProxyDetailed(proxy, timeout);
  return {
    endpoint: result.endpoint,
    protocol: result.protocol,
    status: result.status === "SUCCESS" ? "usable" : "dead",
    exit_ip: result.exitIp,
    latency_ms: result.latencyMs,
    checked_at: result.checkedAt,
    successes: result.status === "SUCCESS" ? 1 : 0,
    failures: result.status === "FAILED" ? 1 : 0,
    last_error: result.error ?? "",
  };
}

export async function checkMany(
  proxies: ParsedProxy[],
  concurrency = 10,
  callbacks?: {
    onProgress?: (checked: number, total: number) => void;
    onStart?: (index: number) => void;
    onResult?: (index: number, result: CheckResult) => void;
  }
): Promise<CheckResult[]> {
  const results: CheckResult[] = new Array(proxies.length);
  let index = 0;
  let completed = 0;
  async function worker() {
    while (index < proxies.length) {
      const current = index++;
      callbacks?.onStart?.(current);
      results[current] = await checkProxy(proxies[current]);
      callbacks?.onResult?.(current, results[current]);
      completed += 1;
      callbacks?.onProgress?.(completed, proxies.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length || 1) }, () => worker()));
  return results;
}

export function createInputChecker({
  inputDir,
  dataDir,
  getTtlMs,
}: {
  inputDir: string;
  dataDir: string;
  getTtlMs: () => number;
}) {
  const historyFile = path.join(dataDir, "proxies.json");
  let running = false;

  function loadProxies(): ParsedProxy[] {
    if (!fs.existsSync(inputDir)) return [];
    const seen = new Set<string>();
    const result: ParsedProxy[] = [];
    for (const name of fs.readdirSync(inputDir).filter((x) => x.endsWith(".txt")).sort()) {
      const text = fs.readFileSync(path.join(inputDir, name), "utf8");
      for (const token of text.split(/[\s,;]+/)) {
        const proxy = parseProxy(token);
        if (proxy && !seen.has(proxy.endpoint)) {
          seen.add(proxy.endpoint);
          result.push(proxy);
        }
      }
    }
    return result;
  }

  function readHistory(): Record<string, CheckResult & { successes: number; failures: number }> {
    try {
      return JSON.parse(fs.readFileSync(historyFile, "utf8")) as Record<
        string,
        CheckResult & { successes: number; failures: number }
      >;
    } catch {
      return {};
    }
  }

  function writeHistory(value: Record<string, CheckResult & { successes: number; failures: number }>) {
    fs.mkdirSync(dataDir, { recursive: true });
    const temp = `${historyFile}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(value, null, 2));
    fs.renameSync(temp, historyFile);
  }

  async function runChecks(force = false) {
    if (running) return false;
    running = true;
    try {
      const history = readHistory();
      const ttlMs = getTtlMs();
      const todo = loadProxies().filter(
        (proxy) =>
          force ||
          !history[proxy.endpoint] ||
          history[proxy.endpoint].status !== "usable" ||
          Date.now() - history[proxy.endpoint].checked_at > ttlMs
      );
      for (const proxy of todo) {
        const result = await checkProxy(proxy);
        const previous = history[proxy.endpoint] ?? { successes: 0, failures: 0 };
        history[proxy.endpoint] = {
          ...result,
          successes: previous.successes + result.successes,
          failures: previous.failures + result.failures,
        };
        writeHistory(history);
      }
      return true;
    } finally {
      running = false;
    }
  }

  function best() {
    return Object.values(readHistory())
      .filter((item) => item.status === "usable")
      .sort((a, b) => a.latency_ms - b.latency_ms || b.successes - a.successes);
  }

  function isRunning() {
    return running;
  }

  return { loadProxies, readHistory, runChecks, best, isRunning };
}
