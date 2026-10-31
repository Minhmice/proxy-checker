# Telegram Proxy Refresh Adaptive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Scan large Telegram proxy lists faster with self-tuning concurrency, and apply survivors to 9Router under a hard load budget, with safe resume.

**Architecture:** Three ES modules next to the existing script: `adaptive.mjs` (limiters, controller, canary), `router-apply.mjs` (router gate with breaker, ownership ledger, apply), `refresh.mjs` (parser, socket gate, probes, streaming pipeline, CLI). All network and router access is injected, so tests use loopback fixtures and a fake router.

**Tech Stack:** Node >= 22, `node:net`, `node:tls`, `node:perf_hooks`, `node:test` via `node --import tsx --test`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-telegram-proxy-refresh-adaptive-design.md`

## Global Constraints

- No new dependencies. No changes to `src/`, `nine-router-client.ts`, pool-ranker, or `data/proxies.sqlite3`.
- Only `http` and `socks5`; public IPv4 literals only; every outbound socket goes through one gate that re-checks this.
- Probe hard deadline 12 s; every exit path destroys every socket it opened.
- Limiters (start/min/max): TCP 200/50/1500, TLS 60/20/400, stability 20/20/20. Global cap 1,600 sockets. Tick 2 s. Halve on any signal, +max(5, 10%) after 2 calm ticks at >= 90% saturation.
- Signals: >= 3 resource errors per tick; canary median > max(3 x baseline, baseline + 400 ms) or both targets failing; event-loop p95 > 250 ms. Dead proxies are never a signal.
- Router: <= 2 calls in flight; >= 150 ms between mutating calls; breaker per call kind; pauses 30/60/120 s; 4th trip stops (exit 3). `--max-new` default 200.
- Exit codes: 0 ok, 1 unexpected, 2 usage, 3 router overloaded (partial), 4 precondition/network.
- New pools stay inactive (reserve). Only pools created or adopted by this run may be deleted or deactivated.
- Test file: `tests/telegram-proxy-refresh.test.ts`. Run: `node --import tsx --test tests/telegram-proxy-refresh.test.ts`.

---

### Task 1: `adaptive.mjs`

**Files:** Create `.agents/skills/telegram-proxy-refresh/scripts/adaptive.mjs`; Test `tests/telegram-proxy-refresh.test.ts`

**Produces:**
```js
export const RESOURCE_CODES; // Set of EMFILE ENFILE ENOBUFS EADDRNOTAVAIL EAGAIN ENOMEM
export function createLimiter({ name, start, min, max }) // { name, limit, min, max, inflight, peakLimit, run(fn), setLimit(n) }
export function createController({ limiters, globalCap = 1600, reserved = 2, canary, lag }) // { noteError(code), step(signals), tick(), start(ms), stop(), summary() }
export function createCanary({ connect, targets, timeoutMs = 1500 }) // { baseline(), sample() }
export function createLoopLag() // { p95Ms(), reset(), stop() }
```
`step({resourceErrors, congested, loopLagMs})` returns `[{name, action: "down"|"up"|"hold", limit}]`.

- [ ] Write tests: limiter never exceeds `limit` inflight and a raised limit wakes queued work; `step` halves on each signal kind and respects `min`; grows only after 2 calm ticks at >= 90% saturation, clamps to `max` and to the global cap; cooldown holds 2 ticks after a decrease; no signal for dead-proxy timeouts (resource count below 3 does nothing); canary `baseline()` throws `network-down` when fewer than 3 samples succeed; `sample()` flags congestion on both-fail and on latency above threshold.
- [ ] Run tests, expect FAIL (module missing).
- [ ] Implement the four exports.
- [ ] Run tests, expect PASS.

### Task 2: `router-apply.mjs`

**Files:** Create `.agents/skills/telegram-proxy-refresh/scripts/router-apply.mjs`; Modify `tests/telegram-proxy-refresh.test.ts`

**Produces:**
```js
export class RouterOverloaded extends Error {}
export class PreconditionError extends Error {}
export function createRouterGate({ maxInflight = 2, mutationGapMs = 150, now, sleep, pauses = [30000, 60000, 120000], window = 10 })
  // { call(kind, fn, { mutating } = {}), stats() }
