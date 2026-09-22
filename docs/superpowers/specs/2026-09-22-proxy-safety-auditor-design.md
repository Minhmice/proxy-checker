# Proxy Safety Auditor Design

## Summary

Build a standalone Node.js/TypeScript proxy safety auditor inside this repository. The auditor exposes `checkProxy(proxy, options?)`, a CLI, bulk-file processing, provider adapters, explainable scoring, and an optional Playwright browser module. It does not depend on Next.js, 9Router, dashboard state, or existing lifecycle code. Dashboard integration is a later phase.

The product evaluates defensive network safety and reliability. It must not optimize for anti-fraud evasion, CAPTCHA bypass, account restrictions, platform detection, or browser fingerprint manipulation.

## Goals

- Support HTTP, HTTPS, SOCKS4, and SOCKS5 proxy inputs as URLs or typed objects.
- Protect the auditor from SSRF before opening a connection.
- Measure connectivity phases, public exit identity, origin leakage, TLS integrity, DNS behavior, reputation, stability, and rotation.
- Preserve raw evidence while returning conservative, explainable scores and verdicts.
- Operate without a browser or paid provider keys.
- Provide CLI single-check and bounded bulk modes with redacted output.
- Provide optional Playwright leak auditing without making Playwright a core dependency.
- Use deterministic local integration fixtures instead of random public proxies.

## Non-goals

- No anti-bot, anti-fraud, CAPTCHA, platform-detection, fingerprint-spoofing, or account-abuse functionality.
- No dashboard integration in this phase.
- No claim that a certificate difference alone proves MITM.
- No claim that VPN, proxy, Tor, hosting, or consumer ISP classification alone implies malicious behavior.
- No false certainty for DNS, reputation, network type, or browser leakage when measurement is unavailable.
- No load testing or excessive traffic.

## Repository Boundary

Create the subsystem under `src/auditor/` without converting the repository to a monorepo:

```text
src/auditor/
  api.ts
  types.ts
  parser.ts
  security/
    ssrf.ts
    ip-policy.ts
  transport/
    common.ts
    http.ts
    socks4.ts
    socks5.ts
  probes/
    connectivity.ts
    exit-ip.ts
    baseline.ts
    headers.ts
    tls.ts
    content-integrity.ts
    dns.ts
    stability.ts
  reputation/
    provider.ts
    ipinfo.ts
    ipqs.ts
    abuseipdb.ts
    aggregate.ts
    cache.ts
    limiter.ts
  scoring/
    scores.ts
    verdict.ts
    explanations.ts
  browser/
    api.ts
  cli/
    main.ts
```

Tests live under `tests/auditor/`, separated into unit and integration fixture suites. Existing `src/server/checker.ts`, Diagnostics, and 9Router lifecycle do not import auditor internals during this phase. Later dashboard integration may consume only the exported public API.

## Public API

```ts
export function checkProxy(
  proxy: ProxyInput,
  options?: ProxyAuditOptions
): Promise<ProxyAuditResult>;
```

Supported input:

```ts
type ProxyProtocol = "http" | "https" | "socks4" | "socks5";

type ProxyInput = string | {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
};
```

Supported URL forms include credentials and bracketed IPv6 hosts. Parsed/public output contains protocol, hostname, port, and `authentication.present`; it never contains the password. Display and logging use `username:********` when authentication exists.

`ProxyAuditOptions` includes:

- per-phase and total timeouts;
- `attempts`, default 5;
- baseline enabled by default;
- reputation enabled by default;
- DNS mode for SOCKS5: `local`, `remote`, or both;
- controlled endpoint and expected SPKI/content configuration;
- provider credentials/configuration;
- cache TTLs;
- response-size limit;
- abort signal;
- `allowPrivateTargets`, default false and intended only for local fixtures/development.

## Result Contract

`ProxyAuditResult` contains:

- redacted proxy identity;
- `PASS | WARN | FAIL | UNKNOWN` verdict;
- nullable component and overall scores;
- security input-validation and SSRF evidence;
- connectivity phase outcomes/timings;
- optional direct baseline IPs;
- exit-IP observations and consistency;
- network classification with evidence source;
- TLS certificate/protocol/cipher/ALPN details;
- DNS mode, leakage state, resolvers, and notes;
- header leakage evidence;
- controlled content integrity evidence;
- normalized and raw reputation-provider reports;
- stability statistics and exit-IP rotation;
- optional browser audit;
- explainable risk factors and recommendations;
- started/completed timestamps, duration, schema version, and tool version.

Unknown measurements use `null`, `unknown`, or provider `unavailable`; they are never silently converted to safe values.

## Execution Pipeline

```text
parse/redact input
  -> resolve proxy hostname
  -> SSRF validation of every A/AAAA result
  -> transport setup and authentication
  -> HTTP/TLS capability probes
  -> exit-IP observations
  -> optional direct baseline
  -> header-origin leak probe
  -> TLS and controlled integrity probes
  -> DNS-mode evidence
  -> bounded repeated stability/rotation checks
  -> provider adapters and cache
  -> evidence aggregation
  -> scores, risks, verdict, recommendations
```

Every phase receives a shared deadline and `AbortSignal`. A phase cannot extend the total deadline. Results retain partial evidence if later phases fail.

## Parsing and Redaction

The parser validates scheme, hostname, port, credentials, URL encoding, bracketed IPv6, and malformed inputs. It returns an internal credential-bearing connection object and a separate redacted public identity. Secret-bearing values use non-enumerated/internal fields where practical and never appear in structured logs or serialized results.

All logger fields pass through a redactor that removes proxy passwords, provider keys, authorization headers, cookies, and tokens.

## SSRF Protection

Strict protection is enabled by default before any proxy connection:

- resolve proxy hostname first;
- validate every returned IPv4/IPv6 address;
- reject loopback, RFC1918, carrier-grade NAT, link-local, multicast, unspecified, documentation/reserved ranges where unsafe, and cloud metadata addresses;
- explicitly reject `169.254.169.254` and IPv6 metadata/link-local equivalents;
- connect to a validated resolved address while retaining the original hostname for TLS/SNI where applicable;
- revalidate resolution before reconnects and compare address sets to reduce DNS-rebinding exposure;
- validate every redirect target before following it;
- limit redirect count;
- never accept redirects to blocked IP classes.

`allowPrivateTargets: true` permits local/private fixture addresses only when explicitly supplied. The result records that protection was overridden.

## Transport Layer

Transport adapters share a small connection interface and emit phase timings:

```ts
{
  dnsMs,
  tcpConnectMs,
  proxyHandshakeMs,
  tlsHandshakeMs,
  timeToFirstByteMs,
  totalMs
}
```

Defaults:

- DNS 3000 ms;
- TCP 5000 ms;
- proxy handshake 5000 ms;
- HTTP 8000 ms;
- total 15000 ms.

HTTP handles forward requests and CONNECT. HTTPS proxy transport verifies TLS to the proxy before forwarding. SOCKS4 supports IPv4 and SOCKS4a hostname behavior where explicitly selected. SOCKS5 supports no-auth and username/password authentication plus local and remote DNS modes. TLS validation is never disabled to make a proxy pass.

Responses have strict header/body size limits, decompression limits, redirect limits, and cleanup in every success/error path.

## Exit IP and Baseline

Use at least two independently configured HTTPS IP-echo endpoints when possible. Each observation records endpoint, timestamp, IP family, value, latency, and error. Disagreement sets `exitIp.consistent = false`; it does not select one endpoint as absolute truth.

Optional baseline requests run directly through separate connections. Baseline failure does not fail the proxy audit but prevents definitive origin-leak conclusions.

## Header Leak Probe

Send a bounded request through the proxy to an echo endpoint and inspect common forwarding/IP-bearing headers including `Forwarded`, `X-Forwarded-For`, `X-Real-IP`, `Via`, `Client-IP`, `True-Client-IP`, `CF-Connecting-IP`, and `Proxy-Connection`.

