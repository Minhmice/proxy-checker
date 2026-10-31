// Adaptive concurrency for the proxy scan. Pure logic: network and clocks are injected.
import { performance } from "node:perf_hooks";

export const RESOURCE_CODES = new Set(["EMFILE", "ENFILE", "ENOBUFS", "EADDRNOTAVAIL", "EAGAIN", "ENOMEM"]);

const LAG_LIMIT_MS = 250;
const RESOURCE_LIMIT = 3;
const SATURATION = 0.9;
const COOLDOWN_TICKS = 2;
const CALM_TICKS = 2;
const BACKLOG_FACTOR = 20; // queue at least 20x the limit: double instead of +10%

// Slow-connect signal. A successful connect that needed >= 900 ms almost always waited for a SYN retransmit
// (1 s on Windows). Dead hosts never succeed, so they cannot trigger it. Measured on 8,000 endpoints:
// share of slow successful connects was 3.9% at c=100, 9.5% at c=400, 18.6% at c=600.
export const SLOW_CONNECT_MS = 900;
export const SLOW_MIN_SAMPLES = 20;
export const SLOW_SHARE = 0.12;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function createLimiter({ name, start, min, max }) {
  const queue = [];
  const clamp = (n) => Math.max(min, Math.min(max, Math.floor(n)));
  const pump = () => {
    while (queue.length && limiter.inflight < limiter.limit) {
      limiter.inflight++;
      queue.shift()();
    }
  };
  const limiter = {
    name,
    min,
    max,
    limit: clamp(start),
    inflight: 0,
    peakLimit: clamp(start),
    get queued() {
      return queue.length;
    },
    setLimit(n) {
      limiter.limit = clamp(n);
      limiter.peakLimit = Math.max(limiter.peakLimit, limiter.limit);
      pump();
    },
    async run(fn) {
      if (limiter.inflight < limiter.limit && queue.length === 0) limiter.inflight++;
      else {
        const gate = Promise.withResolvers();
        queue.push(gate.resolve);
        pump();
        await gate.promise;
      }
      try {
        return await fn();
      } finally {
        limiter.inflight--;
        pump();
      }
    },
  };
  return limiter;
}

/**
 * @param {{ limiters: object[], globalCap?: number, reserved?: number, canary?: object, lag?: object, intervalMs?: number, now?: () => number }} opts
 */
