# Proxy Safety Auditor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-ready, standalone Proxy Safety Auditor supporting HTTP/HTTPS/SOCKS4/SOCKS5, strict SSRF protection, connectivity/TLS/DNS/header-leak/content-integrity probes, multi-provider IP intelligence/reputation, explainable risk scoring, CLI single/bulk modes, and optional Playwright browser audit.

**Architecture:** A standalone subsystem under `src/auditor/` decoupled from Next.js, 9Router, and existing dashboard state. Features layered pipeline: Parser/SSRF Guard -> Protocol Transports -> Probes -> Reputation Provider Adapters with caching/rate limiting -> Aggregator & Scorer -> CLI & Optional Browser Module. Fully verified through local mock servers and fixtures without external network dependencies.

**Tech Stack:** Node.js (v20+ / native modules: `net`, `tls`, `http`, `https`, `crypto`, `dns/promises`), TypeScript (strict mode), optional Playwright for browser audit, Node.js native test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-09-22-proxy-safety-auditor-design.md`

## Global Constraints

- **Security First:** Never expose proxy passwords, API keys, Authorization headers, or cookies in logs, outputs, or error objects. Redact credentials as `username:********`.
- **SSRF Immunity:** Strictly block loopback (127.0.0.0/8, ::1), RFC1918 private IPv4, IPv4/IPv6 link-local, multicast, unspecified, cloud metadata (169.254.169.254) before establishing any socket connection. Allow bypass ONLY if explicit option `allowPrivateTargets: true` is passed for local testing.
- **TLS Integrity:** Never disable TLS certificate/hostname/chain verification on HTTPS proxies. Direct vs proxy certificate differences produce `possibleMitm: true` and `TLS_UNEXPECTED_BEHAVIOR` without declaring certainty.
- **Provider Resilience:** Provider API failures/exhaustions (IPinfo, IPQS, AbuseIPDB) must NEVER crash or fail the audit; report `status: "unavailable"` or `status: "error"`.
- **Zero Anti-Bot:** Do not implement fingerprint spoofing, CAPTCHA bypass, or anti-fraud evasion.
- **Testing:** Unit and integration tests must run deterministically using local in-memory/mock proxy servers, never relying on random public proxies or paid API tokens.

---

### Task 1: Core Types, Parser & Robust SSRF Protection

**Files:**
- Create: `src/auditor/types.ts`
- Create: `src/auditor/parser.ts`
- Create: `src/auditor/security/ip-policy.ts`
- Create: `src/auditor/security/ssrf.ts`
- Create: `tests/auditor/parser.test.ts`
- Create: `tests/auditor/ssrf.test.ts`

**Interfaces:**
- Produces:
  - `ProxyProtocol = "http" | "https" | "socks4" | "socks5"`
  - `ParsedProxyInput` (internal connection info with credentials)
  - `RedactedProxyInfo` (public representation with `username:********`)
  - `parseProxyInput(input: ProxyInput): { parsed: ParsedProxyInput; redacted: RedactedProxyInfo }`
  - `validateTargetHost(host: string, options?: { allowPrivate?: boolean }): Promise<{ valid: boolean; resolvedIps: string[]; reason?: string }>`

- [ ] **Step 1: Write failing tests for parser and SSRF protection**

Create `tests/auditor/parser.test.ts`:
- Parsing string URLs: `http://user:pass@1.2.3.4:8080`, `socks5://[::1]:1080`, `socks4://1.1.1.1:1080`
- Parsing typed object inputs
- Redaction of credentials in public output and string representations
- Rejection of malformed ports, unsupported protocols, empty hosts

Create `tests/auditor/ssrf.test.ts`:
- Rejection of `127.0.0.1`, `localhost`, `0.0.0.0`, `10.0.0.1`, `172.16.0.1`, `192.168.1.1`
- Rejection of cloud metadata IP `169.254.169.254` and IPv6 link-local `fe80::`
- Resolution of domain names and rejection if any resolved A/AAAA record points to private IP
- Option `allowPrivateTargets: true` allows private IP targets for local test fixtures

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import tsx --test tests/auditor/parser.test.ts tests/auditor/ssrf.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement domain types, parser and IP security policy**

