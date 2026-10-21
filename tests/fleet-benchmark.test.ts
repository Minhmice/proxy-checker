import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readBytes,
  readUntil,
  sanitizeSecrets,
  parseBenchmarkConfig,
  parseIPv6ToBuffer,
  createTunneledTlsSocket,
  executeRequest,
  runBenchmark,
} from "../scripts/fleet-capacity-benchmark.mjs";

const TEST_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEAzxncyGopnV6l2H14kvu4me0rf1NlU03V0FdFQRQV1kkfBGIl
GxViIiRuhpMiT7i/oxESgOLY6GRJAI0L5vRlQUQVlq+smeyBUzHFsBZ3ZVtFjK1e
jfeQ+GuKh023Uf3/9uHPYu6cT0sEUxHI487cW18RbnN4At0ma5SebSNo1460ZZwj
2qI1MPWqucNnxGLT3wKVOznAX6YvFImRrMqPzfC+tUVcpLPxEoQQL+5grWZVmwqN
pg1LYqIMgo9EbODeckn/8lv3OGEQKT4DGkdT+y5EdmPANUMTI0lqWTJAqwmOOwzU
hJ4CnQHndHutOrGsNemn+BHxXshxcvSd0wjPxQIDAQABAoIBAADT86QBeKUeab9R
0ReVVgmXfyMFLFSG7SHmF2rJL8Upiaw00D0perj0OFTlZa+351w5hz9oqMFVFU2h
QrjrpTP7l7KAhUogPewdONMZY+TN1ptXXhdnM/cqRuV/lAoJ3+oWwQN+PLW8cQn7
+jee7haXbLRqVcJ9K9gmQfPhvluOPqXX+d5HcYgf5QjvXs+TXGIA+yTi+bebgeI6
9awWHFxMrc6Q4tgWVra9+JlrJcswScCBsEDBVZm9Lqthl3OoHaNO1Ihm0XCcz4P0
rgwZ1MP0ngoJ510/NrkWktGkV01V8o1Txy80GEp/X6eKbJ0aJFWlNsV3aAh06x6D
q2WsZ8kCgYEA94L2zXvFMaXGoFo1pZt445/Psj+A1fbyXCzkatl98uMyq77PGzTp
Qw0cvZO8CJdfobi9jK63FgRGP2epx2sSPQE1YYd27P7006yGnFX6aeSu+WcMAcxp
BULYZiLOdMJXlXwkSY6z8g7/Xbw9/jN3Crk1V1lME0TXmx+tkiwVk68CgYEA1jQc
0zCikp9JRDBBywGpfZHljSC8O+pv7JDWGhP/9mi/7J3Yir7CFImerw3Jlkq1qVYl
LXqr2Hjz1F8Jzd0ZlFNPZn8SJC9oM+vqNSYhE1WieVHXWZ8BKuUJiOMuHFjRWTXK
uttCf117jLwSilx5tzDuiKCNr1WXW8PZsmanjMsCgYEAl6+nWV8VBsw14mfmoMub
VsTGINNSPc7N0Teh9Om9inE6yI5zlpTir7kFeBlmD03VyeLSJ7mbct7Dvm/lWNWB
o+ltsYu3kp7dpCwDgyQeB2+i3C4O6btAUX0Z6d5C8MN5sZ8XDg1qsloGnoeS5orb
1bKTwihzuwthpyvOz9o8jvkCgYBfn+oSWc7p19Q0bbqhbv+EQEKTCz8dHF6U5F/A
SpdlIIQ1lI3b+qbX1kwR5/zLbFTG4N89+1qGDBEGCNtunLrTnZF/t1CY+NTzAOmQ
ipIPeJZMxL13k+VIifEEvC6Ulw32Xm4/lqyMAWargDZisD/iCSUjt1EpKfOlEry3
yN4ZmwKBgQDGdJKpHbGhgZarRSgelBSE1BFTzdVet7vC0yaffcti2iHJy3JynuSD
VVGvxW7p8BFRzdSYXqMnWDXcgaiA2fRN1SfQD0nYzBqji+h/xhRthxBxtoOll/Am
iH8aYjox/jYLfZo3eM2l8etyTcpdMsj/DwVoTNROwXAKxz0JlFooDg==
-----END RSA PRIVATE KEY-----`;

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIC1jCCAb6gAwIBAgIUX4OKa9d5EoBs4d6K0MwioX283towDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTIwMDEwMTAwMDAwMFoYDzIwNTAw
MTAxMDAwMDAwWjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDPGdzIaimdXqXYfXiS+7iZ7St/U2VTTdXQV0VBFBXW
SR8EYiUbFWIiJG6GkyJPuL+jERKA4tjoZEkAjQvm9GVBRBWWr6yZ7IFTMcWwFndl
W0WMrV6N95D4a4qHTbdR/f/24c9i7pxPSwRTEcjjztxbXxFuc3gC3SZrlJ5tI2jX
jrRlnCPaojUw9aq5w2fEYtPfApU7OcBfpi8UiZGsyo/N8L61RVyks/EShBAv7mCt
ZlWbCo2mDUtiogyCj0Rs4N5ySf/yW/c4YRApPgMaR1P7LkR2Y8A1QxMjSWpZMkCr
CY47DNSEngKdAed0e606saw16af4EfFeyHFy9J3TCM/FAgMBAAGjHjAcMBoGA1Ud
EQQTMBGHBH8AAAGCCWxvY2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAKj58nva/
PJ2PUJzzToIkaRh0ZITNV9AE0+zEpTmsvGH6bL1SaMJc+FEBiRr4r+9XfLZDcN4Q
rfW1fgxbKt1fixF+hCmMxR/wsVVSPzivTprlW37CT8AbB9ngTWgUOIYiKVEZkR//
Y918HFLX9yxw1OCIBX6HUwLFA+vzG8LsLYjWoVGDzBnAqsfjtVfnMcNDyI/M89KM
7LPJwCHRv+Pt/jZmliwDA25OPVw8zfnDSNxLqKK/tTrvB7r695ysp8K5oaq+zy5R
ebLKd1n2Dqe3xApf0EgMHVEFBp+0jFRwYx2njIiw0F7/qNXIE0YElxIPSnJuzW14
v6i7pUIKtm5rYQ==
-----END CERTIFICATE-----`;