export function applyStable({ stable, router, gate, ledgerFile, validate, maxNew = 200, log })
  // router = { listPools, createPool, testPool, deletePool, setPoolActive }
  // -> { alreadyOnRouter, created, adopted, kept, flaky, deleted, errors, partial, poolsAfter, activeAfter, router }
```

- [ ] Write tests with a fake router and fake clock: gate never exceeds 2 in flight; mutating call starts are >= gap apart; breaker trips on 429, on 503, on 5 failures in 10, on per-kind median > 3 x baseline (>= 3 samples), not on 4xx or `ok:false`; pause durations 30/60/120 then `RouterOverloaded`; slow mode uses 1 in flight for 10 calls. Apply: never touches baseline pools; resume adopts an `intent` without `created`; rejects invalid or over-limit input before any write; skips endpoints already on router; deletes only owned pools with 0 passes; deactivates an owned pool the router left active; read-back error reported not hidden.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.

### Task 3: `refresh.mjs`

**Files:** Modify `.agents/skills/telegram-proxy-refresh/scripts/refresh.mjs`; Create `tests/fixtures/proxy-refresh/good.crt`, `good.key`, `bad.crt`, `bad.key` (throwaway self-signed, SAN `localhost`/`127.0.0.1`); Modify test file.

**Produces:**
```js
export function parseLine(raw, kind); export function validateEntry(e); export function kindOf(name);
export function collectFiles({ dir, since, maxBytes = 20_000_000 }) // { accepted, rejected:[{name,reason}] }
export function parseFiles(files) // { endpoints, lines, rejected, rejectedFiles }
export function computeFingerprint(files, params)
export function createSocketGate({ allow, onError }) // { open(host, port, ms) }
export function createStageStore(dir, fingerprint, { resume }) // { stage(name), closeAll() }
export async function sniff(ep, deps); export async function probe(ep, proto, deps)
export async function scanEndpoints({ endpoints, deps }) // { stable, counts, issuers, timings }
```
`deps = { open, now, sleep, target:{host,port,servername,ca,path,status}, limiters:{tcp,tls,stab}, store, deadlineMs, sniffMs, tcpMs, log }`.

- [ ] Generate fixture certs with `openssl`; commit them.
- [ ] Write tests: parser rejections kept; `collectFiles` skips symlink, oversize, wrong names, old mtime; `parseFiles` skips NUL files and reports names; fingerprint changes when a file is added, resized or touched; gate rejects loopback by default and `onError` sees `EMFILE`-style codes; loopback HTTP-CONNECT and SOCKS5 proxies pass `probe`; a proxy relaying to a differently-signed server fails; blackhole proxy fails at the deadline and its server-side socket is closed; `sniff` returns `socks5`, `http`, `reject` (reply `05 02`), `null` (silence); `scanEndpoints` over six fixture endpoints yields exactly the two good ones; resume after truncating stage files reproduces the full result and never re-opens a completed endpoint; stale fingerprint recomputes.
- [ ] Run, expect FAIL. Implement. Run, expect PASS.
- [ ] CLI: `--max-new`, `--resume`, canary baseline before scan, controller around scan, `state.json` written last, `stable.jsonl` with fingerprint header, `apply` checks fingerprint match, exit codes, direct-run guard (`main()` only when executed), 10 s unref backstop with a warning if it fires.

### Task 4: Skill docs and verification

**Files:** Modify `.agents/skills/telegram-proxy-refresh/SKILL.md`

- [ ] Update procedure, flags, exit codes, resume steps after exit 3, issuer-as-evidence rule, no-database note.
- [ ] Run `node --import tsx --test tests/telegram-proxy-refresh.test.ts` and the existing proxy tests (`proxy-core`, `proxy-import-preview`, `proxy-intelligence-repository`).
- [ ] Run `refresh.mjs selftest` and a small real smoke scan on a temp folder (needs network, user-visible, no router writes: `scan` only).
- [ ] Ask the user before the full real scan and before any `apply` against 9Router.
