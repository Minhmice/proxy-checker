import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as tick, setTimeout as wait } from "node:timers/promises";
import tls from "node:tls";

import * as adaptive from "../.agents/skills/telegram-proxy-refresh/scripts/adaptive.mjs";
import * as routerApply from "../.agents/skills/telegram-proxy-refresh/scripts/router-apply.mjs";
import * as refresh from "../.agents/skills/telegram-proxy-refresh/scripts/refresh.mjs";

const calm = { resourceErrors: 0, congested: false, loopLagMs: 0 };

function ctl(opts: Record<string, unknown> = {}) {
  const tcp = adaptive.createLimiter({ name: "tcp", start: 200, min: 50, max: 1500 });
  const tlsLim = adaptive.createLimiter({ name: "tls", start: 60, min: 20, max: 400 });
  const c = adaptive.createController({ limiters: [tcp, tlsLim], ...opts });
  return { c, tcp, tls: tlsLim };
}

describe("limiter", () => {
  it("never runs more than `limit` at once and wakes queued work when raised", async () => {
    const l = adaptive.createLimiter({ name: "t", start: 2, min: 1, max: 10 });
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const job = () =>
      l.run(async () => {
        running++;
        peak = Math.max(peak, running);
        const gate = Promise.withResolvers<void>();
        release.push(gate.resolve);
        await gate.promise;
        running--;
      });
    const all = Promise.all([job(), job(), job(), job()]);
    await tick();
    assert.equal(running, 2);
    l.setLimit(4);
    await tick();
    assert.equal(running, 4);
    while (release.length) release.shift()?.();
    await all;
    assert.equal(peak, 4);
    assert.equal(l.inflight, 0);
  });

  it("clamps setLimit to min and max", () => {
    const l = adaptive.createLimiter({ name: "t", start: 5, min: 2, max: 8 });
    l.setLimit(100);
    assert.equal(l.limit, 8);
    l.setLimit(0);
    assert.equal(l.limit, 2);
  });

  it("reports how many jobs are waiting in queued", async () => {
    const l = adaptive.createLimiter({ name: "t", start: 1, min: 1, max: 5 });
    const release: Array<() => void> = [];
    const job = () =>
      l.run(async () => {
        const gate = Promise.withResolvers<void>();
        release.push(gate.resolve);
        await gate.promise;
      });
    const all = Promise.all([job(), job(), job()]);
    await tick();
    assert.equal(l.inflight, 1);
    assert.equal(l.queued, 2);
    while (release.length || l.queued) {
      release.shift()?.();
      await tick();
    }
    await all;
    assert.equal(l.queued, 0);
  });

  it("releases the slot when the job throws", async () => {
    const l = adaptive.createLimiter({ name: "t", start: 1, min: 1, max: 1 });
    await assert.rejects(
      l.run(async () => {
        throw new Error("boom");
      }),
    );
    assert.equal(l.inflight, 0);
    assert.equal(await l.run(async () => 7), 7);
  });
});

