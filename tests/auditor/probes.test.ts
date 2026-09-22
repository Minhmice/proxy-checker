import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import test from "node:test";
import {
  probeContentIntegrity,
  probeDnsBehavior,
  probeDirectBaseline,
  probeExitIp,
  probeHeaderLeak,
  probeTlsIntegrity,
} from "../../src/auditor/probes/index.js";
import type { ParsedProxyInput } from "../../src/auditor/types.js";
import { startMockHttpProxy } from "./fixtures/mock-proxies.js";

const proxy: ParsedProxyInput = { protocol: "http", host: "127.0.0.1", port: 0 };

interface HttpFixture {
  port: number;
  close: () => Promise<void>;
}

function startHttpFixture(handler: http.RequestListener): Promise<HttpFixture> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpFixture>();
  const server = http.createServer(handler);
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as net.AddressInfo;
    resolve({
      port: address.port,
      close: () => {
        const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
        server.close(() => resClose());
        return pClose;
      },
    });
  });
  return promise;
}

const tlsKey = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC+eH2RnKAEvmIt
z/WWtJCivkxw9bXof8KwG1U6w2Y5XU8jroQQBgQffwHQNPL9uPVx7/WiGheUDzOz
XGlfdiCmTDmcBs0TsUS59fKzARSzlp6pMz0Ffr2twhRYkBUFF+61rZfcVbX4qBjO
fMHiepUqipd+nd7NBgBUbRLKSeE7/MVEaeOsqpBadXRkqB+BrJGAj66F6pFyc0pX
DjyOGxGkTra29d5TCoZGOb1s59vOZRFeS5uPO/VN4pTRRjFhtsrEl8F3vRpynGl2
OYcdkcW4+rtfT+e4rHIhHMgFYqK8tPyOraQjCWJ5rnsn3tgKI4tRiBI6C9Sz9C+E
V8+V/sbNAgMBAAECggEALMrBHOEscHElPYjORGaqLNt7toTSBp8k9a032d3hyFO9
LLL5s5r2lUGU95W8HxbEActghIKGUPdSPTfaP+zTuMfsNFkVGTBy7Rh9vsLeT214
WmoGS6iGiro9dqZLiysZo/fy4on1hUhirQyBu/T/50U4YzpVDvn+UdxkstW09hoP
lal8Zjq4GySbc0c45MFh6tc3zcyXZxS8LPxC6abkUQrcAcSOjAEWkegUUj3Bs3ku
EqhQ+kNsJMqRQAtI7J0BQnYRcRzAarl6AVDuUHPSoMri2AsDS+tUFo4khWx2LxG8
YfruxvZaxy/RcyppmPzvYo3U0gq2FzWqTV6b0DnEgQKBgQDifHqAMwRp9NmCWgmK
IqDEXvs7WI9kocFUKIItnPw1DQc/fnjPnvVey2Ut0FwvQ2jbwTImRxzVdLeTKGuY
eyl/yumIZEQaREysVwT3bqpGGYCr7HLsv7BgoSAnLVUEk2XtQSfqmjiy01kKhEta
3GeqrxsNhDeMV52MHweIeHFERQKBgQDXSoqx8pZuUodOMrS0qmtu2L2qkptWesih
cKY89EefzD81odsROAq/HdWWSJhdhfRG9SlYASe4yyuSD39bT5BzcnuYkQLXhvrQ
aPkrIkcwnQ9LZZxG7uiIzEqUbTLU6snaa3+7fweJwJn/TmZtxiz0glB1dsinNSRR
Fym40Q1U6QKBgDkPQVGRCNik7jOP+X1KshQnFcZizmV89xb7yagyN7wp1xyhAVDV
bF4AgjIjn0XtBrrulnLcUaBZcnJpqYnV5aOjfGh3Uk0HzgVROxgXUmCsxiUKQf3x
YT9G+LHGEvg/Jlu6oZLSXdx3sKQcplty0c9HpFooaFI8NJ37p0szhN29AoGAGKd3
pJMkOPQIfKL/4KSXcvUtGyh403lyGlK9JsPOo/UO1AR6AsnJKUOwXupnUGZzp+CR
YHuZYecaUTqnGfzNjPryPnF0wtu5Qz6SMidVwbJquvai49ieFnRWohKzPIC6puGi
mgUdBuBggkUnI7ELGuEFd74nkkZap1Kgu4JtJWkCgYB+/h0G2LtXIQhMc2mOnA0V
ohQwDCJhVtgVUYNIhZ/q8tJa/DCM5RqsSuyeaojWtRtiPdFTqE7z1ovqAw4G/TZ0
sh0/d2YteXI00ONukRei8q0518Qe2SLP451W9PJUJRK+4jztcrpCr6rOxr/Cg7cq
hWQskpPB/RU4NO0khuwjCg==
-----END PRIVATE KEY-----`;

const tlsCert = `-----BEGIN CERTIFICATE-----
MIIC7TCCAdWgAwIBAgIURcTXuAHpH6SKo3dXo7c8PVffkP8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkyMjA0NDg0NloXDTI2MDky
MzA0NDg0NlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAvnh9kZygBL5iLc/1lrSQor5McPW16H/CsBtVOsNmOV1P
I66EEAYEH38B0DTy/bj1ce/1ohoXlA8zs1xpX3Ygpkw5nAbNE7FEufXyswEUs5ae
qTM9BX69rcIUWJAVBRfuta2X3FW1+KgYznzB4nqVKoqXfp3ezQYAVG0SyknhO/zF
RGnjrKqQWnV0ZKgfgayRgI+uheqRcnNKVw48jhsRpE62tvXeUwqGRjm9bOfbzmUR
Xkubjzv1TeKU0UYxYbbKxJfBd70acpxpdjmHHZHFuPq7X0/nuKxyIRzIBWKivLT8
jq2kIwliea57J97YCiOLUYgSOgvUs/QvhFfPlf7GzQIDAQABozcwNTAUBgNVHREE
DTALgglsb2NhbGhvc3QwHQYDVR0OBBYEFI/C+QPfQd+Iu5IsQvUqO4L+xviDMA0G
CSqGSIb3DQEBCwUAA4IBAQCMC7R/lgkSJqDjnYxhITIo8YVU7jiMcPeRK4htgq+Y
GrJCDj5ev1z0BW0lOAQH7q9619Ps+MzZNKhqwYb8E46ZAkDP8h8AtApo1EnxgIRq
wUEGJK5FLw6yiMkBSRA7mNDqxjx5DZYIPled+Cby6IUfcVKB7fN87uA/b91FMgwu
KFpqVPTTatynyZCSpR9cZZ5+/6JS3P9kiU6hnVWQGCZgaIcA1E7f+XS2TflBVu/y
9tvVDMaum4St6iLgI/M49MQXEVi5hc+pgCOC0MoPgRjd2QrGFZE5Oir0JT7SnrSt
gjAQ0dvo6zUxoY6waTMZ/OB//ZLXm54xwApiZvvGb/uf
-----END CERTIFICATE-----`;

function withPort(port: number): ParsedProxyInput {
  return { ...proxy, port };
}

test("exit IP queries multiple endpoints and reports consistency", async () => {
  const one = await startHttpFixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "198.51.100.10" }));
  });
  const two = await startHttpFixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("198.51.100.10");
  });
  const p = await startMockHttpProxy();
  try {
    const result = await probeExitIp(withPort(p.port), {
      endpoints: [`http://127.0.0.1:${one.port}/`, `http://127.0.0.1:${two.port}/`],
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.ip, "198.51.100.10");
    assert.equal(result.consistent, true);
    assert.equal((result.observations as unknown[] | undefined)?.length, 2);
  } finally {
    await Promise.all([one.close(), two.close(), p.close()]);
  }
});