test("benchmark arg parser validates constraints, schemes, and IPv6 normalization", () => {
  const env: Record<string, string | undefined> = { BENCHMARK_PROXY_URL: "socks5://127.0.0.1:1080" };

  assert.throws(
    () => parseBenchmarkConfig(["--target", "https://127.0.0.1:8443/"], env),
    /--confirm-required flag is required/
  );

  assert.throws(
    () => parseBenchmarkConfig(["--confirm-required", "--target", "https://127.0.0.1:8443/"], {}),
    /BENCHMARK_PROXY_URL environment variable must be set/
  );

  assert.throws(
    () =>
      parseBenchmarkConfig(
        ["--confirm-required", "--proxy-url", "socks5://127.0.0.1:1080", "--target", "https://127.0.0.1:8443/"],
        env
      ),
    /--proxy-url cannot be passed via CLI/
  );

  assert.throws(
    () =>
      parseBenchmarkConfig(["--confirm-required", "--target", "http://127.0.0.1:8080/"], env),
    /Target URL scheme must be 'https:'/
  );

  // Reject unsupported https proxy scheme
  assert.throws(
    () =>
      parseBenchmarkConfig(["--confirm-required", "--target", "https://127.0.0.1:8443/"], {
        BENCHMARK_PROXY_URL: "https://127.0.0.1:8443",
      }),
    /Unsupported proxy scheme 'https:'/
  );

  // Reject unknown CLI args
  assert.throws(
    () =>
      parseBenchmarkConfig(
        ["--confirm-required", "--target", "https://127.0.0.1:8443/", "--unknown-flag"],
        env
      ),
    /Unknown argument '--unknown-flag'/
  );

  // IPv6 bracket normalization
  const parsedIpv6 = parseBenchmarkConfig(
    ["--confirm-required", "--target", "https://[::1]:8443/healthz", "--concurrency", "2"],
    env
  );
  assert.equal(parsedIpv6.target.hostname, "::1");
  assert.equal(parsedIpv6.target.authority, "[::1]:8443");
});

test("parseIPv6ToBuffer correctly parses full and shorthand IPv6 addresses", () => {
  const bufLoopback = parseIPv6ToBuffer("::1");
  assert.equal(bufLoopback.length, 16);
  assert.equal(bufLoopback[15], 1);
  assert.equal(bufLoopback[0], 0);

  const bufFull = parseIPv6ToBuffer("2001:db8::1");
  assert.equal(bufFull[0], 0x20);
  assert.equal(bufFull[1], 0x01);
  assert.equal(bufFull[2], 0x0d);
  assert.equal(bufFull[3], 0xb8);
  assert.equal(bufFull[15], 1);
});

