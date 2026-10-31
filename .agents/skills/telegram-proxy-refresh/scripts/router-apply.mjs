// Router-safe apply: bounded concurrency, per-kind circuit breaker, ownership ledger.
// The router client is injected, so tests use a fake and never touch a real 9Router.
import fs from "node:fs";

export class RouterOverloaded extends Error {
  constructor(message = "router overloaded") {
    super(message);
    this.name = "RouterOverloaded";
  }
}

export class PreconditionError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreconditionError";
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A call fails the router only on transport errors, request timeouts and HTTP 5xx.
// 4xx validation errors and `testPool` replies with ok:false are results, not router failures.
const isRouterFailure = (e) => {
  const status = e?.status;
  if (typeof status === "number") return status >= 500;
  return true;
};
const isOverloadStatus = (e) => e?.status === 429 || e?.status === 503;

export function createRouterGate({
  maxInflight = 2,
  mutationGapMs = 150,
  now = Date.now,
  sleep = realSleep,
  pauses = [30000, 60000, 120000],
  window = 10,
  slowCalls = 10,
} = {}) {
  let inflight = 0;
  let peakInflight = 0;
  let trips = 0;
  let slowLeft = 0;
  let lastMutationAt = -Infinity;
  let paused = null;
  const waiters = [];
  const recent = []; // { kind, ms, failed, overload }
  const baseline = new Map(); // kind -> median of first 5 successful calls
  const firstSamples = new Map();
  const kindMs = new Map(); // kind -> latencies since the last trip

  const limit = () => (slowLeft > 0 ? 1 : maxInflight);
  const wake = () => {
    while (waiters.length && inflight < limit()) waiters.shift()();
  };

  const evaluate = () => {
    const last = recent.slice(-window);
    if (last.some((r) => r.overload)) return "overload status";
    if (last.filter((r) => r.failed).length >= 5) return "5 failures in 10 calls";
    for (const [kind, base] of baseline) {
      if (kind === "test") continue; // test latency reflects remote proxy RTT, not router health
      const samples = (kindMs.get(kind) ?? []).slice(-window);
      if (samples.length >= 5 && base > 0 && median(samples) > base * 3) return `${kind} latency over 3x baseline`;
    }
    return null;
  };

  const trip = async (reason) => {
    trips++;
    recent.length = 0;
    kindMs.clear();
    if (trips > pauses.length) throw new RouterOverloaded(`circuit breaker tripped ${trips} times (${reason})`);
    slowLeft = slowCalls;
    paused = sleep(pauses[trips - 1]).finally(() => {
      paused = null;
    });
    await paused;
  };

  return {
    async call(kind, fn, { mutating = false } = {}) {
      if (trips > pauses.length) throw new RouterOverloaded("circuit breaker open");
      while (paused) await paused;
      while (inflight >= limit()) {
        const gate = Promise.withResolvers();
        waiters.push(gate.resolve);
        await gate.promise;
      }
      inflight++;
      peakInflight = Math.max(peakInflight, inflight);
      try {
        if (mutating) {
          const wait = lastMutationAt + mutationGapMs - now();
          if (wait > 0) await sleep(wait);
          lastMutationAt = now();
        }
        const t0 = now();
        let outcome;
        try {
          const value = await fn();
          outcome = { value, failed: false, overload: false };
        } catch (e) {
          // For 'test', router-side transport timeout testing a dead proxy is expected, not router outage
          const failed = kind === "test" ? isRouterFailure(e) && e?.status >= 500 : isRouterFailure(e);
          outcome = { error: e, failed, overload: isOverloadStatus(e) };
        }
        const ms = now() - t0;
        recent.push({ kind, ms, failed: outcome.failed, overload: outcome.overload });
        if (!outcome.failed && !outcome.overload) {
          if (!baseline.has(kind)) {
            const s = firstSamples.get(kind) ?? [];
            s.push(ms);
            firstSamples.set(kind, s);
            if (s.length >= 5) baseline.set(kind, median(s));
          } else {
            const list = kindMs.get(kind) ?? [];
            list.push(ms);
            kindMs.set(kind, list);
          }
        }
        if (slowLeft > 0) slowLeft--;
        const reason = evaluate();
        if (reason) {
          inflight--;
          wake();
          try {
            await trip(reason);
          } finally {
            inflight++;
          }
        }
        if (outcome.error !== undefined) throw outcome.error;
        return outcome.value;
      } finally {
        inflight--;
        wake();
      }
    },
    stats() {
      return { peakInflight, trips, baselineMs: Object.fromEntries(baseline) };
    },
  };
}

export function createMemoryLedger() {
  const rows = [];
  return {
    append: (row) => rows.push(row),
    entries: () => rows.map((r) => ({ ...r })),
  };
}

export function createFileLedger(file) {
  const rows = fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  return {
    append(row) {
      rows.push(row);
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
    },
    entries: () => rows.map((r) => ({ ...r })),
  };
}

// URL.port is "" when the port is the scheme default, so a pool stored as http://h:80 would read as "h:".
const DEFAULT_PORT = { "http:": "80", "https:": "443" };
const keyOf = (p) => {
  try {
    const u = new URL(p.proxyUrl);
    return `${u.hostname}:${u.port || DEFAULT_PORT[u.protocol] || ""}`;
  } catch {
    return "";
  }
};