test("direct baseline acquires reference IP without proxy", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("203.0.113.7");
  });
  try {
    const result = await probeDirectBaseline({ endpoint: `http://127.0.0.1:${target.port}/`, timeoutMs: 1000, allowPrivateTargets: true });
    assert.equal(result.established, true);
    assert.equal(result.ip, "203.0.113.7");
  } finally {
    await target.close();
  }
});

test("header leak detects baseline IP in forwarded headers", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, { "X-Forwarded-For": "203.0.113.7", Via: "1.1 proxy", "X-Real-IP": "203.0.113.7" });
    res.end("ok");
  });
  const p = await startMockHttpProxy();
  try {
    const result = await probeHeaderLeak(withPort(p.port), ["203.0.113.7"], {
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.detected, true);
    assert.equal(result.originIpExposed, true);
    assert.equal(result.xForwardedForPresent, true);
    assert.equal(result.viaPresent, true);
    assert.equal(result.headers?.some((h) => h.revealsRealIp), true);
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});

test("TLS probe rejects invalid self-signed certificates", async () => {
  const { promise: pListen, resolve: resListen, reject: rejListen } = Promise.withResolvers<void>();
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => res.end("tls"));
  server.once("error", rejListen);
  server.listen(0, "127.0.0.1", () => resListen());
  await pListen;

  const p = await startMockHttpProxy();
  try {
    const address = server.address() as net.AddressInfo;
    const result = await probeTlsIntegrity(withPort(p.port), {
      endpoint: `https://localhost:${address.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.certificateValid, false);
    assert.equal(result.secure, false);
    assert.match(result.error || "", /self-signed certificate/i);
    assert.equal(result.possibleMitm, false);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close(() => resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("content integrity rejects plaintext HTTP endpoints", async () => {
  const target = await startHttpFixture((_req, res) => res.end("controlled-payload"));
  const p = await startMockHttpProxy();
  try {
    await assert.rejects(
      probeContentIntegrity(withPort(p.port), {
        endpoint: `http://127.0.0.1:${target.port}/`,
        expectedBody: "controlled-payload",
        timeoutMs: 1000,
        allowPrivateTargets: true,
      }),
      /HTTPS/i,
    );
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});