Header values are redacted before output. If a known baseline public IP is visible to the destination, emit critical `ORIGIN_IP_EXPOSED` and force `FAIL`. Without a baseline, report observed suspicious headers but do not claim origin exposure.

## TLS and Controlled Integrity

HTTPS probes keep certificate, hostname, and chain verification enabled and record protocol, cipher, ALPN, issuer, subject, expiration, and verification errors.

Direct and proxied certificate differences may produce `TLS_UNEXPECTED_BEHAVIOR`; they do not prove MITM. Verification failure through the proxy while direct verification succeeds produces `possibleMitm: true` and a security failure.

When `CONTROL_ENDPOINT` is configured:

- validate redirect targets;
- verify standard TLS;
- verify configured SPKI SHA-256 pin;
- request a bounded nonce-bearing payload;
- verify expected signed/HMAC content or deterministic response contract;
- pin mismatch or integrity failure forces `FAIL`.

Plain HTTP is not used for primary content-integrity assurance.

## DNS Assessment

HTTP proxy DNS behavior and SOCKS behavior are reported separately. SOCKS5 can run both local-resolution and remote-resolution probes. The result records `local | remote | unknown`, evidence, resolver observations when a controlled endpoint can provide them, and notes.

`leakDetected` is `true` only with positive evidence, `false` only when the controlled measurement establishes absence under the tested mode, and `null` when inconclusive.

## Stability and Rotation

Default stability run performs five bounded, non-overlapping requests. It records attempts, successes, failures, timeouts, HTTP errors, exit-IP observations, and latency distribution: minimum, average, p50, p95, maximum, and jitter.

Rotation reports unique exit IPs and observations. Rotation is informational unless instability or a security policy makes it risky. The test is a health check, not a load test.

## Reputation Providers

Define a stable adapter contract:

```ts
interface ReputationProvider {
  readonly name: string;
  check(ip: string, context: ProviderContext): Promise<ProviderReport>;
}
```

Initial adapters:

- IPinfo;
- IPQualityScore;
- AbuseIPDB.

Adapters run in parallel under a small provider concurrency limit. Each has independent timeout, rate limiter, schema validation, cache key, and failure mapping. Missing credentials return `unavailable`. Provider quota errors also return `unavailable`. Network/schema errors return `error`. No provider failure crashes the audit.

Cache by exit IP:

- IP/ASN metadata default 24 hours;
- reputation default 6 hours.

Connectivity results are never cached as current health. Cache writes are atomic; corrupted cache entries are ignored.

Aggregation preserves raw reports and distinguishes privacy classification from malicious reputation. VPN/proxy/Tor signals alone do not force failure.

## Network Classification

Return ASN, AS name, ISP, organization, geography, network type, and classification evidence. Types are residential, mobile, hosting, datacenter, education, business, or unknown. Consumer ISP ownership alone is insufficient to claim residential; ambiguous evidence returns unknown.

## Scores, Risks, and Verdict

Component scores:

- transport security, weight 35%;
- privacy, weight 30%;
- reputation, weight 20%;
- reliability, weight 15%.

Missing evidence yields a nullable component. Overall safety is calculated only when minimum transport and identity evidence exists. Every deduction creates an explainable risk factor with severity, stable code, message, and evidence.

Verdict precedence:

1. `FAIL`: SSRF violation, connection failure, invalid TLS certificate, controlled pin/integrity failure, confirmed origin-IP exposure, or other critical security condition.
2. `WARN`: operational proxy with significant instability, latency, abuse consensus, confirmed DNS leak, or suspicious but unconfirmed TLS behavior.
3. `PASS`: required transport/TLS/privacy/reliability probes complete without critical/high risks and meet configured thresholds.
4. `UNKNOWN`: insufficient required measurements or infrastructure unavailable.

Critical risks override numeric scores.

## Browser Module