Implement:
- `src/auditor/types.ts`: Comprehensive type definitions matching the spec (`ProxyAuditResult`, scores, verdicts, risks, probe results).
- `src/auditor/parser.ts`: Robust URL and object parser with credential extraction and redaction.
- `src/auditor/security/ip-policy.ts`: Strict CIDR and IP range checkers for RFC1918, loopback, link-local, multicast, metadata addresses.
- `src/auditor/security/ssrf.ts`: DNS resolution with IP policy validation for all returned records.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/parser.test.ts tests/auditor/ssrf.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/types.ts src/auditor/parser.ts src/auditor/security/ tests/auditor/parser.test.ts tests/auditor/ssrf.test.ts
git commit -m "feat(auditor): implement core types, parser, and ssrf protection"
```

---

### Task 2: Multi-Protocol Transports (HTTP, HTTPS, SOCKS4, SOCKS5)

**Files:**
- Create: `src/auditor/transport/common.ts`
- Create: `src/auditor/transport/http.ts`
- Create: `src/auditor/transport/socks4.ts`
- Create: `src/auditor/transport/socks5.ts`
- Create: `src/auditor/transport/index.ts`
- Create: `tests/auditor/fixtures/mock-proxies.ts`
- Create: `tests/auditor/transport.test.ts`

**Interfaces:**
- Produces:
  - `openProxyTunnel(proxy: ParsedProxyInput, target: { host: string; port: number }, options: TransportOptions): Promise<{ socket: net.Socket; timings: TimingBreakdown }>`
  - `requestThroughProxy(socket: net.Socket, req: HttpRequestOptions): Promise<HttpResponse>`

- [ ] **Step 1: Create local mock proxy servers fixture**

In `tests/auditor/fixtures/mock-proxies.ts`:
- Local HTTP proxy server (supports CONNECT and forward GET, auth and no-auth)
- Local SOCKS4 proxy server (binary protocol handshake)
- Local SOCKS5 proxy server (binary handshake, authentication methods 0x00 and 0x02, IPv4 and domain/remote DNS targets)

- [ ] **Step 2: Write failing tests for transport layers**

In `tests/auditor/transport.test.ts`:
- Successful tunnel creation through HTTP proxy (auth and no-auth)
- Successful tunnel creation through SOCKS4 proxy
- Successful tunnel creation through SOCKS5 proxy (auth and no-auth, domain target vs IPv4 target)
- Accurate phase timing measurements (`dnsMs`, `tcpConnectMs`, `proxyHandshakeMs`)
- Correct error propagation on auth failure, handshake timeout, and connection refusal

- [ ] **Step 3: Run transport tests and verify RED**

Run: `node --import tsx --test tests/auditor/transport.test.ts`
Expected: FAIL (transports not implemented).

- [ ] **Step 4: Implement transport handlers**

Implement:
- `src/auditor/transport/common.ts`: Socket reader with timeouts, timing trackers, stream buffering.
- `src/auditor/transport/http.ts`: HTTP CONNECT tunnel with optional Basic proxy authentication and raw HTTP request dispatch.
- `src/auditor/transport/socks4.ts`: SOCKS4 client protocol (0x04 connect code, user ID handling, port/IP packing).
- `src/auditor/transport/socks5.ts`: SOCKS5 client protocol (methods negotiation, username/password sub-negotiation 0x01, IPv4/domain target packing).
- `src/auditor/transport/index.ts`: Unified router selecting transport by protocol.

- [ ] **Step 5: Run transport tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/transport.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/auditor/transport/ tests/auditor/fixtures/mock-proxies.ts tests/auditor/transport.test.ts
git commit -m "feat(auditor): implement HTTP, SOCKS4, and SOCKS5 transport layers"
```

---

### Task 3: Core Probes (Exit IP, Baseline, Header Leaks, TLS & Content Integrity)

**Files:**
- Create: `src/auditor/probes/exit-ip.ts`
- Create: `src/auditor/probes/baseline.ts`
- Create: `src/auditor/probes/headers.ts`
- Create: `src/auditor/probes/tls.ts`
- Create: `src/auditor/probes/content-integrity.ts`
- Create: `src/auditor/probes/dns.ts`
- Create: `tests/auditor/probes.test.ts`