describe("controller.step", () => {
  it("halves every limiter on resource errors, congestion and loop lag", () => {
    for (const sig of [
      { ...calm, resourceErrors: 3 },
      { ...calm, congested: true },
      { ...calm, loopLagMs: 300 },
    ]) {
      const { c, tcp, tls } = ctl();
      const out = c.step(sig);
      assert.equal(tcp.limit, 100);
      assert.equal(tls.limit, 30);
      assert.ok(out.every((o: { action: string }) => o.action === "down"));
    }
  });

  it("does not decrease on fewer than 3 resource errors (dead proxies are not a signal)", () => {
    const { c, tcp } = ctl();
    tcp.inflight = tcp.limit;
    c.step({ ...calm, resourceErrors: 2 });
    c.step({ ...calm, resourceErrors: 2 });
    assert.ok(tcp.limit >= 200);
    assert.equal(c.summary().tcp.decreases.length, 0);
  });

  it("never goes below min", () => {
    const { c, tcp, tls } = ctl();
    for (let i = 0; i < 12; i++) {
      c.step({ ...calm, congested: true });
      c.step(calm);
      c.step(calm);
    }
    assert.equal(tcp.limit, 50);
    assert.equal(tls.limit, 20);
  });

  it("grows only after 2 calm ticks with a backlog, by max(5, 10%)", () => {
    const { c, tcp } = ctl();
    Object.defineProperty(tcp, "queued", { value: 50, configurable: true });
    c.step(calm);
    assert.equal(tcp.limit, 200, "one calm tick is not enough");
    c.step(calm);
    assert.equal(tcp.limit, 220);
  });

  it("does not grow when below 90% saturation", () => {
    const { c, tcp } = ctl();
    tcp.inflight = 100;
    c.step(calm);
    c.step(calm);
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });

  it("grows when work is waiting even though slots look idle at the sampling instant (fast-failing connects)", () => {
    const { c, tcp } = ctl();
    tcp.inflight = 40;
    Object.defineProperty(tcp, "queued", { value: 5000, configurable: true });
    c.step(calm);
    c.step(calm);
    assert.ok(tcp.limit > 200, `limit ${tcp.limit}`);
  });

  it("does not grow when the queue is empty, however busy the slots look", () => {
    const { c, tcp } = ctl();
    tcp.inflight = 200;
    Object.defineProperty(tcp, "queued", { value: 0, configurable: true });
    c.step(calm);
    c.step(calm);
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });

  it("grows faster while a large backlog exists and the limit is far below max", () => {
    const { c, tcp } = ctl();
    Object.defineProperty(tcp, "queued", { value: 100_000, configurable: true });
    const before = tcp.limit;
    c.step(calm);
    c.step(calm);
    assert.ok(tcp.limit >= before * 1.5, `${before} -> ${tcp.limit}`);
  });

  it("holds for 2 ticks after a decrease", () => {
    const { c, tcp } = ctl();
    Object.defineProperty(tcp, "queued", { value: 50, configurable: true });
    c.step({ ...calm, congested: true });
    const after = tcp.limit;
    c.step(calm);
    c.step(calm);
    assert.equal(tcp.limit, after, "cooldown");
    c.step(calm);
    c.step(calm);
    assert.ok(tcp.limit > after, "grows after cooldown plus 2 calm ticks");
  });

  it("clamps growth to max and to the global socket cap", () => {
    const a = adaptive.createLimiter({ name: "a", start: 90, min: 10, max: 100 });
    const b = adaptive.createLimiter({ name: "b", start: 60, min: 10, max: 100 });
    const c = adaptive.createController({ limiters: [a, b], globalCap: 160, reserved: 2 });
    a.inflight = 90;
    b.inflight = 60;
    c.step(calm);
    c.step(calm);
    assert.ok(a.limit <= 100 && b.limit <= 100);
    assert.ok(a.limit + b.limit <= 158, `sum ${a.limit + b.limit} within cap minus reserved`);
  });

  it("trace() records every step with cause, canary latency and per-limiter depth", () => {
    let t = 0;
    const lim = adaptive.createLimiter({ name: "tcp", start: 10, min: 2, max: 40 });
    const c = adaptive.createController({ limiters: [lim], now: () => t });
    t = 2000;
    c.step({ ...calm, canaryMs: 25 });
    t = 4000;
    c.step({ ...calm, congested: true, canaryMs: 900 });
    const trace = c.trace();
    assert.equal(trace.length, 2);
    assert.deepEqual([trace[0].at, trace[1].at], [2000, 4000]);
    assert.equal(trace[0].cause, null);
    assert.equal(trace[0].canaryMs, 25);
    assert.equal(trace[1].cause, "congested");
    assert.equal(trace[1].limiters.tcp.limit, 5);
    assert.equal(trace[1].limiters.tcp.queued, 0);
  });

  it("records decreases with their cause in summary()", () => {
    const { c } = ctl();
    c.step({ ...calm, resourceErrors: 5 });
    const s = c.summary();
    assert.equal(s.tcp.decreases.length, 1);
    assert.equal(s.tcp.decreases[0].cause, "resource");
    assert.ok(s.tcp.peak >= 200);
  });
});

describe("controller.noteError", () => {
  it("counts only resource error codes", () => {
    const { c, tcp } = ctl();
    for (const code of ["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET"]) c.noteError(code);
    c.step(calm);
    assert.equal(tcp.limit, 200);
    for (const code of ["EMFILE", "ENFILE", "EADDRNOTAVAIL"]) c.noteError(code);
    c.step(calm);
    assert.equal(tcp.limit, 100);
  });
});

describe("controller.noteConnect (slow-connect signal)", () => {
  const feed = (c: { noteConnect: (ms: number) => void }, slow: number, fast: number) => {
    for (let i = 0; i < slow; i++) c.noteConnect(adaptive.SLOW_CONNECT_MS);
    for (let i = 0; i < fast; i++) c.noteConnect(30);
  };

  it("halves when the share of slow successful connects reaches the threshold", () => {
    const { c, tcp } = ctl();
    const total = adaptive.SLOW_MIN_SAMPLES * 4;
    const slow = Math.ceil(total * adaptive.SLOW_SHARE);
    feed(c, slow, total - slow);
    c.step(calm);
    assert.equal(tcp.limit, 100);
    assert.equal(c.summary().tcp.decreases[0].cause, "slow-connect");
  });

  it("does not react just below the share threshold", () => {
    const { c, tcp } = ctl();
    const total = adaptive.SLOW_MIN_SAMPLES * 4;
    const slow = Math.ceil(total * adaptive.SLOW_SHARE) - 1;
    feed(c, slow, total - slow);
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });

  it("ignores a tick with too few successful connects to judge", () => {
    const { c, tcp } = ctl();
    feed(c, adaptive.SLOW_MIN_SAMPLES - 1, 0); // every one slow, but not enough of them
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });

  it("counts per tick: samples do not carry over to the next step", () => {
    const { c, tcp } = ctl();
    feed(c, adaptive.SLOW_MIN_SAMPLES - 1, 0);
    c.step(calm);
    feed(c, 1, 0);
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });

  it("connects just under the slow threshold are fast", () => {
    const { c, tcp } = ctl();
    for (let i = 0; i < adaptive.SLOW_MIN_SAMPLES * 4; i++)
      c.noteConnect(adaptive.SLOW_CONNECT_MS - 1);
    c.step(calm);
    assert.equal(tcp.limit, 200);
  });
});