`src/auditor/browser/api.ts` exports `auditProxyInBrowser`. It dynamically imports Playwright only when called. The core API and normal CLI checks do not depend on Playwright.

The module launches a fresh isolated context, configures the proxy, and measures browser exit IP, IPv4/IPv6 consistency, WebRTC candidates, origin exposure, and agreement with the network core. It does not alter fingerprints or implement anti-bot evasion. Missing Playwright returns a clear optional-dependency error without affecting the network audit.

## CLI

Expose `proxy-audit` through `package.json`:

```text
proxy-audit check <proxy>
proxy-audit check-file <path>
proxy-audit browser-check <proxy>
```

Options include `--json`, `--pretty`, `--timeout`, `--attempts`, `--no-reputation`, `--browser`, bulk `--concurrency`, JSON output path, and optional CSV output path.

Bulk concurrency defaults to 5. Results preserve input order unless streaming output is explicitly requested. JSON, CSV, human output, errors, and logs redact credentials. CSV includes verdict, scores, exit/network/TLS/leak/reputation/stability fields and compact warning codes.

## Logging

Use structured logger events with debug/info/warn/error levels. The logger accepts typed fields and always redacts credentials, keys, auth headers, cookies, and tokens. Human CLI progress goes to stderr; machine JSON/CSV remains clean on stdout/files.

## Environment

Extend `.env.example` with empty values:

```text
IPINFO_TOKEN=
IPQS_API_KEY=
ABUSEIPDB_API_KEY=
CONTROL_ENDPOINT=
CONTROL_SPKI_SHA256=
```

Secrets are optional and never committed. Provider status is unavailable without credentials.

## Testing

### Unit

- URL/object parsing, encoded credentials, IPv6, malformed input, redaction;
- IP range classification, multi-record DNS, metadata rejection, rebinding changes;
- HTTP/HTTPS/SOCKS4/SOCKS5 handshakes and authentication;
- local/remote DNS mode;
- header leak detection;
- TLS validation, pin mismatch, certificate evidence;
- redirect/response/decompression limits;
- percentile, jitter, rotation, provider aggregation, scores, verdict precedence;
- cache TTL/corruption and rate-limit behavior.

### Integration Fixtures

Local controlled fixtures provide working HTTP forward proxy, HTTPS CONNECT proxy, SOCKS4, SOCKS5 local/remote DNS, authentication success/failure, dead/slow/rotating proxy, header-leaking proxy, TLS-breaking proxy, controlled payload server, redirects to private/metadata targets, oversized response, redirect loop, and protocol downgrade.

Fixtures may use `allowPrivateTargets: true`; production defaults remain strict. Tests never depend on random public proxies or paid APIs.

### CLI

Test redaction across stdout/stderr/JSON/CSV, single and bulk commands, concurrency bound, timeout/attempt options, missing keys, optional browser dependency, stable exit codes, and deterministic order.

### Verification Gates

Add minimal scripts:

```text
npm run typecheck
npm run lint
npm test
npm run test:integration
```

Use Node's test runner unless a specific limitation requires another framework. Lint should use an established minimal TypeScript configuration rather than a custom lint engine.

## Documentation Deliverables

README additions cover architecture, install, API, CLI, environment, security assumptions, limitations, score meanings, verdict precedence, browser-vs-transport distinction, provider availability, example redacted JSON, and untested capabilities.

Implementation completion must include the final auditor directory tree, example JSON result, and a list of anything not verified against live provider/browser infrastructure.

## Implementation Sequence

1. Public types, parser/redaction, SSRF/IP policy.
2. Transport adapters and local proxy fixtures.
3. Connectivity, exit IP, baseline, headers, TLS, DNS probes.
4. Stability/rotation and aggregation.
5. Reputation providers, cache, rate limits.
6. Scores, risk factors, verdict.
7. Public API orchestration.
8. CLI single/bulk/export.
9. Optional Playwright module.
10. Documentation and full verification.

Each stage must remain independently testable and must not import dashboard or 9Router code.