**Interfaces:**
- Produces:
  - `probeExitIp(proxy: ParsedProxyInput, options: ProbeOptions): Promise<ExitIpResult>`
  - `probeDirectBaseline(options: ProbeOptions): Promise<BaselineResult>`
  - `probeHeaderLeak(proxy: ParsedProxyInput, baselineIps: string[], options: ProbeOptions): Promise<HeaderLeakResult>`
  - `probeTlsIntegrity(proxy: ParsedProxyInput, options: TlsProbeOptions): Promise<TlsResult>`
  - `probeContentIntegrity(proxy: ParsedProxyInput, options: IntegrityOptions): Promise<ContentIntegrityResult>`
  - `probeDnsBehavior(proxy: ParsedProxyInput, options: DnsProbeOptions): Promise<DnsResult>`

- [ ] **Step 1: Write failing probe tests**

In `tests/auditor/probes.test.ts`:
- Exit IP observation with multiple mock echo targets and consistency checks
- Header leak detection identifying `X-Forwarded-For`, `Via`, `X-Real-IP` matching baseline IP
- TLS certificate verification with strict chain/hostname checks, detecting invalid certs
- Controlled endpoint SPKI SHA-256 pin verification and HMAC/signature verification
- SOCKS5 DNS resolution mode detection (local vs remote)

- [ ] **Step 2: Run probe tests and verify RED**

Run: `node --import tsx --test tests/auditor/probes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement core audit probes**

Implement:
- `src/auditor/probes/exit-ip.ts`: Multi-endpoint IP querying with discrepancy detection.
- `src/auditor/probes/baseline.ts`: Direct IP acquisition without proxy for reference.
- `src/auditor/probes/headers.ts`: Inspection of echo response headers against baseline IP with redaction.
- `src/auditor/probes/tls.ts`: TLS socket connection with certificate validation, cipher extraction, and `possibleMitm` flag.
- `src/auditor/probes/content-integrity.ts`: Controlled endpoint fetch with SPKI hash validation and HMAC/payload verification.
- `src/auditor/probes/dns.ts`: DNS leak evaluation distinguishing HTTP vs SOCKS5h remote resolution.

- [ ] **Step 4: Run probe tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/probes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/probes/ tests/auditor/probes.test.ts
git commit -m "feat(auditor): implement exit-ip, header-leak, tls, and integrity probes"
```

---

### Task 4: Stability, IP Rotation & Reputation Provider Adapters

**Files:**
- Create: `src/auditor/probes/stability.ts`
- Create: `src/auditor/reputation/provider.ts`
- Create: `src/auditor/reputation/cache.ts`
- Create: `src/auditor/reputation/limiter.ts`
- Create: `src/auditor/reputation/ipinfo.ts`
- Create: `src/auditor/reputation/ipqs.ts`
- Create: `src/auditor/reputation/abuseipdb.ts`
- Create: `src/auditor/reputation/aggregate.ts`
- Create: `tests/auditor/stability.test.ts`
- Create: `tests/auditor/reputation.test.ts`

**Interfaces:**
- Produces:
  - `probeStabilityAndRotation(proxy: ParsedProxyInput, attempts: number, options: ProbeOptions): Promise<{ stability: StabilityResult; rotation: RotationResult }>`
  - `fetchReputationSignals(ip: string, options: ReputationOptions): Promise<{ network: NetworkResult; reputation: ReputationResult; raw: RawProviderReport[] }>`

- [ ] **Step 1: Write failing stability and reputation tests**

In `tests/auditor/stability.test.ts`:
- Bounded repeated requests measuring min/avg/p50/p95/max latency, jitter, and success rate
- Detection of IP changes across requests (rotation reporting)

In `tests/auditor/reputation.test.ts`:
- IPinfo adapter parsing ASN, ISP, country, hosting indicator
- IPQualityScore adapter parsing fraud score, VPN, proxy, Tor indicators
- AbuseIPDB adapter parsing abuse confidence score, report count
- Caching layer by IP with configurable TTLs (24h ASN, 6h reputation)
- Graceful degradation when API keys are missing or provider endpoints return 429/500 (returns status `unavailable`/`error` without throwing)
- Aggregator normalizing signals and distinguishing privacy from malicious abuse

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import tsx --test tests/auditor/stability.test.ts tests/auditor/reputation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement stability probe, caching, and provider adapters**

