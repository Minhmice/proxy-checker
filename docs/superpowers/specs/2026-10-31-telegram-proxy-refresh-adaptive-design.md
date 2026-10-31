# Telegram Proxy Refresh: Adaptive Concurrency and Router-Safe Apply

**Status:** Design approved in chat 2026-10-31; implementation not started.

## Goal

Make `.agents/skills/telegram-proxy-refresh` scan large proxy lists substantially faster without overloading either the local network or 9Router, and make an interrupted run safe to resume.

## Evidence (first real run, 2026-10-31, 116 files, 347,545 endpoints)

| Observation | Source |
|---|---|
| TCP stage took 1,418.76 s at a fixed 600 concurrent sockets | bg_1 wall time |
| TLS stage (fixed 250) processed all 10,096 endpoints and wrote `finished: true`, yet the job was reported as timed out at 3,600 s. Why the process did not exit was not established, and the true stage duration was not measured | bg_2 result, `stage2-progress.json` |
| 5,870 `http:closed` and 4,270 `socks5:socks5 greeting/auth` TLS-stage failures. Cause not established: a wrong-protocol attempt, authentication-required proxies, or proxies that drop unknown clients all produce these errors | `stage2-progress.json` `fail` map |
| `socket.setTimeout()` does not close a socket; the caller must call `end()`/`destroy()` | [Node.js net docs](https://nodejs.org/docs/latest-v22.x/api/net.html#socketsettimeouttimeout-callback) |
| OWASP: validate destinations, do not follow redirects, and enforce the destination policy on retries and fallback connections as well. Here every endpoint is an IPv4 literal, so there is no DNS step to rebind; the policy is enforced in the single function that opens sockets | [OWASP SSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) |

Only the TCP stage (1,418.76 s) has a trustworthy wall-clock baseline. No speed-up is claimed for other stages until the new report measures them.

Known defects in the current `refresh.mjs`:

- The `--resume` cache is keyed by date only. A new file added the same day is silently ignored.
- Stage results are written only when a stage ends. An interrupted run loses the whole stage.
- Concurrency is fixed (600 / 250 / 20).
- `apply` trusts `stable.json` without validating it, re-lists the router once, and has no ownership record. After an interruption it cannot tell which pools it created.
- `apply` has no router rate limit beyond an 80 ms sleep in the create loop; test calls run 4 at a time.
- `tunnel()` and the TCP stage rely on timeout events and leave cleanup to the happy path.

## Non-goals

- No change to 9Router, `nine-router-client.ts`, or pool-ranker.
- No auto-activation of pools. Promotion to Active stays with the pool-ranker sync.
- No socks4, IPv6 or hostname proxies. No reputation providers.
- No writes to `data/proxies.sqlite3`. Results stay in a scratch folder. Project decision: audit state belongs in the database, so recording scan results there is a separate change.
- No scheduled or unattended runs.

## Architecture

Three modules under `.agents/skills/telegram-proxy-refresh/scripts/`, no new dependencies:

| File | Responsibility |
|---|---|
| `refresh.mjs` | CLI, input selection, parser, probes, scan pipeline, report. Exports pure functions. Runs `main()` only when executed directly. |
| `adaptive.mjs` | Concurrency controller and local-network canary. Pure logic with injectable `now()` and `sleep()`. |
| `router-apply.mjs` | Router limiter, circuit breaker, ownership ledger, apply planner. Takes the router client as an argument. |

```
files -> parse -> dedupe -> TCP -> sniff -> TLS x2 -> stability x3 -> stable.jsonl
                   (each stage streams into the next; own adaptive limit per stage)
stable.jsonl -> validate -> apply (limiter + breaker + ledger) -> report
```

Stages stream: an endpoint enters the next stage as soon as it leaves the previous one. Apply starts only after scan finishes.

## Input and cache integrity

- Select `.txt` files named `http*`, `https*`, `socks5*` with `mtime >= --since` (default local midnight). Check size with `stat` before reading; reject symlinks, files over 20 MB, and files containing NUL. Report each rejection by name.
- Parser behavior is unchanged (strict `[proto://]IPv4:port`, public addresses only, `https` lists treated as HTTP proxies). It stays the single place that decides what may be connected to.
- **Fingerprint** = SHA-256 over: sorted `name|size|mtimeMs` of selected files, `PIPELINE_VERSION`, and probe parameters (target host, thresholds). Every stage file records the fingerprint. `--resume` reuses a stage file only when the fingerprint matches; otherwise it logs `stale` and recomputes.
- Each stage appends one JSON line per processed endpoint (pass and fail) to `<out>/<stage>.jsonl`. Resume skips endpoints already present, so an interruption loses at most in-flight work.

## Probes

- **Deadline:** every probe has a hard total deadline of 12 s. Every exit path (success, error, timeout, deadline) destroys every socket it opened. A probe never leaves a socket to the garbage collector.
- **Protocol sniff:** after TCP succeeds, open a separate short connection and send the SOCKS5 greeting `05 01 00` once, then close it. Reply starting `05 00` means `socks5`. Reply starting `HTTP/` means `http`. Reply `05 02` or `05 ff` (authentication required) rejects the endpoint. Anything else (close, silence, garbage) falls back to the protocol named by the source file. TLS probes then try one protocol per endpoint, not all listed ones. Whether this removes the `closed` and `greeting/auth` failures seen in the first run is to be measured, not assumed.
- **TLS:** unchanged semantics. Tunnel to `www.google.com:443`, strict verification (`rejectUnauthorized: true`, TLS 1.2+), `HEAD /generate_204` must return 204.
- **Evidence, not allowlist:** the certificate issuer is recorded in the result. Verification success is the pass criterion. The hard requirement `issuer === "Google Trust Services"` is replaced by: the issuer must be identical across all stability rounds and the chain must verify against the system trust store. The report lists issuer counts so an unexpected issuer is visible.
- Probe target is a parameter (`{host, port, servername, ca}`), default Google. Tests point it at a local TLS server.
- **Single socket gate:** every outbound connection (probe, sniff, canary) goes through one `openSocket(host, port)` that rejects non-public IPv4 literals before connecting. The parser is the first check, this gate is the second. Tests inject a permissive gate to reach loopback fixtures; production code cannot.

## Adaptive concurrency (`adaptive.mjs`)

Each stage has a limiter with `limit`, `inflight`, `min`, `max`:

| Stage | start | min | max |
|---|---:|---:|---:|
| TCP | 200 | 50 | 400 (was 1500; see "Measured after implementation") |
| sniff + TLS | 60 | 20 | 400 |
| stability | 20 | 20 | 20 |

A global cap of 1,600 open sockets (all stages plus canary) is enforced on top.

**Tick every 2 s.** Compute signals, then adjust every limiter:

| Signal | Definition |
|---|---|
| resource error | 3 or more of `EMFILE`, `ENFILE`, `ENOBUFS`, `EADDRNOTAVAIL`, `EAGAIN`, `ENOMEM` in the tick |
| congested | direct TCP connect to `1.1.1.1:443` and `8.8.8.8:443` (1.5 s timeout): both fail, or median latency `> max(3 x baseline, baseline + 400 ms)` |
| loop lag | p95 lateness of a 20 ms interval timer `> 250 ms`. `perf_hooks.monitorEventLoopDelay` was tried first and rejected: on this machine a 400 ms blocked loop gave p95 = 27 ms |
| slow connect | in one tick, at least 20 successful connects and `>= 12%` of them took `>= 900 ms` (waited for a SYN retransmit). Dead hosts never succeed, so they cannot trigger it |

- Any signal: `limit = max(min, floor(limit x 0.5))`, then 2 ticks cooldown. During cooldown only a resource error may halve again; other signals are ignored while the previous halving drains.
- No signal for 2 consecutive ticks and work waiting in the limiter queue: `limit + max(5, ceil(limit x 0.1))`, or `limit x 2` while the queue holds at least 20x the limit and the limit is below half of max. Capped by max and the global socket cap. (Slot occupancy was the first rule; fast-failing connects free slots between ticks, so it never reached 90% and the limit never grew.)
- Dead proxies are not a signal: their timeouts never reduce concurrency.
- **Baseline:** median of 5 canary samples taken before the scan, at idle. If the baseline itself fails, abort with exit code 4 (`network-down`) before opening any proxy connection.
- The report includes, per stage: peak and average limit, number of decreases with their cause, wall-clock seconds.

## Router-safe apply (`router-apply.mjs`)

Apply never runs concurrently with scan.

**Preconditions (fail with exit code 4, nothing written):**
- `stable.jsonl` carries the same fingerprint as `<out>/state.json`, which the scan writes last (fingerprint, pipeline version, finish time, per-stage counts). A missing or mismatched `state.json` means the scan did not finish or the inputs changed.
- Every entry validates: protocol in `{http, socks5}`, public IPv4, port 1-65535.
- Number of new endpoints `<= --max-new` (default 200).

**Rate limit:** at most 2 router calls in flight in total; at least 150 ms between mutating calls (create, delete, deactivate).

**Circuit breaker.** Judged per operation kind (`list`, `create`, `test`, `delete`, `deactivate`), because a router `test` call legitimately takes seconds while it dials the proxy. Baseline latency per kind = median of its first 5 successful calls (`list` baseline is measured before any write). A call counts as *failed* only for transport errors, timeouts of the HTTP request itself, and HTTP 5xx. HTTP 4xx validation errors and a `testPool` reply of `ok:false` (proxy dead) are results, not router failures. Trip when, over the last 10 calls: any HTTP 429 or 503 was seen; 5 or more calls failed; or the median latency of a kind exceeds `3 x` its own baseline. On trip, pause 30 s, then 60 s, then 120 s, and resume at 1 in flight for 10 calls before returning to 2. A fourth trip stops writing, persists state, and exits with code 3 (`router-overloaded`). The summary states the run is partial and how to resume.

**Ownership ledger** (`<out>/apply.jsonl`, append-only):
1. First apply run stores `baselineIds`, the router pool ids existing before any write. These are never owned and never modified.
2. Before each create, append `{op:"intent", endpoint}`. After success, append `{op:"created", endpoint, id}`.
3. On resume, list the router. An `intent` without `created` whose endpoint exists on the router and whose id is not in `baselineIds` is adopted as owned. An `intent` whose endpoint is absent is retried. Residual risk: if another actor created the same endpoint between the interruption and the resume, it is adopted and may later be deleted when its tests fail. The report lists every adopted pool so this is visible.
4. Delete and deactivate may only target ids recorded as owned.

**Duplicate guard:** re-list the router before the first create, then after every 10 creates and after any create error. Skip endpoints already present (`host:port`).

**Per owned pool:** test twice (2 in flight). Two passes: keep, reserve. One pass: keep, reserve, report as `flaky`. Zero passes: delete. If the router left an owned pool active, deactivate it.

**Read-back:** final list must show every kept pool exactly once, inactive, no duplicate endpoints. Any mismatch is reported as an error, not corrected silently.

**Exit codes:** 0 complete, 1 unexpected error, 2 usage error, 3 router overloaded (partial), 4 precondition or network failure.

## Report

JSON to stdout: files accepted and rejected (by reason), line counts, per-stage counts and timings, controller summary, issuer counts, router stats (calls, peak in flight, trips, p50 latency), pools created / kept / flaky / deleted / adopted, errors. No credentials, no router URL.

## Skill changes (`SKILL.md`)

Document new flags (`--max-new`, `--resume` semantics with fingerprint), exit codes and the resume procedure after exit 3; keep the dry-run-first procedure; state that issuer is evidence only, that passing TLS to Google does not prove a proxy does not log plain HTTP, and that scan results are not stored in the database.

## Testing

Permanent tests in `tests/telegram-proxy-refresh.test.ts` (existing runner: `node --import tsx --test`). Probe, controller and apply take injected dependencies, so tests use no public network.

| Area | Cases |
|---|---|
| Parser | existing rejections kept (private, CGNAT, link-local, injection strings, ports) |
| Fingerprint | adding, resizing or touching a file invalidates cached stages; unchanged set reuses them |
| Controller | halves on resource errors, congestion and loop lag; grows only when saturated and healthy for 2 ticks; ignores dead-proxy timeouts; respects min, max and global cap (fake clock) |
| Probe fixtures | local HTTP CONNECT and SOCKS5 proxies forwarding to a local TLS server (test certificate under `tests/fixtures/`): pass; proxy that re-signs with another CA: fail; proxy that never answers: fails at deadline and its sockets are destroyed (assert closed) |
| Sniff | SOCKS5 reply, HTTP reply, auth-required reply, garbage |
| Apply (fake router) | never exceeds 2 in flight or 150 ms mutation gap; breaker trips on 429/503/slow/errors and stops after the fourth trip; resume adopts an `intent` without `created`; never deletes or deactivates a baseline pool; stops creating beyond `--max-new`; rejects tampered `stable.jsonl` |

`selftest` in the CLI is kept as a smoke check of the parser.

## Acceptance

1. `node --import tsx --test tests/telegram-proxy-refresh.test.ts` passes; the existing proxy module tests still pass; no new `tsc` errors from the new test file.
2. Smoke: the pipeline entry `scanEndpoints(endpoints, deps)` (post-parse) is run in the test against loopback fixture proxies with the permissive gate injected, and yields the expected pass and fail counts. File collection and the parser are tested separately with a temp folder, because the production parser rejects loopback addresses by design.
3. Interrupt test: kill a scan mid-stage, rerun with `--resume`; the output equals an uninterrupted run on the same fixture, and no endpoint is probed twice.
4. Speed: superseded. The 1,418.76 s baseline came from a fixed concurrency of 600, which measurements later showed to lose live endpoints (see below). A faster scan that misses a third or more of live proxies is a worse result, so no speed target is kept. The process must still exit by itself within 10 s of printing the report.
5. Router load, in the same real run: peak in-flight router calls `<= 2` and zero breaker trips, or the trips are reported.

## Risks

- A stricter pass criterion (identical issuer across rounds, chain verified) may admit proxies the old fixed-issuer rule rejected. The report lists issuer counts; the user can review before apply.
- The canary reflects the local link, not the destination proxies; it cannot tell a congested uplink from a throttled ISP path. The decrease rule is deliberately conservative.
- The router breaker uses only latency and errors visible to the client. It cannot see other load on 9Router (for example the pool-ranker sync running at the same time). Mutation gap and the 2-call ceiling bound the contribution of this tool.
- Raising concurrency can exhaust Windows ephemeral ports before the canary degrades; the global cap and `EADDRNOTAVAIL` signal are the guard.

## Measured after implementation (2026-10-31 / 2026-11-01, this Windows host, home ISP)

| Run | TCP | TLS | Stability | Open | Stable |
|---|---:|---:|---:|---:|---:|
| Manual script, fixed 600 | 1,418.76 s | not measured | | 10,096 / 347,545 | 31 |
| Adaptive v1 (slot-occupancy growth) | ~3,064 s (from file times) | ~10 min | | 46,732 / 344,902 | 214 |
| Adaptive v2 (queue-depth growth, max 1500) | 2,356.9 s | 1,382.4 s | 280.2 s | 33,914 / 344,902 | 222 |

v2 trace: 356 halvings in the TCP stage, 355 from `congested`; the limit spent 38.9% of ticks at the floor (50). Canary latency was bimodal: median 38 ms, p90 1,038 ms. Halvings fired on consecutive ticks (440 -> 220 -> 110 -> 55 -> 50) from one episode, which the cooldown rule now prevents.

**High concurrency loses live endpoints.** Same 8,000-endpoint sample, fixed concurrency, 60 s between runs:

| Concurrency | Run A open | Run B open | Run C open | Slow successful connects (run B) |
|---:|---:|---:|---:|---:|
| 100 | 1,106 (repeat: 1,103) | 1,024 | 1,001 | 3.9% |
| 200 | | 810 | | 5.7% |
| 300 | | 764 | | 6.2% |
| 400 | | 660 | | 9.5% |
| 600 | 733 | 479 | 1,022 | 18.6% |
| 1,500 | 347 | | | |

- Run A: of the 399 endpoints open at 100 but not at 600, 367 were open again in a second run at 100. Noise between the two runs at 100 was 43 / 40 endpoints.
- Run C showed almost no loss at 600. The effect is real but not stable over time; it could not be predicted before a scan.
- Whether the lost endpoints are usable proxies is not established: in run C, 2 of 105 lost endpoints and 0 of 105 kept endpoints passed the TLS stage; samples too small to compare.
- Decision: TCP max lowered to 400, slow-connect signal added (it rises clearly from 400 up). Neither prevents the loss seen between 100 and 300, where the slow share moves only from 3.9% to 6.2%. A lower ceiling trades time for completeness: c=100 took 178 s per 8,000 endpoints, c=400 took 48 s.