test("sanitizeSecrets scrubs passwords, credentials, and full URLs", () => {
  const secrets = ["supersecret", "socks5://user:supersecret@127.0.0.1:1080"];
  const raw = "Error: proxy socks5://user:supersecret@127.0.0.1:1080 rejected supersecret";
  const sanitized = sanitizeSecrets(raw, secrets);

  assert.ok(!sanitized.includes("supersecret"));
  assert.ok(sanitized.includes("***REDACTED***") || sanitized.includes("***@"));
});

test("readBytes and readUntil reject immediately on pre-aborted signal without leaking timers", async () => {
  const socket = new net.Socket();
  const abortedCtrl = new AbortController();
  abortedCtrl.abort();

  await assert.rejects(
    () => readBytes(socket, 10, 15000, abortedCtrl.signal),
    /Operation aborted/
  );

  await assert.rejects(
    () => readUntil(socket, "\r\n\r\n", 15000, abortedCtrl.signal),
    /Operation aborted/
  );
});

test("readUntil rejects oversized headers but accepts valid delimiter with coalesced trailing data", async () => {
  const { promise: s1Listen, resolve: onS1 } = Promise.withResolvers<void>();
  const s1 = net.createServer((socket) => {
    socket.write(Buffer.alloc(200, "A"));
  });
  s1.listen(0, "127.0.0.1", onS1);
  await s1Listen;
  const p1 = (s1.address() as net.AddressInfo).port;

  const c1 = net.connect(p1, "127.0.0.1");
  await assert.rejects(
    () => readUntil(c1, "\r\n\r\n", 5000, undefined, 100),
    /Header size limit of 100 bytes exceeded/
  );
  c1.destroy();
  s1.close();

  const { promise: s2Listen, resolve: onS2 } = Promise.withResolvers<void>();
  const s2 = net.createServer((socket) => {
    const head = Buffer.from("HTTP/1.1 200 OK\r\n\r\n");
    const body = Buffer.alloc(200, "X");
    socket.write(Buffer.concat([head, body]));
  });
  s2.listen(0, "127.0.0.1", onS2);
  await s2Listen;
  const p2 = (s2.address() as net.AddressInfo).port;

  const c2 = net.connect(p2, "127.0.0.1");
  const parsedHead = await readUntil(c2, "\r\n\r\n", 5000, undefined, 50);
  assert.ok(parsedHead.toString("latin1").includes("HTTP/1.1 200 OK"));
  const trail = await readBytes(c2, 200);
  assert.equal(trail.length, 200);
  assert.equal(trail[0], 0x58);

  c2.destroy();
  s2.close();
});

test("HTTP CONNECT tunnel routes through proxy and executes HTTPS GET with custom Agent", async (t) => {
  const tmpCertPath = path.join(os.tmpdir(), `test-connect-cert-${Date.now()}.pem`);
  fs.writeFileSync(tmpCertPath, TEST_CERT, "utf8");

  let proxiedGetReceived = false;

  const { promise: targetListening, resolve: onTargetListen } = Promise.withResolvers<void>();
  const targetServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    proxiedGetReceived = true;
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("authenticated-tunnel-payload");
  });
  targetServer.listen(0, "127.0.0.2", onTargetListen);
  await targetListening;
  const targetPort = (targetServer.address() as net.AddressInfo).port;

  let authReceived = "";
  const { promise: proxyListening, resolve: onProxyListen } = Promise.withResolvers<void>();
  const proxyServer = net.createServer((clientSocket) => {
    void (async () => {
      const headers = await readUntil(clientSocket, "\r\n\r\n");
      const match = headers.toString("latin1").match(/Proxy-Authorization: Basic ([A-Za-z0-9+/=]+)/i);
      if (match) {
        authReceived = Buffer.from(match[1], "base64").toString("utf8");
      }
      const targetSocket = net.connect(targetPort, "127.0.0.2", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
    })();
  });
  proxyServer.listen(0, "127.0.0.1", onProxyListen);
  await proxyListening;
  const proxyPort = (proxyServer.address() as net.AddressInfo).port;

  t.after(() => {
    targetServer.close();
    proxyServer.close();
    try {
      fs.unlinkSync(tmpCertPath);
    } catch {}
  });

  const config = parseBenchmarkConfig(
    [
      "--confirm-required",
      "--target",
      `https://127.0.0.1:${targetPort}/test`,
      "--ca-cert",
      tmpCertPath,
      "--requests",
      "2",
      "--concurrency",
      "1",
    ],
    {
      BENCHMARK_PROXY_URL: `http://benchuser:benchpass@127.0.0.1:${proxyPort}`,
    }
  );

  const res = await executeRequest(config);
  assert.equal(res.success, true);
  assert.equal(res.statusCode, 200);
  assert.ok(res.bytesRead > 0);
  assert.equal(authReceived, "benchuser:benchpass");
  assert.equal(proxiedGetReceived, true);
});