export async function applyStable({ stable, router, gate, ledger, validate, maxNew = 200, log = () => {} }) {
  const errors = [];
  for (const e of stable) validate(e);

  const read = () => gate.call("list", () => router.listPools());
  let onRouter = await read();

  const rows = ledger.entries();
  let baselineIds = new Set(rows.find((r) => r.op === "baseline")?.ids ?? []);
  if (baselineIds.size === 0 && !rows.some((r) => r.op === "baseline")) {
    baselineIds = new Set(onRouter.map((p) => p.id));
    ledger.append({ op: "baseline", ids: [...baselineIds] });
  }

  const owned = new Map(); // id -> endpoint
  for (const r of rows) if (r.op === "created" && !baselineIds.has(r.id)) owned.set(r.id, r.endpoint);
  const adopted = [];
  const createdEndpoints = new Set(rows.filter((r) => r.op === "created").map((r) => r.endpoint));
  for (const r of rows) {
    if (r.op !== "intent" || createdEndpoints.has(r.endpoint)) continue;
    const found = onRouter.find((p) => keyOf(p) === r.endpoint && !baselineIds.has(p.id));
    if (found && !owned.has(found.id)) {
      owned.set(found.id, r.endpoint);
      adopted.push(r.endpoint);
      ledger.append({ op: "created", endpoint: r.endpoint, id: found.id, adopted: true });
    }
  }

  const present = new Set(onRouter.map(keyOf));
  const fresh = stable.filter((e) => !present.has(`${e.host}:${e.port}`));
  const alreadyOnRouter = stable.length - fresh.length;
  if (fresh.length > maxNew) throw new PreconditionError(`${fresh.length} new endpoints exceeds --max-new ${maxNew}`);

  let created = 0;
  let sinceRelist = 0;
  for (const e of fresh) {
    const endpoint = `${e.host}:${e.port}`;
    if (sinceRelist >= 10) {
      onRouter = await read();
      sinceRelist = 0;
    }
    if (onRouter.some((p) => keyOf(p) === endpoint)) continue;
    ledger.append({ op: "intent", endpoint });
    try {
      const p = await gate.call(
        "create",
        () => router.createPool({ name: endpoint, proxyUrl: `${e.protocol}://${endpoint}`, type: e.protocol, isActive: false }),
        { mutating: true },
      );
      ledger.append({ op: "created", endpoint, id: p.id });
      owned.set(p.id, endpoint);
      onRouter.push({ id: p.id, proxyUrl: `${e.protocol}://${endpoint}`, isActive: false });
      created++;
      sinceRelist++;
    } catch (err) {
      if (err instanceof RouterOverloaded) throw err;
      errors.push(`create ${endpoint}: ${String(err.message).slice(0, 80)}`);
      onRouter = await read();
      sinceRelist = 0;
    }
  }

  const passes = new Map();
  const testOne = async (id) => {
    let n = 0;
    for (let r = 0; r < 2; r++) {
      const res = await gate.call("test", () => router.testPool(id)).catch((err) => {
        if (err instanceof RouterOverloaded) throw err;
        // Network errors during pool testing reflect remote proxy unreachability
        return { ok: false };
      });
      if (res?.ok) n++;
    }
    passes.set(id, n);
  };
  await Promise.all([...owned.keys()].map(testOne));

  const kept = [];
  const flaky = [];
  const deleted = [];
  for (const [id, endpoint] of owned) {
    const n = passes.get(id) ?? 0;
    if (n === 0) {
      try {
        await gate.call("delete", () => router.deletePool(id), { mutating: true });
        deleted.push(endpoint);
      } catch (err) {
        if (err instanceof RouterOverloaded) throw err;
        errors.push(`delete ${endpoint}: ${String(err.message).slice(0, 80)}`);
      }
    } else (n === 2 ? kept : flaky).push(endpoint);
  }
  if (flaky.length) kept.push(...flaky);

  const afterTests = await read();
  for (const p of afterTests) {
    if (!owned.has(p.id) || !p.isActive || deleted.includes(owned.get(p.id))) continue;
    try {
      await gate.call("deactivate", () => router.setPoolActive(p.id, false), { mutating: true });
    } catch (err) {
      if (err instanceof RouterOverloaded) throw err;
      errors.push(`deactivate ${owned.get(p.id)}: ${String(err.message).slice(0, 80)}`);
    }
  }

  const final = await read();
  const seen = new Map();
  for (const p of final) seen.set(keyOf(p), (seen.get(keyOf(p)) ?? 0) + 1);
  for (const endpoint of kept) {
    const pool = final.find((p) => keyOf(p) === endpoint);
    if (!pool) errors.push(`read-back: ${endpoint} missing`);
    else if (pool.isActive) errors.push(`read-back: ${endpoint} is active`);
  }
  for (const [endpoint, n] of seen) if (n > 1) errors.push(`read-back: ${endpoint} appears ${n} times`);
  log(`apply created=${created} kept=${kept.length} deleted=${deleted.length}`);

  return {
    alreadyOnRouter,
    created,
    adopted,
    kept: kept.filter((e) => !flaky.includes(e)),
    flaky,
    deleted,
    errors,
    partial: false,
    poolsAfter: final.length,
    activeAfter: final.filter((p) => p.isActive).length,
    router: gate.stats(),
  };
}
