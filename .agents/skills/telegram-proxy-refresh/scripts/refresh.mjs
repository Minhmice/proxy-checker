#!/usr/bin/env node
// Refresh 9Router proxy pools from proxy lists downloaded by Telegram Desktop.
// Run from repo root: node --import tsx .agents/skills/telegram-proxy-refresh/scripts/refresh.mjs <cmd> [opts]
//   cmd: scan | apply | run (scan + apply) | selftest
//   --dir D       source folder (default ~/Downloads/Telegram Desktop)
//   --since DATE  only files modified on/after YYYY-MM-DD (default: today 00:00 local)
//   --out D       work folder (default %TEMP%/proxy-refresh-<today>)
//   --resume      reuse stage files whose fingerprint still matches
//   --dry-run     run: scan only, never touch 9Router
//   --max-new N   apply: refuse to create more than N new pools (default 200)
// Exit codes: 0 ok, 1 unexpected, 2 usage, 3 router overloaded (partial), 4 precondition or network failure.
// ponytail: socks4 dropped (0 passed in the first real run, router support unverified); add a socks4
// branch in tunnel() and kindOf() if 9Router is confirmed to accept it.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanary, createController, createLimiter, createLoopLag } from "./adaptive.mjs";
import { PreconditionError, RouterOverloaded, applyStable, createFileLedger, createRouterGate } from "./router-apply.mjs";

export const PIPELINE_VERSION = 2;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
/** @type {{ host: string, port: number, servername: string, ca: Buffer | string | undefined, path: string, status: number }} */
const GOOGLE = { host: "www.google.com", port: 443, servername: "www.google.com", ca: undefined, path: "/generate_204", status: 204 };
const MAX_FILE_BYTES = 20_000_000;

// ---------------------------------------------------------------- parsing (untrusted text)

export const kindOf = (name) => {
  const m = /^(http|https|socks5)\b/i.exec(name);
  return m ? (m[1].toLowerCase() === "https" ? "http" : m[1].toLowerCase()) : null;
};

export function publicV4(h) {
  const p = h.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, includes Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

const LINE = /^(?:(https?|socks4|socks5):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/i;

export function parseLine(raw, kind) {
  const t = raw.trim();
  if (!t) return null;
  const m = t.length > 300 ? null : LINE.exec(t);
  if (!m) return { reject: "format" };
  let protocol = (m[1] || kind).toLowerCase();
  if (protocol === "socks4") return { reject: "socks4" };
  if (protocol === "https") protocol = "http"; // https lists are HTTP proxies that allow CONNECT :443
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return { reject: "port" };
  if (!publicV4(m[2])) return { reject: "nonPublic" };
  return { protocol, host: m[2], port };
}

// Used by apply: stable.jsonl is data on disk, so it is validated again before any router write.
export function validateEntry(e) {
  if (!e || typeof e !== "object") throw new PreconditionError("entry is not an object");
  if (e.protocol !== "http" && e.protocol !== "socks5") throw new PreconditionError(`bad protocol ${e.protocol}`);
  if (typeof e.host !== "string" || !/^\d{1,3}(\.\d{1,3}){3}$/.test(e.host) || !publicV4(e.host))
    throw new PreconditionError(`bad host ${String(e.host).slice(0, 40)}`);
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) throw new PreconditionError(`bad port ${e.port}`);
}

export function collectFiles({ dir, since, maxBytes = MAX_FILE_BYTES }) {
  const accepted = [];
  const rejected = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const kind = /\.txt$/i.test(e.name) ? kindOf(e.name) : null;
    if (!kind) continue;
    const file = path.join(dir, e.name);
    const st = fs.lstatSync(file);
    if (st.mtime < since) continue;
    if (st.isSymbolicLink() || !st.isFile()) {
      rejected.push({ name: e.name, reason: "not-regular-file" });
      continue;
    }
    if (st.size > maxBytes) {
      rejected.push({ name: e.name, reason: "too-big" });
      continue;
    }
    accepted.push({ name: e.name, file, kind, size: st.size, mtimeMs: st.mtimeMs });
  }
  return { accepted, rejected };
}