test("HTTP 503 response counts as failure while accounting for actual received body bytes", async (t) => {
  const tmpCertPath = path.join(os.tmpdir(), `test-503-cert-${Date.now()}.pem`);
  fs.writeFileSync(tmpCertPath, TEST_CERT, "utf8");

  const { promise: targetListening, resolve: onTargetListen } = Promise.withResolvers<void>();
  const targetServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("upstream-unavailable-error-body");
  });
  targetServer.listen(0, "127.0.0.1", onTargetListen);
  await targetListening;
  const targetPort = (targetServer.address() as net.AddressInfo).port;

  const { promise: proxyListening, resolve: onProxyListen } = Promise.withResolvers<void>();
  const proxyServer = net.createServer((clientSocket) => {
    void (async () => {
      await readUntil(clientSocket, "\r\n\r\n");
      const targetSocket = net.connect(targetPort, "127.0.0.1", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
    })();
  });
  proxyServer.listen(0, "127.0.0.1", onProxyListen);
  await proxyListening;
  const proxyPort = (proxyServer.address() as net.AddressInfo).port;

  t.after(() => {
    targetServer.close();
    proxyServer.close();
    try {
      fs.unlinkSync(tmpCertPath);
    } catch {}
  });

  const config = parseBenchmarkConfig(
    [
      "--confirm-required",
      "--target",
      `https://127.0.0.1:${targetPort}/fail`,
      "--ca-cert",
      tmpCertPath,
    ],
    {
      BENCHMARK_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    }
  );

  const res = await executeRequest(config);
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.errorCode, "HTTP_503");
  assert.ok(res.bytesRead > 0, "Body bytes from 503 response must be accounted");
});

test("TLS rejects untrusted certificates when CA is not supplied", async (t) => {
  let proxyConnects = 0;
  let proxiedGetReceived = false;
  const { promise: targetListening, resolve: onTargetListen } = Promise.withResolvers<void>();
  const targetServer = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (_req, res) => {
    proxiedGetReceived = true;
    res.writeHead(200);
    res.end("ok");
  });
  targetServer.listen(0, "127.0.0.2", onTargetListen);
  await targetListening;
  const targetPort = (targetServer.address() as net.AddressInfo).port;

  const { promise: proxyListening, resolve: onProxyListen } = Promise.withResolvers<void>();
  const proxyServer = net.createServer((clientSocket) => {
    void (async () => {
      await readUntil(clientSocket, "\r\n\r\n");
      proxyConnects++;
      const targetSocket = net.connect(targetPort, "127.0.0.2", () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        clientSocket.pipe(targetSocket);
        targetSocket.pipe(clientSocket);
      });
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
    })();
  });
  proxyServer.listen(0, "127.0.0.1", onProxyListen);
  await proxyListening;
  const proxyPort = (proxyServer.address() as net.AddressInfo).port;

  t.after(() => {
    targetServer.close();
    proxyServer.close();
  });

  const config = parseBenchmarkConfig(
    [
      "--confirm-required",
      "--target",
      `https://127.0.0.1:${targetPort}/`,
    ],
    {
      BENCHMARK_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
    }
  );

  const res = await executeRequest(config);
  assert.equal(res.success, false);
  assert.equal(res.errorCode, "DEPTH_ZERO_SELF_SIGNED_CERT");
  assert.equal(proxyConnects, 1, "Target connection must traverse configured proxy");
  assert.equal(proxiedGetReceived, false, "Untrusted target must not receive HTTP request");
});