describe("controller cooldown", () => {
  // The real trace showed 440 -> 220 -> 110 -> 55 -> 50 on consecutive ticks: each halving fired
  // before the previous one could take effect, on a signal that was still draining.
  it("does not halve again while cooling down from the previous decrease", () => {
    const { c, tcp } = ctl();
    c.step({ ...calm, congested: true });
    assert.equal(tcp.limit, 100);
    c.step({ ...calm, congested: true });
    assert.equal(tcp.limit, 100, "second signal ignored during cooldown");
    c.step({ ...calm, congested: true });
    assert.equal(tcp.limit, 100, "still cooling down");
    c.step({ ...calm, congested: true });
    assert.equal(tcp.limit, 50, "reacts again once cooldown is over");
  });

  it("a resource-error storm still halves during cooldown (the OS is refusing sockets)", () => {
    const { c, tcp } = ctl();
    c.step({ ...calm, congested: true });
    c.step({ ...calm, resourceErrors: 10 });
    assert.equal(tcp.limit, 50);
  });
});

describe("canary", () => {
  it("baseline is the median of 5 samples", async () => {
    const samples = [10, 50, 30, 20, 40];
    let i = 0;
    const canary = adaptive.createCanary({ connect: async () => samples[i++ % 5], targets: ["a"] });
    assert.equal(await canary.baseline(), 30);
  });

  it("baseline throws network-down when fewer than 3 samples succeed", async () => {
    let i = 0;
    const canary = adaptive.createCanary({
      connect: async () => {
        if (i++ % 2 === 0) throw new Error("x");
        return 10;
      },
      targets: ["a"],
    });
    await assert.rejects(canary.baseline(), /network-down/);
  });

  it("flags congestion when every target fails", async () => {
    const canary = adaptive.createCanary({
      connect: async () => {
        throw new Error("down");
      },
      targets: ["a", "b"],
    });
    canary.setBaseline(20);
    assert.equal((await canary.sample()).congested, true);
  });

  it("flags congestion only above max(3 x baseline, baseline + 400 ms)", async () => {
    const at = async (latency: number, baseline: number) => {
      const canary = adaptive.createCanary({ connect: async () => latency, targets: ["a", "b"] });
      canary.setBaseline(baseline);
      return (await canary.sample()).congested;
    };
    assert.equal(await at(300, 20), false, "300 < 420");
    assert.equal(await at(500, 20), true, "500 > 420");
    assert.equal(await at(900, 400), false, "900 < max(1200, 800)");
  });

  it("one failing target out of two is not congestion", async () => {
    let n = 0;
    const canary = adaptive.createCanary({
      connect: async () => {
        if (n++ % 2 === 0) throw new Error("one down");
        return 20;
      },
      targets: ["a", "b"],
    });
    canary.setBaseline(20);
    assert.equal((await canary.sample()).congested, false);
  });
});

describe("loop lag", () => {
  // Real clock on purpose: the detector measures wall-clock timer lateness,
  // so fake timers cannot exercise it.
  it("reports a small p95 on an idle loop and a large one after blocking it", async () => {
    const lag = adaptive.createLoopLag();
    await wait(60);
    assert.ok(lag.p95Ms() < 100);
    lag.reset();
    const t = Date.now();
    while (Date.now() - t < 400);
    await wait(30);
    assert.ok(lag.p95Ms() > 100, `p95 ${lag.p95Ms()}`);
    lag.stop();
  });
});

// ---------------------------------------------------------------- router-apply

type Pool = { id: string; name: string; proxyUrl: string; isActive: boolean };

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
  sleeps: number[];
}

interface FakeRouter {
  pools: Pool[];
  calls: string[];
  listPools: () => Promise<Pool[]>;
  createPool: (input: {
    name: string;
    proxyUrl: string;
    isActive: boolean;
  }) => Promise<{ id: string; name: string; proxyUrl: string }>;
  testPool: (id: string) => Promise<{ ok: boolean; elapsedMs: number }>;
  deletePool: (id: string) => Promise<void>;
  setPoolActive: (id: string, active: boolean) => Promise<void>;
}

class HttpError extends Error {
  constructor(public status: number) {
    super(`HTTP ${status}`);
  }
}