export function parseFiles(files) {
  const byEp = new Map();
  const rejected = { format: 0, port: 0, nonPublic: 0, socks4: 0 };
  const rejectedFiles = [];
  let lines = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.file);
    if (buf.includes(0)) {
      rejectedFiles.push({ name: f.name, reason: "binary" });
      continue;
    }
    for (const raw of buf.toString("utf8").split(/\r?\n/)) {
      const r = parseLine(raw, f.kind);
      if (!r) continue;
      lines++;
      if (r.reject) {
        rejected[r.reject]++;
        continue;
      }
      const k = `${r.host}:${r.port}`;
      const x = byEp.get(k) ?? { host: r.host, port: r.port, protos: [] };
      if (!x.protos.includes(r.protocol)) x.protos.push(r.protocol);
      byEp.set(k, x);
    }
  }
  return { endpoints: [...byEp.values()], lines, rejected, rejectedFiles };
}

export function computeFingerprint(files, params) {
  const h = crypto.createHash("sha256");
  h.update(`v${PIPELINE_VERSION}\n${JSON.stringify(params)}\n`);
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) h.update(`${f.name}|${f.size}|${f.mtimeMs}\n`);
  return h.digest("hex");
}

// ---------------------------------------------------------------- sockets

// Every outbound connection goes through here, so the destination policy cannot be skipped.
/**
 * @param {{ allow?: (host: string) => boolean, onError?: (code: string) => unknown, onConnect?: (ms: number) => unknown, connect?: (port: number, host: string) => import("node:net").Socket }} [opts]
 */