Implement:
- `src/auditor/probes/stability.ts`: Repeated request loop with latency math (percentiles, jitter, success rate).
- `src/auditor/reputation/cache.ts`: In-memory and file-backed cache with atomic writes and expiry.
- `src/auditor/reputation/limiter.ts`: Token-bucket rate limiter per provider.
- `src/auditor/reputation/ipinfo.ts`, `ipqs.ts`, `abuseipdb.ts`: Typed HTTP client adapters.
- `src/auditor/reputation/aggregate.ts`: Signal consensus logic ensuring no single provider dictates failure.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/stability.test.ts tests/auditor/reputation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/probes/stability.ts src/auditor/reputation/ tests/auditor/stability.test.ts tests/auditor/reputation.test.ts
git commit -m "feat(auditor): implement stability probe and reputation provider adapters"
```

---

### Task 5: Scoring, Explainable Risk Factors & Overall Verdict

**Files:**
- Create: `src/auditor/scoring/scores.ts`
- Create: `src/auditor/scoring/verdict.ts`
- Create: `src/auditor/scoring/explanations.ts`
- Create: `tests/auditor/scoring.test.ts`

**Interfaces:**
- Produces:
  - `calculateScores(evidence: AuditEvidence): ScoresResult`
  - `determineVerdict(evidence: AuditEvidence, scores: ScoresResult): { verdict: "PASS" | "WARN" | "FAIL" | "UNKNOWN"; riskFactors: RiskFactor[]; recommendations: string[] }`

- [ ] **Step 1: Write failing scoring and verdict tests**

In `tests/auditor/scoring.test.ts`:
- Category scoring: Transport Security (35%), Privacy (30%), Reputation (20%), Reliability (15%)
- Critical failure overrides: SSRF violation, connection failure, TLS certificate error, SPKI pin mismatch, content tampering, or origin IP leak force `FAIL` regardless of score
- Warning conditions: High latency, abuse history, unstable exit IP, or DNS leak produce `WARN`
- Incomplete checks produce `UNKNOWN`
- Verification of explainable `riskFactors` with severity levels (`info`, `low`, `medium`, `high`, `critical`) and actionable recommendations

- [ ] **Step 2: Run tests and verify RED**

Run: `node --import tsx --test tests/auditor/scoring.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement scoring engine and verdict logic**

Implement:
- `src/auditor/scoring/scores.ts`: Weighted score calculations with nullable components for missing data.
- `src/auditor/scoring/verdict.ts`: Strict precedence rules ensuring security violations unconditionally override numeric scores.
- `src/auditor/scoring/explanations.ts`: Generator mapping probe anomalies to structured risk factors and conservative operator recommendations.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/scoring.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/scoring/ tests/auditor/scoring.test.ts
git commit -m "feat(auditor): implement scoring engine, risk explanations, and verdict logic"
```

---

### Task 6: Main API Orchestration & Optional Playwright Browser Module

**Files:**
- Create: `src/auditor/api.ts`
- Create: `src/auditor/browser/api.ts`
- Create: `src/auditor/index.ts`
- Create: `tests/auditor/api.test.ts`

**Interfaces:**
- Produces:
  - `checkProxy(proxy: ProxyInput, options?: ProxyAuditOptions): Promise<ProxyAuditResult>`
  - `auditProxyInBrowser(proxy: ProxyInput, options?: BrowserAuditOptions): Promise<BrowserAuditResult>`

- [ ] **Step 1: Write end-to-end integration tests for checkProxy()**

In `tests/auditor/api.test.ts`:
- Auditing working HTTP proxy -> returns `PASS` with complete score breakdown and exit IP
- Auditing header-leaking proxy -> returns `FAIL` with `ORIGIN_IP_EXPOSED` risk factor
- Auditing TLS-tampering proxy -> returns `FAIL` with `possibleMitm: true`
- Auditing proxy with SSRF target (127.0.0.1) -> rejected with `FAIL` and SSRF violation flag
- Dynamic import test for Playwright browser module (graceful error when Playwright is uninstalled or optional)

- [ ] **Step 2: Run integration tests and verify RED**

Run: `node --import tsx --test tests/auditor/api.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement checkProxy and browser audit module**