function fakeClock(): FakeClock {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

function gateWith(clock: FakeClock, extra: Record<string, unknown> = {}) {
  return routerApply.createRouterGate({ now: clock.now, sleep: clock.sleep, ...extra });
}

function fakeRouter(
  seed: Pool[] = [],
  opts: {
    testOk?: (p: Pool) => boolean;
    onCall?: (kind: string) => void;
    activeOnCreate?: boolean;
  } = {},
): FakeRouter {
  const pools = [...seed];
  let n = 0;
  const calls: string[] = [];
  const router = {
    pools,
    calls,
    async listPools() {
      calls.push("list");
      opts.onCall?.("list");
      return pools.map((p) => ({ ...p }));
    },
    async createPool(input: { name: string; proxyUrl: string; isActive: boolean }) {
      calls.push("create");
      opts.onCall?.("create");
      const p = {
        id: `new-${++n}`,
        name: input.name,
        proxyUrl: input.proxyUrl,
        isActive: opts.activeOnCreate ?? false,
      };
      pools.push(p);
      return { id: p.id, name: p.name, proxyUrl: p.proxyUrl };
    },
    async testPool(id: string) {
      calls.push("test");
      opts.onCall?.("test");
      const p = pools.find((x) => x.id === id);
      return { ok: opts.testOk ? opts.testOk(p as Pool) : true, elapsedMs: 5 };
    },
    async deletePool(id: string) {
      calls.push(`delete:${id}`);
      const i = pools.findIndex((x) => x.id === id);
      if (i >= 0) pools.splice(i, 1);
    },
    async setPoolActive(id: string, active: boolean) {
      calls.push(`active:${id}:${active}`);
      const p = pools.find((x) => x.id === id);
      if (p) p.isActive = active;
    },
  };
  return router;
}

const ep = (i: number) => ({
  host: `8.8.${Math.floor(i / 200)}.${(i % 200) + 1}`,
  port: 8000 + i,
  protocol: "http",
  avgMs: 100,
});
const base = (id: string, i: number): Pool => ({
  id,
  name: `base${i}`,
  proxyUrl: `http://9.9.9.${i}:80`,
  isActive: true,
});
const validate = (e: { protocol: string }) => {
  if (!["http", "socks5"].includes(e.protocol))
    throw new routerApply.PreconditionError(`bad protocol ${e.protocol}`);
};

describe("router gate", () => {
  it("never has more than 2 calls in flight", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    let running = 0;
    let peak = 0;
    const work = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 8 }, () => gate.call("list", work)));
    assert.equal(peak, 2);
    assert.equal(gate.stats().peakInflight, 2);
  });

  it("spaces mutating calls at least 150 ms apart", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await gate.call(
        "create",
        async () => {
          starts.push(clock.now());
        },
        { mutating: true },
      );
    }
    for (let i = 1; i < starts.length; i++)
      assert.ok(starts[i] - starts[i - 1] >= 150, `gap ${starts[i] - starts[i - 1]}`);
  });

  it("trips on HTTP 429 and pauses 30 s, then 60 s, then 120 s", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    const fail = async () => {
      throw new HttpError(429);
    };
    for (let k = 0; k < 3; k++) {
      await assert.rejects(gate.call("create", fail), HttpError);
      await gate.call("list", async () => 1).catch(() => {});
    }
    assert.deepEqual(
      clock.sleeps.filter((s: number) => s >= 30000),
      [30000, 60000, 120000],
    );
  });

  it("stops with RouterOverloaded on the fourth trip", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    const fail = async () => {
      throw new HttpError(503);
    };
    let thrown: unknown;
    for (let k = 0; k < 8 && !thrown; k++) {
      try {
        await gate.call("create", fail);
      } catch (e) {
        if (e instanceof routerApply.RouterOverloaded) thrown = e;
      }
    }
    assert.ok(thrown instanceof routerApply.RouterOverloaded);
  });

  it("trips after 5 transport failures in the last 10 calls", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 5; i++) await gate.call("list", async () => 1);
    for (let i = 0; i < 5; i++)
      await gate
        .call("list", async () => {
          throw new Error("ECONNRESET");
        })
        .catch(() => {});
    assert.equal(gate.stats().trips, 1);
  });

  it("does not trip on 4xx or on a failed test result", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 12; i++) {
      await gate
        .call("create", async () => {
          throw new HttpError(409);
        })
        .catch(() => {});
      await gate.call("test", async () => ({ ok: false }));
    }
    assert.equal(gate.stats().trips, 0);
  });

  it("trips when a kind's median latency exceeds 3x its own baseline", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 5; i++) await gate.call("list", async () => clock.advance(10));
    for (let i = 0; i < 6; i++) await gate.call("list", async () => clock.advance(100));
    assert.equal(gate.stats().trips, 1);
  });

  it("does not compare a slow test call against the fast list baseline", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    for (let i = 0; i < 5; i++) await gate.call("list", async () => clock.advance(10));
    for (let i = 0; i < 12; i++) await gate.call("test", async () => clock.advance(4000));
    assert.equal(gate.stats().trips, 0);
  });

  it("runs 1 call at a time for 10 calls after a trip", async () => {
    const clock = fakeClock();
    const gate = gateWith(clock);
    await assert.rejects(
      gate.call("create", async () => {
        throw new HttpError(429);
      }),
    );
    let running = 0;
    let peak = 0;
    const work = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => gate.call("list", work)));
    assert.equal(peak, 1);
  });
});

