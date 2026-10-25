import test from "node:test";
import assert from "node:assert/strict";
import { isAbortError } from "../src/lib/request-lifecycle.js";
import {
  checkSession,
  fetchStatus,
  fetchPools,
  fetchMetrics,
  fetchAntigravityStatus,
} from "../src/lib/api.js";
test("isAbortError recognizes DOM abort cancellations without swallowing other errors", () => {
  assert.equal(isAbortError(new DOMException("signal aborted", "AbortError")), true);
  const errorAbort = new Error("signal is aborted without reason");
  errorAbort.name = "AbortError";
  assert.equal(isAbortError(errorAbort), true);
  assert.equal(isAbortError(new Error("network failed")), false);
  assert.equal(isAbortError("AbortError"), false);
  assert.equal(isAbortError(null), false);
});

test("fetch client helpers gracefully handle aborted signals without rejections", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  // Mock fetch that rejects with DOMException when aborted, without wall-clock timers
  globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw new DOMException("signal is aborted without reason", "AbortError");
    }
    const { promise, reject } = Promise.withResolvers<Response>();
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          reject(new DOMException("signal is aborted without reason", "AbortError"));
        },
        { once: true },
      );
    }
    return promise;
  };

  // 1. checkSession with pre-aborted signal
  const c1 = new AbortController();
  c1.abort();
  const sessionRes = await checkSession(c1.signal);
  assert.equal(sessionRes, false);

  // 2. fetchStatus with signal aborted in-flight
  const c2 = new AbortController();
  const statusPromise = fetchStatus(undefined, c2.signal);
  c2.abort();
  const statusRes = await statusPromise;
  assert.equal(statusRes.running, false);
  assert.equal(statusRes.stats.total, 0);

  // 3. fetchPools with undefined password and signal in arg3
  const c3 = new AbortController();
  const poolsPromise = fetchPools(undefined, "active", c3.signal);
  c3.abort();
  const poolsRes = await poolsPromise;
  assert.deepEqual(poolsRes, []);

  // 4. fetchMetrics with undefined password and signal in arg3
  const c4 = new AbortController();
  const metricsPromise = fetchMetrics(undefined, 24, c4.signal);
  c4.abort();
  const metricsRes = await metricsPromise;
  assert.deepEqual(metricsRes, []);

  // 5. fetchAntigravityStatus with in-flight abort
  const c5 = new AbortController();
  const agPromise = fetchAntigravityStatus(undefined, c5.signal);
  c5.abort();
  const agRes = await agPromise;
  assert.equal(agRes, null);
});