Implement:
- `src/auditor/api.ts`: Master orchestrator sequencing all phases under unified deadline and cancellation token.
- `src/auditor/browser/api.ts`: Dynamic loader for Playwright (`import("playwright")`), testing WebRTC candidate leakage, IPv4/IPv6 browser exit IP, without applying anti-bot evasion.
- `src/auditor/index.ts`: Package entry point exporting types, `checkProxy`, and `auditProxyInBrowser`.

- [ ] **Step 4: Run integration tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/api.ts src/auditor/browser/ src/auditor/index.ts tests/auditor/api.test.ts
git commit -m "feat(auditor): orchestrate checkProxy pipeline and optional browser audit"
```

---

### Task 7: CLI Interface & Bulk Processing Mode

**Files:**
- Create: `src/auditor/cli/main.ts`
- Create: `src/auditor/cli/formatters.ts`
- Create: `src/auditor/cli/bulk.ts`
- Modify: `package.json` (add `"bin": { "proxy-audit": "dist/auditor/cli/main.js" }` or tsx wrapper script)
- Create: `tests/auditor/cli.test.ts`

**Interfaces:**
- Produces CLI executable commands:
  - `proxy-audit check <proxy> [--json] [--pretty] [--timeout <ms>] [--attempts <n>]`
  - `proxy-audit check-file <file> [--concurrency <n>] [--output <json>] [--csv <csv>]`
  - `proxy-audit browser-check <proxy>`

- [ ] **Step 1: Write failing CLI tests**

In `tests/auditor/cli.test.ts`:
- Single check printing formatted human-readable report with credential redaction
- Single check with `--json` outputting valid, redacted `ProxyAuditResult`
- Bulk check reading proxy list with concurrency limit, writing `results.json` and `results.csv`
- Error exit codes on invalid arguments or file not found

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `node --import tsx --test tests/auditor/cli.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement CLI tool and bulk processor**

Implement:
- `src/auditor/cli/formatters.ts`: Terminal human report with symbols/colors, plus CSV serializer matching required columns.
- `src/auditor/cli/bulk.ts`: Controlled queue processing proxies from file concurrently (default 5).
- `src/auditor/cli/main.ts`: CLI argument parser handling `check`, `check-file`, `browser-check`.
- Update `package.json` with CLI entry point.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run: `node --import tsx --test tests/auditor/cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auditor/cli/ package.json tests/auditor/cli.test.ts
git commit -m "feat(auditor): implement proxy-audit CLI and bulk processing"
```

---

### Task 8: Documentation, Verification Scripts & Project Polish

**Files:**
- Modify: `.env.example`
- Modify: `package.json` (scripts: `test:auditor`, `typecheck`, `lint`)
- Create: `docs/PROXY_AUDITOR.md`
- Modify: `README.md`

- [ ] **Step 1: Update environment templates and package scripts**

Add `.env.example` entries:
```env
IPINFO_TOKEN=
IPQS_API_KEY=
ABUSEIPDB_API_KEY=
CONTROL_ENDPOINT=
CONTROL_SPKI_SHA256=
```
Add package scripts in `package.json`:
- `"test:auditor": "node --import tsx --test tests/auditor/**/*.test.ts"`

- [ ] **Step 2: Write documentation**

Create `docs/PROXY_AUDITOR.md` (and link from `README.md`):
- Architecture and pipeline breakdown
- CLI & Programmatic API reference with full types
- Security principles (SSRF, credential masking)
- Explanation of scores, weights, verdicts (PASS/WARN/FAIL/UNKNOWN)
- Example JSON output and CSV format
- Playwright browser audit setup instructions

- [ ] **Step 3: Run comprehensive verification**

Execute all verification gates:
```bash
npm test
node --import tsx --test tests/auditor/**/*.test.ts
npm run build
```
Verify 100% tests pass and zero TypeScript errors exist.

- [ ] **Step 4: Commit**

```bash
git add .env.example package.json docs/PROXY_AUDITOR.md README.md
git commit -m "docs(auditor): add comprehensive documentation and test scripts"
```