export function createSocketGate({
  allow = (host) => publicV4(host),
  onError = () => {},
  onConnect = () => {},
  connect = (port, host) => net.createConnection({ port, host }),
} = {}) {
  return {
    open(host, port, ms) {
      if (!allow(host)) return Promise.reject(new Error(`non-public destination ${host}`));
      const t0 = Date.now();
      const s = connect(port, host);
      const done = Promise.withResolvers();
      const timer = setTimeout(() => {
        s.destroy();
        done.reject(new Error("connect timeout"));
      }, ms);
      s.once("connect", () => {
        clearTimeout(timer);
        onConnect(Date.now() - t0);
        done.resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        if (e.code) onError(e.code);
        s.destroy();
        done.reject(e);
      });
      return done.promise;
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readerFor(s, ms) {
  let buf = Buffer.alloc(0);
  let err = null;
  const queue = [];
  const pump = () => {
    while (queue.length) {
      if (err) {
        queue.shift().reject(err);
        continue;
      }
      const n = queue[0].take(buf);
      if (n < 0) break;
      const out = buf.subarray(0, n);
      buf = buf.subarray(n);
      queue.shift().resolve(out);
    }
  };
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > 16384) s.destroy();
    pump();
  };
  s.on("data", onData);
  s.on("error", (e) => {
    err = e;
    pump();
  });
  s.on("close", () => {
    err ??= new Error("closed");
    pump();
  });
  const take = (fn) => {
    const gate = Promise.withResolvers();
    queue.push({ take: fn, resolve: gate.resolve, reject: gate.reject });
    const timer = setTimeout(() => gate.reject(new Error("timeout")), ms);
    pump();
    return gate.promise.finally(() => clearTimeout(timer));
  };
  return {
    bytes: (n) => take((b) => (b.length >= n ? n : -1)),
    head: () => take((b) => ((i) => (i < 0 ? -1 : i + 4))(b.indexOf("\r\n\r\n"))),
    any: () => take((b) => (b.length > 0 ? b.length : -1)),
    detach: () => s.off("data", onData),
  };
}

async function tunnel(s, proto, target, ms) {
  const rd = readerFor(s, ms);
  if (proto === "socks5") {
    s.write(Buffer.from([5, 1, 0]));
    let h = await rd.bytes(2);
    if (h[0] !== 5 || h[1] !== 0) throw new Error("socks5 greeting/auth");
    const host = Buffer.from(target.host);
    s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([target.port >> 8, target.port & 255])]));
    h = await rd.bytes(4);
    if (h[0] !== 5 || h[1] !== 0) throw new Error("socks5 connect");
    const len = h[3] === 1 ? 4 : h[3] === 4 ? 16 : h[3] === 3 ? (await rd.bytes(1))[0] : -1;
    if (len < 0) throw new Error("socks5 addr");
    await rd.bytes(len + 2);
  } else {
    s.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n\r\n`);
    const line = (await rd.head()).toString("latin1").split("\r\n")[0];
    if (!/^HTTP\/\d(?:\.\d)?\s+200\b/i.test(line)) throw new Error("http connect");
  }
  rd.detach();
}

// Classify what answers on a port by sending a SOCKS5 greeting on a throwaway connection.
export async function sniff(ep, { open, sniffMs = 2000 }) {
  let s;
  try {
    s = await open(ep.host, ep.port, sniffMs);
    const rd = readerFor(s, sniffMs);
    s.write(Buffer.from([5, 1, 0]));
    const r = await rd.any();
    if (r.length >= 2 && r[0] === 5) return r[1] === 0 ? "socks5" : "reject";
    if (r.subarray(0, 5).toString("latin1") === "HTTP/") return "http";
    return null;
  } catch {
    return null;
  } finally {
    s?.destroy();
  }
}

// Strict TLS to the target through the proxy. Whole probe is bounded by deadlineMs; every socket is destroyed.
export async function probe(ep, proto, { open, target = GOOGLE, deadlineMs = 12000 }) {
  const t0 = Date.now();
  const opened = [];
  const work = (async () => {
    const raw = await open(ep.host, ep.port, Math.min(4000, deadlineMs));
    opened.push(raw);
    await tunnel(raw, proto, target, Math.min(3500, deadlineMs));
    const secure = tls.connect({
      socket: raw,
      servername: target.servername,
      ca: target.ca,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    opened.push(secure);
    secure.on("error", () => {});
    const hs = Promise.withResolvers();
    secure.once("secureConnect", hs.resolve);
    secure.once("error", hs.reject);
    await hs.promise;
    if (!secure.authorized) throw new Error(secure.authorizationError || "tls unauthorized");
    const issuer = secure.getPeerCertificate().issuer?.O ?? null;
    secure.write(`HEAD ${target.path} HTTP/1.1\r\nHost: ${target.servername}\r\nConnection: close\r\n\r\n`);
    const rd = readerFor(secure, Math.min(3000, deadlineMs));
    const head = (await rd.head()).toString("latin1");
    const code = Number(/^HTTP\/\d(?:\.\d)?\s+(\d+)/.exec(head)?.[1]);
    if (code !== target.status) throw new Error(`status ${code}`);
    return { ok: true, ms: Date.now() - t0, issuer };
  })();
  const deadline = Promise.withResolvers();
  const timer = setTimeout(() => deadline.reject(new Error("deadline")), deadlineMs);
  try {
    return await Promise.race([work, deadline.promise]);
  } catch (e) {
    work.catch(() => {});
    return { ok: false, error: String(e.message).slice(0, 60) };
  } finally {
    clearTimeout(timer);
    for (const s of opened) s.destroy();
  }
}

// ---------------------------------------------------------------- stage store (append-only, resumable)

export function createStageStore(dir, fingerprint, { resume }) {
  fs.mkdirSync(dir, { recursive: true });
  const open = new Map();
  const stageApi = (name) => {
    if (open.has(name)) return open.get(name);
    const file = path.join(dir, `${name}.jsonl`);
    const records = new Map();
    let usable = false;
    if (resume && fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      try {
        const header = JSON.parse(lines[0] ?? "null");
        usable = header?.fingerprint === fingerprint;
        if (usable)
          for (const l of lines.slice(1)) {
            try {
              const r = JSON.parse(l);
              records.set(r.key, r);
            } catch {
              // a torn last line from a crash: drop it, the endpoint is redone
            }
          }
      } catch {
        usable = false;
      }
    }
    if (!usable) fs.writeFileSync(file, `${JSON.stringify({ fingerprint })}\n`);
    else if (!fs.readFileSync(file, "utf8").endsWith("\n")) fs.appendFileSync(file, "\n");
    const api = {
      has: (key) => records.has(key),
      get: (key) => records.get(key),
      all: () => [...records.values()],
      put(rec) {
        records.set(rec.key, rec);
        fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      },
    };
    open.set(name, api);
    return api;
  };
  return { stage: stageApi, closeAll: () => open.clear() };
}

// ---------------------------------------------------------------- pipeline

const pool = async (items, limiter, fn) => Promise.all(items.map((it) => limiter.run(() => fn(it))));

export async function scanEndpoints({ endpoints, deps }) {
  const { open, target = GOOGLE, limiters, store, deadlineMs = 12000, sniffMs = 2000, tcpMs = 2500, pauseMs = 300, log = () => {} } = deps;
  /** @type {Record<string, number>} */
  const timings = {};
  /** @type {Record<string, number>} */
  const issuers = {};
  const keyOf = (ep) => `${ep.host}:${ep.port}`;
  const clock = (name) => {
    const t0 = Date.now();
    return () => {
      timings[name] = (Date.now() - t0) / 1000;
    };
  };

  // Stage 1: TCP connect.
  const tcpStage = store.stage("tcp");
  let end = clock("tcp");
  await pool(endpoints.filter((ep) => !tcpStage.has(keyOf(ep))), limiters.tcp, async (ep) => {
    let ok = false;
    try {
      (await open(ep.host, ep.port, tcpMs)).destroy();
      ok = true;
    } catch {
      ok = false;
    }
    tcpStage.put({ key: keyOf(ep), ok });
  });
  end();
  const openEps = endpoints.filter((ep) => tcpStage.get(keyOf(ep))?.ok);
  log(`tcp open ${openEps.length}/${endpoints.length}`);

  // Stage 2: sniff once, then two strict TLS rounds with the sniffed (or listed) protocol.
  const tlsStage = store.stage("tls");
  end = clock("tls");
  await pool(openEps.filter((ep) => !tlsStage.has(keyOf(ep))), limiters.tls, async (ep) => {
    const kind = await sniff(ep, { open, sniffMs });
    const protos = kind === "reject" ? [] : kind ? [kind] : ep.protos;
    for (const proto of protos) {
      if (kind && !ep.protos.includes(proto) && kind !== "socks5" && kind !== "http") continue;
      const a = await probe(ep, proto, { open, target, deadlineMs });
      if (!a.ok) continue;
      if (pauseMs) await sleep(pauseMs);
      const b = await probe(ep, proto, { open, target, deadlineMs });
      if (b.ok) {
        tlsStage.put({ key: keyOf(ep), ok: true, protocol: proto, host: ep.host, port: ep.port, issuer: a.issuer });
        return;
      }
    }
    tlsStage.put({ key: keyOf(ep), ok: false });
  });
  end();
  const tlsPass = openEps.filter((ep) => tlsStage.get(keyOf(ep))?.ok).map((ep) => tlsStage.get(keyOf(ep)));
  log(`tls pass ${tlsPass.length}`);

  // Stage 3: three more rounds; all must pass and the issuer must not change between rounds.
  const stabStage = store.stage("stability");
  end = clock("stability");
  await pool(tlsPass.filter((c) => !stabStage.has(c.key)), limiters.stab, async (c) => {
    const rounds = [];
    for (let k = 0; k < 3; k++) {
      rounds.push(await probe(c, c.protocol, { open, target, deadlineMs }));
      if (pauseMs) await sleep(pauseMs);
    }
    const same = rounds.every((r) => r.ok && r.issuer === rounds[0].issuer && r.issuer === c.issuer);
    stabStage.put({
      key: c.key,
      ok: same,
      host: c.host,
      port: c.port,
      protocol: c.protocol,
      issuer: c.issuer,
      avgMs: same ? Math.round(rounds.reduce((a, r) => a + r.ms, 0) / rounds.length) : null,
    });
  });
  end();

  const stable = tlsPass
    .map((c) => stabStage.get(c.key))
    .filter((r) => r?.ok)
    .sort((a, b) => a.avgMs - b.avgMs)
    .map(({ host, port, protocol, issuer, avgMs }) => ({ host, port, protocol, issuer, avgMs }));
  for (const s of stable) issuers[s.issuer ?? "unknown"] = (issuers[s.issuer ?? "unknown"] ?? 0) + 1;
  return {
    stable,
    issuers,
    timings,
    counts: { endpoints: endpoints.length, tcpOpen: openEps.length, tlsPass2: tlsPass.length, stable: stable.length },
  };
}

// ---------------------------------------------------------------- CLI

// --since: YYYY-MM-DD (midnight), HH:MM (today), or "YYYY-MM-DD HH:MM"; all local time.
export function parseSince(v, today = new Date().toLocaleDateString("sv")) {
  const m = /^(?:(\d{4}-\d{2}-\d{2})[ T])?(\d{2}:\d{2})$/.exec(v) ?? /^(\d{4}-\d{2}-\d{2})$/.exec(v);
  const iso = !m ? "" : m.length === 2 ? `${m[1]}T00:00:00` : `${m[1] ?? today}T${m[2]}:00`;
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) throw Object.assign(new Error("--since must be YYYY-MM-DD, HH:MM or 'YYYY-MM-DD HH:MM'"), { exitCode: 2 });
  return d;
}

function parseArgs(argv) {
  const first = argv[0];
  const cmd = first && !first.startsWith("--") ? first : "run";
  const val = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
  const today = new Date().toLocaleDateString("sv");
  const since = parseSince(val("since") ?? today);
  const maxNew = Number(val("max-new", "200"));
  if (!Number.isInteger(maxNew) || maxNew < 0) throw Object.assign(new Error("--max-new must be a non-negative integer"), { exitCode: 2 });
  return {
    cmd,
    dir: val("dir", path.join(os.homedir(), "Downloads", "Telegram Desktop")),
    since,
    out: val("out", path.join(os.tmpdir(), `proxy-refresh-${today}`)),
    resume: argv.includes("--resume"),
    dryRun: argv.includes("--dry-run"),
    maxNew,
  };
}

const log = (...a) => console.error("[refresh]", ...a);

async function runScan(o) {
  fs.mkdirSync(o.out, { recursive: true });
  const { accepted, rejected: rejectedByName } = collectFiles({ dir: o.dir, since: o.since });
  const parsed = parseFiles(accepted);
  const fingerprint = computeFingerprint(accepted, { target: GOOGLE.host, version: PIPELINE_VERSION });
  log(`files=${accepted.length} lines=${parsed.lines} endpoints=${parsed.endpoints.length}`);

  const canary = createCanary({
    connect: (t, ms) =>
      new Promise((res, rej) => {
        const t0 = Date.now();
        const s = net.createConnection({ host: t, port: 443 });
        s.setTimeout(ms, () => (s.destroy(), rej(new Error("timeout"))));
        s.once("connect", () => (s.destroy(), res(Date.now() - t0)));
        s.once("error", rej);
      }),
    targets: ["1.1.1.1", "8.8.8.8"],
  });
  await canary.baseline(); // throws "network-down" before any proxy connection is opened
  // ponytail: TCP ceiling 400. On 8,000 endpoints, c=600 lost 34-56% of live endpoints in two runs and ~10% in a
  // third; c=1500 lost 69%. Mostly-lost runs and clean runs could not be told apart in advance. Raise only with a
  // measurement on this network that shows loss near the noise floor (~4%).
  const limiters = {
    tcp: createLimiter({ name: "tcp", start: 200, min: 50, max: 400 }),
    tls: createLimiter({ name: "tls", start: 60, min: 20, max: 400 }),
    stab: createLimiter({ name: "stab", start: 20, min: 20, max: 20 }),
  };
  const controller = createController({ limiters: Object.values(limiters), canary, lag: createLoopLag() });
  const gate = createSocketGate({ onError: (c) => controller.noteError(c), onConnect: (ms) => controller.noteConnect(ms) });
  const store = createStageStore(o.out, fingerprint, { resume: o.resume });
  controller.start();
  let result;
  try {
    result = await scanEndpoints({
      endpoints: parsed.endpoints,
      deps: { open: gate.open, target: GOOGLE, limiters, store, log },
    });
  } finally {
    controller.stop();
  }
  const controllerSummary = controller.summary();
  fs.writeFileSync(path.join(o.out, "controller-trace.json"), JSON.stringify(controller.trace()));
  fs.writeFileSync(
    path.join(o.out, "stable.jsonl"),
    [JSON.stringify({ fingerprint }), ...result.stable.map((s) => JSON.stringify(s))].join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(o.out, "state.json"),
    JSON.stringify({ fingerprint, version: PIPELINE_VERSION, finishedAt: new Date().toISOString(), counts: result.counts }),
  );
  store.closeAll();
  return {
    fingerprint,
    files: accepted.length,
    rejectedFiles: [...rejectedByName, ...parsed.rejectedFiles],
    lines: parsed.lines,
    rejected: parsed.rejected,
    ...result.counts,
    timings: result.timings,
    issuers: result.issuers,
    controller: controllerSummary,
    candidates: result.stable.slice(0, 50).map((x) => `${x.protocol}://${x.host}:${x.port} ${x.avgMs}ms`),
  };
}

