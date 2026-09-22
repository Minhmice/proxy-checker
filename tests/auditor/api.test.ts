import assert from "node:assert/strict";
import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { checkProxy } from "../../src/auditor/api.js";
import { auditProxyInBrowser } from "../../src/auditor/browser/api.js";
import { startMockHttpProxy } from "./fixtures/mock-proxies.js";

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

interface HttpsFixture {
  hits: string[];
  url: (path: string) => string;
  close: () => Promise<void>;
}

async function startHttpsFixture(leak = false): Promise<HttpsFixture> {
  const hits: string[] = [];
  const activeSockets = new Set<net.Socket>();
  const server = https.createServer({ key: tlsKey, cert: tlsCert }, (req, res) => {
    const path = req.url || "/";
    hits.push(path);
    if (path === "/headers" && leak) {
      res.setHeader("X-Forwarded-For", "198.51.100.42");
    }
    res.setHeader("Content-Type", path === "/headers" ? "application/json" : "text/plain");
    res.end(path === "/control" ? "controlled" : path === "/headers" ? "{}" : "198.51.100.42");
  });

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  return {
    hits,
    url: (path: string) => `https://localhost:${port}${path}`,
    close: async () => {
      for (const socket of activeSockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

function optionsFor(fixture: HttpsFixture) {
  return {
    allowPrivateTargets: true,
    timeoutMs: 4_000,
    attempts: 5,
    reputation: false,
    ca: tlsCert,
    endpoints: [fixture.url("/ip-1"), fixture.url("/ip-2")] as const,
    headerEndpoint: fixture.url("/headers"),
    tlsEndpoint: fixture.url("/ip-1"),
    controlEndpoint: fixture.url("/control"),
    controlExpectedBody: "controlled",
  };
}

test("checkProxy runs controlled HTTPS pipeline with exactly five stability requests", async () => {
  const fixture = await startHttpsFixture();
  const proxy = await startMockHttpProxy();
  try {
    const result = await checkProxy(`http://alice:secret@127.0.0.1:${proxy.port}`, optionsFor(fixture));
    assert.equal(result.security.inputValidation.valid, true);
    assert.equal(result.security.ssrfProtection.passed, true);
    assert.equal(result.connectivity?.reachable, true);
    assert.equal(result.exitIp?.ip, "198.51.100.42");
    assert.equal(result.tls?.certificateValid, true);
    assert.equal(result.contentIntegrity?.intact, true);
    assert.equal(result.dns?.dnsLeakDetected, null);
    assert.equal(result.stability?.samplesAttempted, 5);
    assert.equal(result.stability?.samplesSucceeded, 5);
    assert.equal(fixture.hits.filter((path) => path.startsWith("/ip-")).length, 8);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.notEqual(result.verdict, "PASS", "unsupported DNS measurement must not be forced safe");
  } finally {
    await Promise.all([proxy.close(), fixture.close()]);
  }
});

test("checkProxy rejects SSRF before opening a proxy socket", async () => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  try {
    const result = await checkProxy(`http://user:top-secret@127.0.0.1:${port}`, {
      timeoutMs: 250,
      reputation: false,
    });
    assert.equal(result.verdict, "FAIL");
    assert.equal(result.security.ssrfProtection.passed, false);
    assert.equal(result.riskFactors.some((factor) => factor.code === "SSRF_VIOLATION"), true);
    assert.equal(connections, 0);
    assert.equal(JSON.stringify(result).includes("top-secret"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("checkProxy reports strict TLS and origin-leak failures without exposing credentials", async () => {
  const fixture = await startHttpsFixture(true);
  const proxy = await startMockHttpProxy();
  try {
    const leaking = await checkProxy(`http://alice:secret@127.0.0.1:${proxy.port}`, optionsFor(fixture));
    assert.equal(leaking.verdict, "FAIL");
    assert.equal(leaking.riskFactors.some((factor) => factor.code === "ORIGIN_IP_EXPOSED"), true);

    const untrusted = await checkProxy(`http://alice:secret@127.0.0.1:${proxy.port}`, {
      ...optionsFor(fixture),
      ca: undefined,
    });
    assert.equal(untrusted.verdict, "FAIL");
    assert.equal(untrusted.tls?.certificateValid, false);
    assert.equal(JSON.stringify(untrusted).includes("secret"), false);
  } finally {
    await Promise.all([proxy.close(), fixture.close()]);
  }
});

test("total deadline aborts stalled sockets and returns partial structured evidence", async () => {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  try {
    const started = Date.now();
    const result = await checkProxy(`http://127.0.0.1:${port}`, {
      allowPrivateTargets: true,
      timeoutMs: 150,
      reputation: false,
      endpoints: [`http://127.0.0.1:${port}/echo`],
    });
    assert.equal(result.connectivity?.reachable, false);
    assert.ok(Date.now() - started < 1_500);
    for (const socket of sockets) {
      socket.destroy();
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("browser audit reports unsupported protocols without loading Playwright", async () => {
  const result = await auditProxyInBrowser("socks4://127.0.0.1:1080", {
    allowPrivateTargets: true,
  });
  assert.equal(result.supported, false);
  assert.match(result.error || "", /SOCKS4.*unsupported/i);
});