test("DNS probe distinguishes SOCKS5 remote resolution and unknown leak state", async () => {
  const result = await probeDnsBehavior(
    { protocol: "socks5", host: "127.0.0.1", port: 1 },
    { targetDomain: "example.test", resolveDnsLocally: false, timeoutMs: 1000 },
  );
  assert.equal(result.resolutionMode, "remote");
  assert.equal(result.dnsLeakDetected, null);
});

test("exit IP uses TLS for HTTPS endpoints", async () => {
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "198.51.100.22" }));
  });
  const { promise: pListen, resolve: resListen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resListen);
  await pListen;
  const p = await startMockHttpProxy();
  try {
    const address = server.address() as net.AddressInfo;
    const result = await probeExitIp(withPort(p.port), {
      endpoints: [`https://localhost:${address.port}/`],
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ca: tlsCert,
    });
    assert.equal(result.consistent, true);
    assert.equal(result.ip, "198.51.100.22");
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close((error) => error ? resClose(Promise.reject(error)) : resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("content integrity validates SPKI and HMAC on the payload TLS connection", async () => {
  const body = "signed-payload";
  const secret = "test-secret";
  let connections = 0;
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    res.writeHead(200, { "x-signature": signature });
    res.end(body);
  });
  server.on("secureConnection", () => connections++);
  const { promise: pListen, resolve: resListen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resListen);
  await pListen;
  const cert = new crypto.X509Certificate(tlsCert);
  const spki = crypto.createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const p = await startMockHttpProxy();
  try {
    const address = server.address() as net.AddressInfo;
    const result = await probeContentIntegrity(withPort(p.port), {
      endpoint: `https://localhost:${address.port}/`,
      expectedBody: body,
      expectedSpkiSha256: spki,
      expectedHmacSha256: { secret },
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ca: tlsCert,
    });
    assert.equal(result.intact, true);
    assert.equal(result.spkiValid, true);
    assert.equal(connections, 1);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close((error) => error ? resClose(Promise.reject(error)) : resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("header leak recognizes full header set and redacts exposed IPs", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, {
      Forwarded: "for=203.0.113.7",
      "X-Forwarded-For": "203.0.113.7",
      "X-Real-IP": "203.0.113.7",
      Via: "1.1 203.0.113.7",
      "Client-IP": "203.0.113.7",
      "True-Client-IP": "203.0.113.7",
      "CF-Connecting-IP": "203.0.113.7",
      "Proxy-Connection": "keep-alive",
    });
    res.end("ok");
  });
  const p = await startMockHttpProxy();
  try {
    const result = await probeHeaderLeak(withPort(p.port), ["203.0.113.7"], {
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.headers?.length, 8);
    assert.equal(result.originIpExposed, true);
    assert.equal(result.headers?.some((header) => header.value.includes("203.0.113.7")), false);
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});

test("inconsistent exit observations remain unselected and preserve address families", async () => {
  const one = await startHttpFixture((_req, res) => res.end("198.51.100.10"));
  const two = await startHttpFixture((_req, res) => res.end("198.51.100.11"));
  const p = await startMockHttpProxy();
  try {
    const result = await probeExitIp(withPort(p.port), {
      endpoints: [`http://127.0.0.1:${one.port}/`, `http://127.0.0.1:${two.port}/`],
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.consistent, false);
    assert.equal(result.ip, undefined);
    assert.deepEqual(result.ipv4, ["198.51.100.10", "198.51.100.11"]);
  } finally {
    await Promise.all([one.close(), two.close(), p.close()]);
  }
});

test("direct baseline enforces SSRF policy and response body limit", async () => {
  const blocked = await probeDirectBaseline({ endpoint: "http://127.0.0.1:1/", timeoutMs: 100 });
  assert.equal(blocked.established, false);
  assert.match(blocked.error || "", /private|restricted/i);

  const target = await startHttpFixture((_req, res) => res.end("x".repeat(32)));
  try {
    const limited = await probeDirectBaseline({
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      maxBytes: 8,
    });
    assert.equal(limited.established, false);
    assert.match(limited.error || "", /size|limit|bytes/i);
  } finally {
    await target.close();
  }
});

test("HTTP proxy DNS mode is local and leak status stays unknown", async () => {
  const result = await probeDnsBehavior(
    { protocol: "http", host: "127.0.0.1", port: 1 },
    { targetDomain: "example.test", timeoutMs: 1000 },
  );
  assert.equal(result.resolutionMode, "local");
  assert.equal(result.resolved, undefined);
  assert.equal(result.dnsLeakDetected, null);
});

test("TLS verification cannot be disabled by runtime options", async () => {
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ip: "198.51.100.30" }));
  });
  const { promise: pListen, resolve: resListen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resListen);
  await pListen;
  const p = await startMockHttpProxy();
  const bypass = { rejectUnauthorized: false } as Record<string, unknown>;
  try {
    const address = server.address() as net.AddressInfo;
    const endpoint = `https://localhost:${address.port}/`;

    const tlsResult = await probeTlsIntegrity(withPort(p.port), {
      endpoint,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ...bypass,
    });
    assert.equal(tlsResult.certificateValid, false);

    const exitResult = await probeExitIp(withPort(p.port), {
      endpoints: [endpoint],
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ...bypass,
    });
    assert.equal(exitResult.consistent, false);
    assert.match(exitResult.observations[0]?.error || "", /self-signed certificate/i);

    await assert.rejects(
      probeContentIntegrity(withPort(p.port), {
        endpoint,
        expectedBody: "unused",
        timeoutMs: 1000,
        allowPrivateTargets: true,
        ...bypass,
      }),
      /self-signed certificate/i,
    );

    const baseline = await probeDirectBaseline({
      endpoint,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ...bypass,
    });
    assert.equal(baseline.established, false);
    assert.match(baseline.error || "", /self-signed certificate/i);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close((error) => error ? resClose(Promise.reject(error)) : resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("header leak uses TLS and redacts credential-shaped values", async () => {
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
    res.writeHead(200, {
      "X-Forwarded-For": "203.0.113.7",
      "X-Authorization": "Authorization: Bearer secret-token",
      "X-Proxy-Meta": "token=abc123; cookie=session456; key=key789",
    });
    res.end("ok");
  });
  const { promise: pListen, resolve: resListen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", resListen);
  await pListen;
  const p = await startMockHttpProxy();
  try {
    const address = server.address() as net.AddressInfo;
    const result = await probeHeaderLeak(withPort(p.port), ["203.0.113.7"], {
      endpoint: `https://localhost:${address.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ca: tlsCert,
    });
    const values = result.headers?.map((header) => header.value).join(" ") || "";
    assert.equal(result.originIpExposed, true);
    assert.doesNotMatch(values, /203\.0\.113\.7|secret-token|abc123|session456|key789/);
    assert.match(values, /\[REDACTED/);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close((error) => error ? resClose(Promise.reject(error)) : resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("direct baseline preserves host identity and settles aborted responses", async () => {
  let observedHost = "";
  let observedRemote = "";
  const target = await startHttpFixture((req, res) => {
    observedHost = req.headers.host || "";
    observedRemote = req.socket.remoteAddress || "";
    res.write("partial");
    res.destroy();
  });
  try {
    const result = await probeDirectBaseline({
      endpoint: `http://localhost:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.established, false);
    assert.match(result.error || "", /aborted|reset|socket/i);
    assert.equal(observedHost, `localhost:${target.port}`);
    assert.match(observedRemote, /127\.0\.0\.1|::ffff:127\.0\.0\.1/);
  } finally {
    await target.close();
  }
});

test("header leak does not falsely match substring IPs, matches IP with port/quote, and redacts sensitive header names", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, {
      Forwarded: 'for="203.0.113.7:54321"',
      "X-Forwarded-For": "203.0.113.70",
      Cookie: "session=12345",
      Authorization: "Bearer secret-abc",
      "X-API-Key": "my-secret-key",
    });
    res.end("ok");
  });
  const p = await startMockHttpProxy();
  try {
    const result = await probeHeaderLeak(withPort(p.port), ["203.0.113.7"], {
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.originIpExposed, true);
    const fwdHeader = result.headers?.find((h) => h.name.toLowerCase() === "forwarded");
    assert.equal(fwdHeader?.revealsRealIp, true);
    const xffHeader = result.headers?.find((h) => h.name.toLowerCase() === "x-forwarded-for");
    assert.equal(xffHeader?.revealsRealIp, false);
    const cookieHeader = result.headers?.find((h) => h.name.toLowerCase() === "cookie");
    assert.equal(cookieHeader?.value, "[REDACTED]");
    const authHeader = result.headers?.find((h) => h.name.toLowerCase() === "authorization");
    assert.equal(authHeader?.value, "[REDACTED]");
    const apiKeyHeader = result.headers?.find((h) => h.name.toLowerCase() === "x-api-key");
    assert.equal(apiKeyHeader?.value, "[REDACTED]");
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});

test("TLS probe does NOT set possibleMitm on network timeouts or socket errors", async () => {
  const p = await startMockHttpProxy();
  try {
    // Target port is closed -> connection refused / socket error, NOT a TLS cert verification error
    const result = await probeTlsIntegrity(withPort(p.port), {
      endpoint: "https://127.0.0.1:59999/",
      timeoutMs: 1000,
      allowPrivateTargets: true,
      directResult: { valid: true },
    });
    assert.equal(result.certificateValid, false);
    assert.equal(result.possibleMitm, false);
  } finally {
    await p.close();
  }
});

test("TLS probe sets possibleMitm true only when proxy TLS fails but direct succeeded, and treats fingerprint diff as certDifference not mitm", async () => {
  const { promise: pListen, resolve: resListen, reject: rejListen } = Promise.withResolvers<void>();
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (_req, res) => res.end("tls"));
  server.once("error", rejListen);
  server.listen(0, "127.0.0.1", () => resListen());
  await pListen;

  const p = await startMockHttpProxy();
  try {
    const address = server.address() as net.AddressInfo;
    // Case A: Proxy TLS fails (untrusted self-signed), but direct was valid -> possibleMitm true
    const mitmResult = await probeTlsIntegrity(withPort(p.port), {
      endpoint: `https://localhost:${address.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      directResult: { valid: true },
    });
    assert.equal(mitmResult.certificateValid, false);
    assert.equal(mitmResult.possibleMitm, true);

    // Case B: Proxy TLS succeeds with CA, but fingerprint differs -> possibleMitm false, certDifference true
    const cdnResult = await probeTlsIntegrity(withPort(p.port), {
      endpoint: `https://localhost:${address.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
      ca: tlsCert,
      directCertFingerprint256: "AA:BB:CC:DD",
    });
    assert.equal(cdnResult.certificateValid, true);
    assert.equal(cdnResult.possibleMitm, false);
    assert.equal(cdnResult.certDifference, true);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close(() => resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("header leak exact IPv6 candidate extraction avoids false substring match", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, {
      Forwarded: 'for="[2001:db8::1:2]:443"',
      "X-Forwarded-For": "2001:db8::1:2",
    });
    res.end("ok");
  });
  const p = await startMockHttpProxy();
  try {
    // Baseline is 2001:db8::1, header has 2001:db8::1:2 -> must NOT match!
    const result = await probeHeaderLeak(withPort(p.port), ["2001:db8::1"], {
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.originIpExposed, false);
    assert.equal(result.headers?.some((h) => h.revealsRealIp), false);
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});

test("header leak canonicalizes IPv6 representations for accurate leak detection", async () => {
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, {
      Forwarded: 'for="[2001:0db8:0:0:0:0:0:1]:443"',
    });
    res.end("ok");
  });
  const p = await startMockHttpProxy();
  try {
    // Baseline is 2001:db8::1, header has expanded 2001:0db8:0:0:0:0:0:1 -> must MATCH!
    const result = await probeHeaderLeak(withPort(p.port), ["2001:db8::1"], {
      endpoint: `http://127.0.0.1:${target.port}/`,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.originIpExposed, true);
    const fwdHeader = result.headers?.find((h) => h.name.toLowerCase() === "forwarded");
    assert.equal(fwdHeader?.revealsRealIp, true);
  } finally {
    await Promise.all([target.close(), p.close()]);
  }
});
