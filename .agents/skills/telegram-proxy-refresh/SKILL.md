---
name: telegram-proxy-refresh
description: Project-only skill for proxy-checker. Use when the user asks to refresh, update, or test new proxy lists downloaded from Telegram ("cập nhật proxies mới", "proxy mới từ telegram", "scan proxies hôm nay", "refresh proxies"). Scans today's http/https/socks5 .txt files in Downloads/Telegram Desktop with self-tuning concurrency, filters unsafe or dead proxies, adds survivors to 9Router under a hard load budget, and reports results.
---

# Telegram proxy refresh (proxy-checker)

Source files are untrusted. They are parsed as plain text with a strict regex and never executed. Spec: `docs/superpowers/specs/2026-10-31-telegram-proxy-refresh-adaptive-design.md`.

## Procedure

1. **Scan only (no router writes).** From the repo root:
   `node --import tsx .agents/skills/telegram-proxy-refresh/scripts/refresh.mjs scan`
   Start it with `async: true` and wait; do not poll. Concurrency tunes itself, so the duration depends on the network. Record the per-stage timings from the report.
2. **Read the report.** Stop and tell the user if: `stable` is 0, `rejectedFiles` is non-empty, `controller.*.decreases` is large (network or socket pressure), or `issuers` contains an unexpected issuer.
3. **Apply to 9Router** only after the user agrees:
   `node --import tsx .agents/skills/telegram-proxy-refresh/scripts/refresh.mjs apply`
   Uses the same work folder (`%TEMP%/proxy-refresh-<date>`); pass `--out <dir>` if the date changed. Refuses to run unless the scan finished (`state.json`) and `stable.jsonl` still matches it.
4. **Report** the numbers below. Never print credentials or the router URL.

`run` does scan then apply in one go; `run --dry-run` is `scan`. Use `run` only when the user says to apply directly.

## Flags and exit codes

| Flag | Meaning |
|---|---|
| `--dir D` | Source folder (default `~/Downloads/Telegram Desktop`) |
| `--since YYYY-MM-DD` | Only files modified from that local date (default today) |
| `--out D` | Work folder |
| `--resume` | Reuse stage files whose fingerprint still matches the selected files; a new, resized or touched file makes them stale and they are recomputed |
| `--max-new N` | `apply` refuses to create more than N new pools (default 200) |

| Exit | Meaning | Action |
|---|---|---|
| 0 | Done | Report |
| 3 | Router overloaded, apply is partial | Wait a few minutes, rerun `apply` with the same `--out`; the ledger resumes and adopts pools created before the stop |
| 4 | Precondition or network failure (scan unfinished, tampered `stable.jsonl`, too many new pools, no internet) | Fix the cause; nothing was written |
| 2 | Usage error | Fix the flag |

## What the script does

| Stage | Rule |
|---|---|
| Select | `.txt` named `http*`, `https*`, `socks5*`, modified since local midnight. Symlinks, files over 20 MB and files with NUL bytes are skipped and listed by name. `https*` lists are treated as HTTP proxies. |
| Parse | Only `[proto://]IPv4:port`, public addresses only (no private, loopback, CGNAT/Tailscale, link-local). Lines over 300 chars and control characters are rejected. |
| Socket gate | Every connection re-checks the destination is public, even after parsing. |
| TCP | Short connect test. |
| Sniff + TLS (2 rounds) | One throwaway SOCKS5 greeting decides the protocol; then a tunnel to `www.google.com:443` and strict TLS verification. A proxy that re-signs HTTPS fails here. `HEAD /generate_204` must return 204. Each probe has a 12 s hard deadline and destroys every socket it opened. |
| Stability | 3 more rounds; all must pass and the certificate issuer must stay the same. The issuer is recorded as evidence, not matched against an allowlist. |
| Concurrency | Per-stage limits grow while work is queued and halve on socket-resource errors, slow successful connects (>= 12% took >= 900 ms), local-network congestion (canary to `1.1.1.1` / `8.8.8.8`) or event-loop lag. TCP is capped at 400: higher concurrency lost up to 56% of live endpoints on this network (measured, see spec). Dead proxies never count as a signal. Each scan writes `controller-trace.json` to the work folder. |
| 9Router | At most 2 calls in flight, 150 ms between writes, per-kind circuit breaker (429/503, repeated failures, latency). New pools are created inactive, tested twice, deleted if both fail, kept in reserve otherwise. Only pools this run created or adopted are ever changed. |

## Rules

- New pools stay in reserve. Promotion to Active belongs to the pool-ranker sync; do not activate manually unless asked.
- Never modify or delete pre-existing pools.
- Pools that pass only one of two router tests are reported as `flaky` and kept in reserve.
- socks4 is not supported (0 survivors in the first real run, router support unverified).
- Scan results live in the work folder only; they are not written to `data/proxies.sqlite3`.
- Do not run the app locally and on the Pi at the same time (shared proxies). Router URL and credentials come from `data/settings.json`; never print them.
- Passing TLS to Google does not prove a proxy does not log or read plain HTTP traffic. Say so if asked about safety.
- Work files in `%TEMP%` are scratch. Delete them when the user confirms the result.

## Self-check

`node --import tsx --test tests/telegram-proxy-refresh.test.ts` covers the parser, fingerprint, socket gate, probes (loopback fixture proxies, no public network), sniff, resume, the concurrency controller and the router gate/apply with a fake router. `refresh.mjs selftest` is a quick parser smoke check. Run both after editing the scripts.

## Known quirks

| Symptom | Cause |
|---|---|
| `Assertion failed ... UV_HANDLE_CLOSING` on exit | `process.exit()` while sockets close, Windows only. The script waits before exiting; keep that. |
| `Request was cancelled` in a router test | Router-side timeout; that round counts as failed for the proxy, not for the breaker. |
| `Cannot find module` for `.ts` | Run with `node --import tsx`, not plain `node`. |
| `perf_hooks.monitorEventLoopDelay` reads low | Measured on this machine: a 400 ms block gave p95 27 ms. Loop lag is measured from a 20 ms interval timer instead. |
