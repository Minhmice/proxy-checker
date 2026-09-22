# Standalone Proxy Safety Auditor

## Boundary and installation

The auditor lives under `src/auditor/`. It does not import Next.js, 9Router, dashboard settings, or production proxy inventory. Auditing never promotes, removes, or renames a 9Router pool. Dashboard integration is not part of this delivery.

Use Node.js 22 or newer and `npm install`. The core uses Node TCP/TLS/DNS/HTTP primitives. `tsx` runs the TypeScript source; no separate transpilation is required for the CLI wrapper.

```sh
npm run proxy-audit -- check "socks5://user:password@example.com:1080" --json
node scripts/proxy-audit.mjs check-file proxies.txt --concurrency 5 --output results.json --csv results.csv
node scripts/proxy-audit.mjs browser-check "http://example.com:8080" --json
```

`proxy-audit` is also registered as a package binary. Quote proxy URLs in shells; shell history and OS process arguments can retain supplied credentials even though auditor output is redacted. Do not use real secrets in shared terminals or CI command logs.

## API

```ts
import { checkProxy } from "./src/auditor/index.js";

const result = await checkProxy({
  protocol: "socks5",
  host: "proxy.example.com",
  port: 1080,
  username: "operator",
  password: process.env.PROXY_PASSWORD,
}, {
  timeoutMs: 15000,
  attempts: 5,
  baseline: true,
  reputation: true,
});
```

Supported proxy schemes: `http`, `https` (TLS to the proxy), `socks4`, `socks5`. An HTTPS destination through an HTTP proxy uses CONNECT followed by verified TLS to the destination; it does not make the proxy itself an HTTPS proxy.

The public entry point exposes `checkProxy`, `auditProxyInBrowser`, and TypeScript contracts. Options include total timeout, attempt count, optional baseline/reputation/browser, abort signal, echo endpoints, header/TLS endpoints, controlled HTTPS endpoint and SPKI/content expectations, provider keys, cache path, and a custom CA for controlled fixtures. TLS verification cannot be disabled.

## Measurement pipeline

1. Parse input, keep connection credentials internal, create redacted identity.
2. Resolve every proxy A/AAAA answer, reject unsafe addresses, and pin the selected connection address.
3. Establish HTTP/HTTPS/SOCKS transport and measure connection/handshake phases.
4. Query independent exit-IP endpoints; retain conflicting observations rather than choosing one as truth.
5. Optionally collect the direct baseline, inspect destination-visible headers, verify TLS and controlled content, and report DNS-mode evidence.
6. Perform bounded repeated requests for reliability and rotation.
7. Fetch configured IP intelligence with provider-specific rate limits/cache.
8. Produce nullable scores, evidence-backed risks, conservative recommendations, and verdict.

Default echo endpoints are `https://api.ipify.org` and `https://ifconfig.me/ip`; header echo uses `https://httpbin.org/anything`. These are independent external services, not trust anchors. Service failure is reported and is not proof that the proxy operator is malicious.

## Verdicts and scores

- `FAIL`: measured critical security failure, blocked SSRF target, unusable connection, invalid TLS, controlled pin/content mismatch, or confirmed origin exposure.
- `WARN`: observed noncritical risk such as poor reliability, high latency, reputation warnings, rotation affecting stable sessions, or confirmed DNS leakage. Missing optional data does not erase an observed warning.
- `UNKNOWN`: insufficient measurements to establish a verdict; never a synonym for safe.
- `PASS`: required measurements completed without actionable risks. It is not a guarantee of operator trust or future behavior.

Scores are 0–100 or `null` when not measured. Transport security reflects verified TLS and controlled integrity when configured. Privacy requires actual leak evidence, not mere absence of a response. Reputation reverses the normalized multi-provider risk score; a VPN/proxy/hosting label alone carries no maliciousness deduction. Reliability uses measured success percentage. Overall safety weights are transport 35%, privacy 30%, reputation 20%, reliability 15%; it remains null when a required component is unknown. Critical failures always override numeric scores.

Each deduction has a stable risk code, severity, explanation, and evidence. Latency warnings begin at 2000 ms; repeated-request p95 over 3000 ms or success percentage below 80 indicates instability. Latency percentiles use nearest rank; jitter is mean absolute difference between consecutive successful request latencies. These are operational heuristics, not security guarantees.

## Providers, cache, and environment

