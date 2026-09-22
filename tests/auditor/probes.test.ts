import assert from "node:assert/strict";
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

test("TLS probe reports invalid self-signed certificate and negotiated metadata", async () => {
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
      rejectUnauthorized: true,
    });
    assert.equal(result.certificateValid, false);
    assert.equal(typeof result.cipher, "string");
    assert.equal(typeof result.protocol, "string");
    assert.equal(result.possibleMitm, false);
  } finally {
    const { promise: pClose, resolve: resClose } = Promise.withResolvers<void>();
    server.close(() => resClose());
    await Promise.all([p.close(), pClose]);
  }
});

test("content integrity verifies deterministic body and SPKI pin", async () => {
  const body = "controlled-payload";
  const target = await startHttpFixture((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  const p = await startMockHttpProxy();
  try {
    const result = await probeContentIntegrity(withPort(p.port), {
      endpoint: `http://127.0.0.1:${target.port}/`,
      expectedBody: body,
      timeoutMs: 1000,
      allowPrivateTargets: true,
    });
    assert.equal(result.intact, true);
    assert.deepEqual(result.injectedScripts, []);
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