function readStable(o) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(o.out, "state.json"), "utf8"));
  } catch {
    throw new PreconditionError("state.json missing: the scan did not finish");
  }
  const lines = fs.readFileSync(path.join(o.out, "stable.jsonl"), "utf8").split("\n").filter(Boolean);
  if (JSON.parse(lines[0]).fingerprint !== state.fingerprint) throw new PreconditionError("stable.jsonl does not match state.json");
  return lines.slice(1).map((l) => JSON.parse(l));
}

async function runApply(o) {
  const stable = readStable(o);
  const load = (f) => import(pathToFileURL(path.join(ROOT, f)).href);
  await load("src/server/load-env.ts");
  const router = await load("src/server/nine-router-client.ts");
  const gate = createRouterGate({});
  const ledger = createFileLedger(path.join(o.out, "apply.jsonl"));
  try {
    return await applyStable({ stable, router, gate, ledger, validate: validateEntry, maxNew: o.maxNew, log });
  } catch (e) {
    if (e instanceof RouterOverloaded)
      return { partial: true, error: e.message, router: gate.stats(), resume: "rerun `apply` with the same --out; the ledger resumes safely" };
    throw e;
  }
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (o.cmd === "selftest") {
    const { selftest } = await import("./selftest.mjs");
    selftest({ parseLine, kindOf, validateEntry, parseSince });
    return 0;
  }
  if (!["scan", "apply", "run"].includes(o.cmd)) {
    console.error(`unknown command: ${o.cmd}`);
    return 2;
  }
  const summary = {};
  try {
    if (o.cmd !== "apply") Object.assign(summary, await runScan(o));
    if (o.cmd === "apply" || (o.cmd === "run" && !o.dryRun)) summary.router = await runApply(o);
  } catch (e) {
    if (e instanceof PreconditionError || e.message === "network-down") {
      console.error(e.message);
      return 4;
    }
    throw e;
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary.router?.partial ? 3 : 0;
}

async function bootstrap() {
  let code = 1;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    console.error(String(e?.stack ?? e));
  }
  process.exitCode = code;
  // Destroyed sockets need a moment to finish closing; process.exit() mid-close aborts libuv on Windows.
  await sleep(500);
  setTimeout(() => {
    console.error("[refresh] a handle kept the process alive; forcing exit");
    process.exit(code);
  }, 10_000).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) bootstrap();