describe("applyStable", () => {
  const run = (stable: unknown[], router: FakeRouter, over: Record<string, unknown> = {}) => {
    const clock = fakeClock();
    return routerApply.applyStable({
      stable,
      router,
      gate: gateWith(clock),
      validate,
      ledger: routerApply.createMemoryLedger(),
      ...over,
    });
  };

  it("creates inactive, tests twice, keeps passes in reserve and never touches baseline pools", async () => {
    const router = fakeRouter([base("b1", 1), base("b2", 2)]);
    const res = await run([ep(1), ep(2), ep(3)], router);
    assert.equal(res.created, 3);
    assert.equal(res.kept.length, 3);
    assert.equal(router.pools.length, 5);
    assert.ok(router.pools.filter((p) => p.id.startsWith("new-")).every((p) => !p.isActive));
    assert.ok(!router.calls.some((c) => /^(delete|active):b/.test(c)), "baseline untouched");
    assert.equal(router.calls.filter((c) => c === "test").length, 6);
  });

  it("deletes owned pools that fail both tests and keeps flaky ones in reserve", async () => {
    const flip = new Map<string, number>();
    const router = fakeRouter([], {
      testOk: (p) => {
        if (p.proxyUrl.includes(":8001")) return false;
        if (p.proxyUrl.includes(":8002")) {
          const n = (flip.get(p.id) ?? 0) + 1;
          flip.set(p.id, n);
          return n === 1;
        }
        return true;
      },
    });
    const res = await run([ep(1), ep(2), ep(3)], router);
    assert.equal(res.deleted.length, 1);
    assert.equal(res.flaky.length, 1);
    assert.equal(res.kept.length, 1);
    assert.equal(router.pools.length, 2);
  });

  it("recognises an existing pool stored with an explicit or implicit default port", async () => {
    for (const stored of ["http://4.144.146.21:80", "http://4.144.146.21"]) {
      const e = { host: "4.144.146.21", port: 80, protocol: "http", avgMs: 100 };
      const router = fakeRouter([{ id: "x", name: "x", proxyUrl: stored, isActive: true }]);
      const res = await run(
        [e, { host: "34.43.46.91", port: 443, protocol: "http", avgMs: 100 }],
        router,
      );
      assert.equal(res.alreadyOnRouter, 1, stored);
      assert.equal(
        router.pools.filter((p) => p.proxyUrl.includes("4.144.146.21")).length,
        1,
        `${stored}: no duplicate created`,
      );
      assert.deepEqual(res.errors, [], stored);
    }
  });

  it("treats https :443 as the default port too", async () => {
    const router = fakeRouter([
      { id: "x", name: "x", proxyUrl: "https://5.5.5.5:443", isActive: true },
    ]);
    const res = await run([{ host: "5.5.5.5", port: 443, protocol: "http", avgMs: 1 }], router);
    assert.equal(res.alreadyOnRouter, 1);
  });
  it("skips endpoints already on the router", async () => {
    const e = ep(1);
    const router = fakeRouter([
      { id: "x", name: "x", proxyUrl: `http://${e.host}:${e.port}`, isActive: true },
    ]);
    const res = await run([e, ep(2)], router);
    assert.equal(res.alreadyOnRouter, 1);
    assert.equal(res.created, 1);
  });

  it("deactivates an owned pool the router left active, never a baseline one", async () => {
    const router = fakeRouter([base("b1", 1)], { activeOnCreate: true });
    await run([ep(1)], router);
    assert.ok(router.calls.includes("active:new-1:false"));
    assert.ok(!router.calls.includes("active:b1:false"));
    assert.equal(router.pools.find((p) => p.id === "b1")?.isActive, true);
  });

  it("rejects invalid or over-limit input before any write", async () => {
    const bad = fakeRouter();
    await assert.rejects(
      run([{ ...ep(1), protocol: "socks4" }], bad),
      routerApply.PreconditionError,
    );
    assert.equal(bad.calls.filter((c) => c === "create").length, 0);
    const many = fakeRouter();
    await assert.rejects(run([ep(1), ep(2), ep(3)], many, { maxNew: 2 }), /max-new|maxNew/);
    assert.equal(many.calls.filter((c) => c === "create").length, 0);
  });

  it("resume adopts an intent without created when the pool exists, retries when it does not", async () => {
    const e1 = ep(1);
    const e2 = ep(2);
    const ledger = routerApply.createMemoryLedger();
    ledger.append({ op: "baseline", ids: ["b1"] });
    ledger.append({ op: "intent", endpoint: `${e1.host}:${e1.port}` });
    ledger.append({ op: "intent", endpoint: `${e2.host}:${e2.port}` });
    const router = fakeRouter([
      base("b1", 1),
      { id: "orphan", name: "o", proxyUrl: `http://${e1.host}:${e1.port}`, isActive: false },
    ]);
    const res = await run([e1, e2], router, { ledger });
    assert.deepEqual(res.adopted, [`${e1.host}:${e1.port}`]);
    assert.equal(res.created, 1, "only the absent intent is created again");
    assert.equal(
      router.pools.filter((p) => p.proxyUrl.includes(`:${e1.port}`)).length,
      1,
      "no duplicate",
    );
  });

  it("does not adopt or delete a baseline pool even if an intent names its endpoint", async () => {
    const e = ep(1);
    const ledger = routerApply.createMemoryLedger();
    ledger.append({ op: "baseline", ids: ["b1"] });
    ledger.append({ op: "intent", endpoint: `${e.host}:${e.port}` });
    const router = fakeRouter(
      [{ id: "b1", name: "b", proxyUrl: `http://${e.host}:${e.port}`, isActive: true }],
      { testOk: () => false },
    );
    const res = await run([e], router, { ledger });
    assert.deepEqual(res.adopted, []);
    assert.ok(router.pools.some((p) => p.id === "b1"));
    assert.ok(!router.calls.some((c) => c.startsWith("delete")));
  });

  it("reports partial and persists progress when the router overloads", async () => {
    let creates = 0;
    const router = fakeRouter([], {
      onCall: (k) => {
        if (k === "create" && ++creates === 2) throw new HttpError(503);
      },
    });
    const ledger = routerApply.createMemoryLedger();
    await assert.rejects(
      run([ep(1), ep(2), ep(3), ep(4)], router, {
        ledger,
        gate: gateWith(fakeClock(), { pauses: [] }),
      }),
      routerApply.RouterOverloaded,
    );
    assert.ok(ledger.entries().some((e: { op: string }) => e.op === "created"));
  });

  it("reports a read-back mismatch as an error instead of fixing it silently", async () => {
    const router = fakeRouter();
    const origList = router.listPools.bind(router);
    let lists = 0;
    router.listPools = async () => {
      const out = await origList();
      return ++lists > 2 ? out.concat(out.slice(0, 1)) : out;
    };
    const res = await run([ep(1)], router);
    assert.ok(res.errors.some((e: string) => /read-back/i.test(e)));
  });
});

// ---------------------------------------------------------------- refresh.mjs

const fixture = (f: string) =>
  fs.readFileSync(path.join(import.meta.dirname, "fixtures", "proxy-refresh", f));

interface Fx {
  stop: () => Promise<void>;
  port: number;
}

interface ProxyFx extends Fx {
  sockets: Set<net.Socket>;
}