Set optional keys in the process environment:

```env
IPINFO_TOKEN=
IPQS_API_KEY=
ABUSEIPDB_API_KEY=
CONTROL_ENDPOINT=
CONTROL_SPKI_SHA256=
```

Missing credentials and quota exhaustion produce provider `unavailable`; network/invalid-response failures produce `error`. Actual reports and sources remain visible. Provider classifications depend on subscription capabilities. Unknown network type stays unknown; consumer ISP ownership alone does not prove residential routing.

ASN metadata TTL defaults to 24 hours; reputation TTL defaults to 6 hours. Connectivity is never served from cache as current health. File writes use atomic replacement and serialize within the process; separate OS processes must not share a writable cache path unless protected by an external lock.

## SSRF and TLS assumptions

All proxy answers are validated, including IPv4-mapped IPv6. Loopback, private, link-local, multicast, unspecified, metadata, and unsafe reserved targets are rejected before connecting. `allowPrivateTargets: true` is a test/development option that explicitly weakens this protection; never derive it from untrusted HTTP payloads.

The optional private-target override is needed for controlled local integration fixtures. It does not disable TLS certificate validation: fixtures supply a trusted test CA.

Connections pin validated addresses to reduce local DNS rebinding risk. Remote DNS performed by an untrusted proxy cannot be fully verified from the client. DNS leakage is `null` unless a measurement establishes it; a reported DNS mode is not evidence that all resolver traffic stayed private.

Unexpected certificates can be legitimate CDN behavior. Fingerprint changes alone do not prove MITM. `possibleMitm` requires proxied certificate validation failure and successful direct verification, not ordinary timeout/reset.

Redirects and encoded responses must not silently bypass policy or allocate unbounded buffers. Rejected/unsupported responses appear as failed or unavailable measurements. Header evidence and errors must not disclose passwords, keys, bearer tokens, or cookies.

## Controlled endpoint

Use an operator-controlled HTTPS endpoint for stronger assurance. Configure an SPKI SHA-256 pin plus deterministic expected content or an authenticated nonce-bearing payload. Pin validation and payload retrieval must happen on the same verified TLS connection. HMAC keys stay outside logs and returned evidence. Plain HTTP cannot establish primary content integrity.

## Optional browser audit

Install Playwright and a browser explicitly when needed:

```sh
npm install --save-dev playwright
npx playwright install chromium
```

Network audits never launch or statically depend on a browser. Browser mode uses a new isolated context, configured proxy, standard certificate verification, IP observations, and WebRTC candidate collection. Browser WebRTC leakage is separate from proxy transport security. Private/mDNS candidates are not proof of public origin leakage. Missing browser binaries, unsupported proxy authentication/protocol combinations, unavailable IPv6, or unobservable DNS are reported honestly.

No fingerprint spoofing, CAPTCHA bypass, anti-fraud evasion, or platform-detection optimization is implemented.

## CLI and bulk output

Commands: `check`, `check-file`, `browser-check`. Flags: `--json`, `--pretty`, `--timeout`, `--attempts`, `--no-reputation`, `--browser`, `--concurrency`, `--output`, `--csv`.

Bulk concurrency defaults to 5 and is bounded at 50. Input order is retained. Default JSON output is `results.json`; CSV is optional. CSV quoting follows RFC4180 and neutralizes spreadsheet formula cells. Unknown measurements remain empty/null rather than zero or false.

Exit codes: 0 for PASS/WARN, 1 for FAIL/operational errors, 2 for invalid CLI usage, 3 for UNKNOWN. Output is redacted; debug logs must go to stderr, leaving JSON stdout machine-readable.

## Verification and limits

```sh
npm run typecheck
npm run lint
npm test
npm run test:integration
npm run build
```

Tests use controlled local HTTP/SOCKS/TLS fixtures and fake provider HTTP responses. They cover blocked addresses, encoded credentials, authentication failures, malformed protocol replies, truncated/chunked/oversized bodies, deadlines, TLS failures, header leakage, IP rotation, provider availability, caching, scoring, and CLI outputs.

Paid provider entitlements and real malicious proxies are not prerequisites for automated verification. Live provider quotas/classifications, Internet IPv6 reachability, and resolver attribution vary by environment and must be verified by the operator. A proxy can selectively behave well toward audit endpoints; no finite audit proves future safety. Avoid high-value credentials on an untrusted proxy regardless of score.