export function createController({ limiters, globalCap = 1600, reserved = 2, canary, lag, intervalMs = 2000, now = Date.now }) {
  const budget = globalCap - reserved;
  const state = new Map(limiters.map((l) => [l.name, { calm: 0, cooldown: 0, decreases: [], sum: 0, ticks: 0 }]));
  let pendingResource = 0;
  let connects = 0;
  let slowConnects = 0;
  let timer = null;
  let busy = false;
  const trace = [];
  const startedAt = now();

  const controller = {
    noteError(code) {
      if (RESOURCE_CODES.has(code)) pendingResource++;
    },

    noteConnect(ms) {
      connects++;
      if (ms >= SLOW_CONNECT_MS) slowConnects++;
    },

    // One control decision from one set of signals. Dead or slow proxies never reach here.
    /** @param {{ resourceErrors?: number, congested?: boolean, loopLagMs?: number, canaryMs?: number | null }} [signals] */
    step({ resourceErrors = 0, congested = false, loopLagMs = 0, canaryMs = null } = {}) {
      const resource = resourceErrors + pendingResource;
      pendingResource = 0;
      let cause = null;
      const slowShare = connects >= SLOW_MIN_SAMPLES ? slowConnects / connects : null;
      connects = 0;
      slowConnects = 0;
      if (resource >= RESOURCE_LIMIT) cause = "resource";
      else if (slowShare !== null && slowShare >= SLOW_SHARE) cause = "slow-connect";
      else if (congested) cause = "congested";
      else if (loopLagMs > LAG_LIMIT_MS) cause = "loop-lag";

      const out = [];
      for (const l of limiters) {
        const s = state.get(l.name);
        let action = "hold";
        // A signal that arrives while the previous halving is still draining is ignored: the trace of a real
        // scan showed 440 -> 220 -> 110 -> 55 -> 50 on consecutive ticks from one congestion episode.
        // Socket-resource errors are the exception: the OS is refusing sockets right now.
        if (cause && (s.cooldown === 0 || cause === "resource")) {
          l.setLimit(l.limit / 2);
          s.cooldown = COOLDOWN_TICKS;
          s.calm = 0;
          s.decreases.push({ cause, limit: l.limit });
          action = "down";
        } else if (s.cooldown > 0) {
          s.cooldown--;
          s.calm = 0;
        } else if (l.queued > 0) {
          // Work is waiting, so the limit is the bottleneck. Slots can look idle at the sampling instant
          // because fast-failing connects free them between ticks; queue depth is the honest signal.
          s.calm++;
          if (s.calm >= CALM_TICKS) {
            const room = budget - limiters.reduce((n, x) => n + x.limit, 0);
            const steep = l.queued >= l.limit * BACKLOG_FACTOR && l.limit < l.max / 2;
            const want = steep ? l.limit : Math.max(5, Math.ceil(l.limit * 0.1));
            const inc = Math.min(want, l.max - l.limit, room);
            if (inc > 0) {
              l.setLimit(l.limit + inc);
              action = "up";
            }
            s.calm = 0;
          }
        } else s.calm = 0;
        s.sum += l.limit;
        s.ticks++;
        out.push({ name: l.name, action, limit: l.limit });
      }
      trace.push({
        at: now() - startedAt,
        cause,
        canaryMs,
        slowShare: slowShare === null ? null : Math.round(slowShare * 1000) / 10,
        loopLagMs: Math.round(loopLagMs),
        limiters: Object.fromEntries(limiters.map((l) => [l.name, { limit: l.limit, inflight: l.inflight, queued: l.queued }])),
      });
      return out;
    },

    async tick() {
      if (busy) return;
      busy = true;
      try {
        const sample = canary ? await canary.sample() : null;
        const loopLagMs = lag ? lag.p95Ms() : 0;
        lag?.reset();
        controller.step({ congested: sample?.congested ?? false, loopLagMs, canaryMs: sample?.medianMs ?? null });
      } finally {
        busy = false;
      }
    },

    start(ms = intervalMs) {
      timer = setInterval(() => controller.tick().catch(() => {}), ms);
      timer.unref();
    },

    stop() {
      clearInterval(timer);
      lag?.stop();
    },
    trace: () => trace.slice(),

    summary() {
      return Object.fromEntries(
        limiters.map((l) => {
          const s = state.get(l.name);
          return [
            l.name,
            { peak: l.peakLimit, avg: s.ticks ? Math.round(s.sum / s.ticks) : l.limit, final: l.limit, decreases: s.decreases },
          ];
        }),
      );
    },
  };
  return controller;
}

// connect(target, timeoutMs) resolves with connect latency in ms, or rejects.
export function createCanary({ connect, targets, timeoutMs = 1500 }) {
  let base = null;
  const measure = (target) => connect(target, timeoutMs).catch(() => null);
  return {
    setBaseline(ms) {
      base = ms;
    },
    async baseline() {
      const ok = [];
      for (let i = 0; i < 5; i++) {
        const ms = await measure(targets[i % targets.length]);
        if (ms !== null) ok.push(ms);
      }
      if (ok.length < 3) throw new Error("network-down");
      base = median(ok);
      return base;
    },
    async sample() {
      const ok = (await Promise.all(targets.map(measure))).filter((ms) => ms !== null);
      if (ok.length === 0) return { congested: true, medianMs: null, ok: 0 };
      const medianMs = median(ok);
      return { congested: base !== null && medianMs > Math.max(base * 3, base + 400), medianMs, ok: ok.length };
    },
  };
}

// monitorEventLoopDelay was measured on this machine: a 400 ms block produced p95 = 27 ms,
// so lateness of a 20 ms timer is measured directly instead.
export function createLoopLag(resolutionMs = 20) {
  let samples = [];
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    samples.push(Math.max(0, now - last - resolutionMs));
    last = now;
  }, resolutionMs);
  timer.unref();
  return {
    p95Ms() {
      if (samples.length === 0) return 0;
      const sorted = [...samples].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    },
    reset() {
      samples = [];
      last = performance.now();
    },
    stop: () => clearInterval(timer),
  };
}