// TLS server standing in for www.google.com; `kind` picks which certificate it presents.
async function tlsServer(kind: "good" | "bad"): Promise<Fx> {
  const server = tls.createServer(
    { key: fixture(`${kind}.key`), cert: fixture(`${kind}.crt`) },
    (s) => {
      s.on("error", () => {});
      s.on("data", () => s.end("HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n"));
    },
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

type ProxyKind = "http" | "socks5" | "blackhole" | "http-403";

// Minimal HTTP CONNECT or SOCKS5 proxy that always relays to 127.0.0.1:<target>.
async function proxyServer(kind: ProxyKind, target: number): Promise<ProxyFx> {
  const sockets = new Set<net.Socket>();
  const relay = (client: net.Socket) => {
    const up = net.connect(target, "127.0.0.1");
    sockets.add(up);
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
    up.on("connect", () => {
      client.pipe(up);
      up.pipe(client);
    });
    client.on("close", () => up.destroy());
  };
  const server = net.createServer((c) => {
    sockets.add(c);
    c.on("error", () => {});
    c.on("close", () => sockets.delete(c));
    if (kind === "blackhole") {
      c.resume(); // read and discard, so the client's FIN is observed like a real silent peer
      return;
    }
    c.once("data", (d) => {
      if (kind === "http" || kind === "http-403") {
        if (!d.toString("latin1").startsWith("CONNECT ")) return c.destroy();
        if (kind === "http-403") return c.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        c.write("HTTP/1.1 200 Connection established\r\n\r\n");
        return relay(c);
      }
      if (d[0] !== 5) return c.destroy();
      c.write(Buffer.from([5, 0]));
      c.once("data", () => {
        c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        relay(c);
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    sockets,
    port: (server.address() as net.AddressInfo).port,
    stop: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// Answers the first bytes it receives with a fixed reply, or stays silent when reply is null.
async function replyServer(reply: Buffer | null): Promise<Fx> {
  const server = net.createServer((c) => {
    c.on("error", () => {});
    c.once("data", () => {
      if (reply) c.end(reply);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    stop: () => new Promise((r) => server.close(() => r())),
  };
}

const permissive = { allow: () => true };
const probeTarget = (port: number) => ({
  host: "127.0.0.1",
  port,
  servername: "localhost",
  ca: fixture("good.crt"),
  path: "/generate_204",
  status: 204,
});

describe("parser", () => {
  it("accepts public http and socks5, maps https lists to http", () => {
    assert.deepEqual(refresh.parseLine("1.2.3.4:8080", "http"), {
      protocol: "http",
      host: "1.2.3.4",
      port: 8080,
    });
    assert.equal(refresh.parseLine("https://1.2.3.4:443", "socks5")?.protocol, "http");
    assert.equal(refresh.parseLine("socks5://1.2.3.4:1080", "http")?.protocol, "socks5");
  });

  it("rejects private, loopback, CGNAT, link-local and malformed lines", () => {
    const reject = (l: string) => refresh.parseLine(l, "http")?.reject;
    for (const l of [
      "10.0.0.1:80",
      "127.0.0.1:1",
      "100.71.252.27:10001",
      "192.168.1.1:80",
      "169.254.169.254:80",
      "172.16.0.1:80",
      "999.1.1.1:80",
    ])
      assert.equal(reject(l), "nonPublic", l);
    for (const l of ["1.2.3.4:0", "1.2.3.4:70000"]) assert.equal(reject(l), "port", l);
    for (const l of [
      "evil.com:80",
      "1.2.3.4:80;rm -rf /",
      "\x1b[31m1.2.3.4:80",
      `1.2.3.4:80${"x".repeat(400)}`,
    ])
      assert.equal(reject(l), "format", l);
    assert.equal(reject("socks4://1.2.3.4:1080"), "socks4");
    assert.equal(refresh.parseLine("   ", "http"), null);
  });

  it("validateEntry throws on a tampered entry", () => {
    assert.doesNotThrow(() =>
      refresh.validateEntry({ protocol: "http", host: "8.8.8.8", port: 80 }),
    );
    for (const bad of [
      { protocol: "socks4", host: "8.8.8.8", port: 80 },
      { protocol: "http", host: "10.0.0.1", port: 80 },
      { protocol: "http", host: "8.8.8.8", port: 0 },
      { protocol: "http", host: "evil.com", port: 80 },
    ])
      assert.throws(() => refresh.validateEntry(bad), /./, JSON.stringify(bad));
  });
});

describe("collectFiles and fingerprint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-files-"));
  const put = (name: string, body: string | Buffer, ageMs = 0) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, body);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(f, t, t);
    return f;
  };
  put("http (1).txt", "1.2.3.4:80\n");
  put("socks5 (1).txt", "5.6.7.8:1080\n");
  put("socks4 (1).txt", "1.1.1.1:1080\n");
  put("notes.txt", "1.1.1.1:80\n");
  put("http (old).txt", "1.2.3.4:80\n", 5 * 86_400_000);
  put("http (big).txt", Buffer.alloc(300, "a"));
  put("http (nul).txt", Buffer.from([0x31, 0x2e, 0x00, 0x0a]));
  const since = new Date(Date.now() - 86_400_000);

  it("selects only recent http/https/socks5 text files and reports every rejection by name", () => {
    const r = refresh.collectFiles({ dir, since, maxBytes: 200 });
    const names = r.accepted.map((f: { name: string }) => f.name).sort();
    assert.deepEqual(names, ["http (1).txt", "http (nul).txt", "socks5 (1).txt"]);
    assert.deepEqual(
      r.rejected.map((x: { name: string; reason: string }) => `${x.name}:${x.reason}`).sort(),
      ["http (big).txt:too-big"],
    );
  });

  it("skips files containing NUL when parsing and says which", () => {
    const { accepted } = refresh.collectFiles({ dir, since, maxBytes: 200 });
    const parsed = refresh.parseFiles(accepted);
    assert.deepEqual(parsed.rejectedFiles, [{ name: "http (nul).txt", reason: "binary" }]);
    assert.equal(parsed.endpoints.length, 2);
  });

  it("fingerprint changes when a file is added, resized or touched, and not otherwise", () => {
    const fp = () =>
      refresh.computeFingerprint(refresh.collectFiles({ dir, since, maxBytes: 200 }).accepted, {
        v: 1,
      });
    const a = fp();
    assert.equal(fp(), a);
    const extra = put("http (2).txt", "9.9.9.9:80\n");
    const b = fp();
    assert.notEqual(b, a, "added");
    fs.appendFileSync(extra, "9.9.9.8:80\n");
    const c = fp();
    assert.notEqual(c, b, "resized");
    const t = new Date(Date.now() - 3600_000);
    fs.utimesSync(extra, t, t);
    assert.notEqual(fp(), c, "touched");
    assert.notEqual(
      refresh.computeFingerprint([], { v: 1 }),
      refresh.computeFingerprint([], { v: 2 }),
      "params",
    );
  });
});

describe("socket gate", () => {
  it("refuses non-public addresses by default", async () => {
    const gate = refresh.createSocketGate({});
    for (const host of ["127.0.0.1", "10.0.0.1", "192.168.0.1", "169.254.169.254"])
      await assert.rejects(gate.open(host, 80, 500), /non-public/, host);
  });

  it("reports resource error codes to onError", async () => {
    const seen: string[] = [];
    const gate = refresh.createSocketGate({
      ...permissive,
      onError: (c: string) => seen.push(c),
      connect: () => {
        const s = new net.Socket();
        queueMicrotask(() => s.destroy(Object.assign(new Error("x"), { code: "EMFILE" })));
        return s;
      },
    });
    await assert.rejects(gate.open("8.8.8.8", 80, 500));
    assert.deepEqual(seen, ["EMFILE"]);
  });

  it("reports the latency of successful connects to onConnect, and nothing for failures", async () => {
    const seen: number[] = [];
    const server = net.createServer((c) => c.destroy());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    const gate = refresh.createSocketGate({
      ...permissive,
      onConnect: (ms: number) => seen.push(ms),
    });
    try {
      (await gate.open("127.0.0.1", port, 1000)).destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await assert.rejects(gate.open("127.0.0.1", port, 1000));
      assert.equal(seen.length, 1);
      assert.ok(seen[0] >= 0 && seen[0] < 1000, `latency ${seen[0]}`);
    } finally {
      server.close();
    }
  });
});

describe("probe", () => {
  const run = async (kind: ProxyKind, cert: "good" | "bad", deadlineMs = 3000) => {
    const up = await tlsServer(cert);
    const px = await proxyServer(kind, up.port);
    const gate = refresh.createSocketGate(permissive);
    try {
      const proto = kind === "socks5" ? "socks5" : "http";
      const r = await refresh.probe({ host: "127.0.0.1", port: px.port }, proto, {
        open: gate.open,
        target: probeTarget(up.port),
        deadlineMs,
      });
      return { r, px };
    } finally {
      await up.stop();
    }
  };

  it("passes through an HTTP CONNECT proxy and through a SOCKS5 proxy", async () => {
    for (const kind of ["http", "socks5"] as const) {
      const { r, px } = await run(kind, "good");
      assert.equal(r.ok, true, `${kind}: ${r.error}`);
      assert.ok(r.issuer);
      await px.stop();
    }
  });

  it("fails when the proxy relays to a server whose certificate is not trusted", async () => {
    const { r, px } = await run("http", "bad");
    assert.equal(r.ok, false);
    assert.match(r.error, /cert|self|verify|unable|altname/i);
    await px.stop();
  });

  it("fails on a non-200 CONNECT reply", async () => {
    const { r, px } = await run("http-403", "good");
    assert.equal(r.ok, false);
    await px.stop();
  });

  it("fails at the hard deadline against a blackhole and leaves no socket open", async () => {
    const t0 = Date.now();
    const { r, px } = await run("blackhole", "good", 400);
    assert.equal(r.ok, false);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
    // Real clock: waiting for the OS to deliver the FIN to the server side.
    await wait(100);
    assert.equal(
      [...px.sockets].filter((s) => !s.destroyed).length,
      0,
      "server side sockets closed",
    );
    await px.stop();
  });
});

describe("sniff", () => {
  const sniff = async (reply: Buffer | null) => {
    const s = await replyServer(reply);
    const gate = refresh.createSocketGate(permissive);
    try {
      return await refresh.sniff(
        { host: "127.0.0.1", port: s.port },
        { open: gate.open, sniffMs: 300 },
      );
    } finally {
      await s.stop();
    }
  };

  it("classifies socks5, http, auth-required and silence", async () => {
    assert.equal(await sniff(Buffer.from([5, 0])), "socks5");
    assert.equal(await sniff(Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n")), "http");
    assert.equal(await sniff(Buffer.from([5, 2])), "reject");
    assert.equal(await sniff(Buffer.from([5, 0xff])), "reject");
    assert.equal(await sniff(null), null);
    assert.equal(await sniff(Buffer.from("garbage")), null);
  });
});

interface Rig {
  endpoints: Array<{ host: string; port: number; protos: string[] }>;
  stop: () => Promise<void>;
  goodPort: number;
  okPorts: number[];
}

async function buildRig(): Promise<Rig> {
  const good = await tlsServer("good");
  const bad = await tlsServer("bad");
  const httpOk = await proxyServer("http", good.port);
  const socksOk = await proxyServer("socks5", good.port);
  const httpBadCert = await proxyServer("http", bad.port);
  const dead = await proxyServer("blackhole", good.port);
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const closedPort = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  return {
    goodPort: good.port,
    okPorts: [httpOk.port, socksOk.port].sort(),
    endpoints: [
      { host: "127.0.0.1", port: httpOk.port, protos: ["http"] },
      { host: "127.0.0.1", port: socksOk.port, protos: ["socks5"] },
      { host: "127.0.0.1", port: httpBadCert.port, protos: ["http"] },
      { host: "127.0.0.1", port: dead.port, protos: ["http"] },
      { host: "127.0.0.1", port: closedPort, protos: ["http"] },
    ],
    stop: async () => {
      await good.stop();
      await bad.stop();
      for (const p of [httpOk, socksOk, httpBadCert, dead]) await p.stop();
    },
  };
}

function scanDeps(goodPort: number, store: unknown, opened?: { count: number }) {
  const gate = refresh.createSocketGate(permissive);
  return {
    open: (h: string, p: number, ms: number) => {
      if (opened) opened.count++;
      return gate.open(h, p, ms);
    },
    target: probeTarget(goodPort),
    limiters: {
      tcp: adaptive.createLimiter({ name: "tcp", start: 20, min: 5, max: 50 }),
      tls: adaptive.createLimiter({ name: "tls", start: 10, min: 5, max: 20 }),
      stab: adaptive.createLimiter({ name: "stab", start: 5, min: 5, max: 5 }),
    },
    store,
    deadlineMs: 1500,
    sniffMs: 300,
    tcpMs: 500,
    pauseMs: 0,
    log: () => {},
  };
}

describe("scanEndpoints", () => {
  const portsOf = (r: { stable: Array<{ port: number }> }) => r.stable.map((s) => s.port).sort();

  it("keeps exactly the endpoints that pass strict TLS in every round", async () => {
    const rig = await buildRig();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-scan-"));
      const store = refresh.createStageStore(dir, "fp1", { resume: false });
      const out = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, store),
      });
      store.closeAll();
      assert.deepEqual(portsOf(out), rig.okPorts);
      assert.equal(out.counts.endpoints, 5);
      assert.equal(out.counts.stable, 2);
      assert.equal(out.counts.tcpOpen, 4, "the closed port is dropped at the TCP stage");
      assert.equal(Object.keys(out.issuers).length, 1, "single issuer recorded");
      for (const k of ["tcp", "tls", "stability"] as const) assert.ok(out.timings[k] >= 0, k);
    } finally {
      await rig.stop();
    }
  });

  it("a complete resume does no network work and returns the same result", async () => {
    const rig = await buildRig();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-resume-"));
      const s1 = refresh.createStageStore(dir, "fp1", { resume: false });
      const full = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, s1),
      });
      s1.closeAll();
      const opened = { count: 0 };
      const s2 = refresh.createStageStore(dir, "fp1", { resume: true });
      const again = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, s2, opened),
      });
      s2.closeAll();
      assert.equal(opened.count, 0);
      assert.deepEqual(portsOf(again), portsOf(full));
    } finally {
      await rig.stop();
    }
  });

  it("after a crash that truncated every stage file, resume reaches the same result and only reprobes what is missing", async () => {
    const rig = await buildRig();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-crash-"));
      const s1 = refresh.createStageStore(dir, "fp1", { resume: false });
      const full = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, s1),
      });
      s1.closeAll();
      const kept = new Set<string>();
      for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        const p = path.join(dir, f);
        const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
        fs.writeFileSync(p, `${lines.slice(0, 1).join("\n")}\n`);
        if (f === "tcp.jsonl") kept.add(JSON.parse(lines[0]).key);
      }
      const opened = { count: 0 };
      const s2 = refresh.createStageStore(dir, "fp1", { resume: true });
      const again = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, s2, opened),
      });
      s2.closeAll();
      assert.deepEqual(portsOf(again), portsOf(full));
      assert.ok(opened.count > 0, "missing work was redone");
      assert.ok(kept.size === 1, "the first TCP record survived the truncation");
    } finally {
      await rig.stop();
    }
  });

  it("treats a stage file from a different fingerprint as stale and recomputes", async () => {
    const rig = await buildRig();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr-stale-"));
      const s1 = refresh.createStageStore(dir, "fp-old", { resume: false });
      await refresh.scanEndpoints({ endpoints: rig.endpoints, deps: scanDeps(rig.goodPort, s1) });
      s1.closeAll();
      const opened = { count: 0 };
      const s2 = refresh.createStageStore(dir, "fp-new", { resume: true });
      const out = await refresh.scanEndpoints({
        endpoints: rig.endpoints,
        deps: scanDeps(rig.goodPort, s2, opened),
      });
      s2.closeAll();
      assert.ok(opened.count > 0, "recomputed");
      assert.equal(out.counts.stable, 2);
    } finally {
      await rig.stop();
    }
  });
});
