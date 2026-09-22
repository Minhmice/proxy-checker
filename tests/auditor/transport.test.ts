import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyInput } from "../../src/auditor/parser.js";
import {
  openProxyTunnel,
  requestThroughProxy,
  type TimingBreakdown,
  type TransportOptions,
} from "../../src/auditor/transport/index.js";
import {
  startMockHttpProxy,
  startMockSocks4Proxy,
  startMockSocks5Proxy,
  startMockTargetEcho,
  startScriptedRawHttpServer,
} from "./fixtures/mock-proxies.js";

function assertTimings(timings: TimingBreakdown): void {
  assert.equal(typeof timings.dnsMs, "number");
  assert.equal(typeof timings.tcpConnectMs, "number");
  assert.equal(typeof timings.proxyHandshakeMs, "number");
  assert.equal(typeof timings.totalMs, "number");
  assert.ok(timings.dnsMs >= 0, `dnsMs must be >= 0, got ${timings.dnsMs}`);
  assert.ok(timings.tcpConnectMs >= 0, `tcpConnectMs must be >= 0, got ${timings.tcpConnectMs}`);
  assert.ok(timings.proxyHandshakeMs >= 0, `proxyHandshakeMs must be >= 0, got ${timings.proxyHandshakeMs}`);
  assert.ok(timings.totalMs >= 0, `totalMs must be >= 0, got ${timings.totalMs}`);
}

test("HTTP proxy tunnel establishes connection without auth and forwards requests", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    assertTimings(tunnel.timings);

    const response = await requestThroughProxy(tunnel.socket, {
      method: "GET",
      path: "/audit-http-noauth",
      host: `127.0.0.1:${target.port}`,
      headers: { "X-Test-Trace": "no-auth" },
      timeoutMs: 3000,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["x-echo-path"], "/audit-http-noauth");
    assert.ok(response.body.includes("/audit-http-noauth"));
    assert.equal(target.recordedRequests.length, 1);
    assert.equal(target.recordedRequests[0].headers["x-test-trace"], "no-auth");
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("HTTP proxy tunnel supports Basic auth credentials and rejects invalid credentials", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockHttpProxy({ username: "proxyuser", password: "proxypassword" });

  try {
    const { parsed: validParsed } = parseProxyInput(
      `http://proxyuser:proxypassword@127.0.0.1:${proxy.port}`
    );
    const tunnel = await openProxyTunnel(
      validParsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    assertTimings(tunnel.timings);

    const response = await requestThroughProxy(tunnel.socket, {
      method: "GET",
      path: "/audit-http-auth",
      host: `127.0.0.1:${target.port}`,
      timeoutMs: 3000,
    });
    assert.equal(response.statusCode, 200);

    const { parsed: invalidParsed } = parseProxyInput(
      `http://wronguser:wrongpass@127.0.0.1:${proxy.port}`
    );

    await assert.rejects(
      openProxyTunnel(
        invalidParsed,
        { host: "127.0.0.1", port: target.port },
        { timeoutMs: 3000, allowPrivateTargets: true }
      ),
      /proxy.*auth|407/i
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("SOCKS4 proxy establishes tunnel to IPv4 target and rejects domain target without resolved IP", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockSocks4Proxy();

  try {
    const { parsed } = parseProxyInput(`socks4://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    assertTimings(tunnel.timings);

    const response = await requestThroughProxy(tunnel.socket, {
      method: "GET",
      path: "/audit-socks4",
      host: `127.0.0.1:${target.port}`,
      timeoutMs: 3000,
    });
    assert.equal(response.statusCode, 200);

    await assert.rejects(
      openProxyTunnel(
        parsed,
        { host: "example.invalid", port: 80 },
        { timeoutMs: 3000 }
      ),
      /socks4.*ipv4|domain|ssrf/i
    );
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("SOCKS5 proxy handles no-auth and username/password authentication", async () => {
  const target = await startMockTargetEcho();
  const noAuthProxy = await startMockSocks5Proxy();
  const authProxy = await startMockSocks5Proxy({ username: "socksuser", password: "sockspassword" });

  try {
    const { parsed: noAuthParsed } = parseProxyInput(`socks5://127.0.0.1:${noAuthProxy.port}`);
    const noAuthTunnel = await openProxyTunnel(
      noAuthParsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    assertTimings(noAuthTunnel.timings);
    const noAuthRes = await requestThroughProxy(noAuthTunnel.socket, {
      method: "GET",
      path: "/audit-socks5-noauth",
      host: `127.0.0.1:${target.port}`,
      timeoutMs: 3000,
    });
    assert.equal(noAuthRes.statusCode, 200);

    const { parsed: authParsed } = parseProxyInput(
      `socks5://socksuser:sockspassword@127.0.0.1:${authProxy.port}`
    );
    const authTunnel = await openProxyTunnel(
      authParsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    assertTimings(authTunnel.timings);
    const authRes = await requestThroughProxy(authTunnel.socket, {
      method: "GET",
      path: "/audit-socks5-auth",
      host: `127.0.0.1:${target.port}`,
      timeoutMs: 3000,
    });
    assert.equal(authRes.statusCode, 200);

    const { parsed: badAuthParsed } = parseProxyInput(
      `socks5://wrong:secret@127.0.0.1:${authProxy.port}`
    );
    await assert.rejects(
      openProxyTunnel(
        badAuthParsed,
        { host: "127.0.0.1", port: target.port },
        { timeoutMs: 3000, allowPrivateTargets: true }
      ),
      /auth|denied|failed/i
    );
  } finally {
    await noAuthProxy.close();
    await authProxy.close();
    await target.close();
  }
});

test("SOCKS5 respects remote DNS domain packing versus local IPv4 target", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockSocks5Proxy();

  try {
    const { parsed } = parseProxyInput(`socks5://127.0.0.1:${proxy.port}`);

    const ipv4Tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, resolveDnsLocally: true, allowPrivateTargets: true }
    );
    assert.equal(proxy.lastTarget?.type, "ipv4");
    assert.equal(proxy.lastTarget?.host, "127.0.0.1");
    ipv4Tunnel.socket.destroy();

    const domainTunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, resolveDnsLocally: false, targetDomain: "localhost", allowPrivateTargets: true }
    );
    assert.equal(proxy.lastTarget?.type, "domain");
    assert.equal(proxy.lastTarget?.host, "localhost");
    domainTunnel.socket.destroy();
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("transport enforces timeout on delayed proxy handshake and handles connection refusal", async () => {
  const slowProxy = await startMockHttpProxy({ delayConnectMs: 500 });

  try {
    const { parsed: slowParsed } = parseProxyInput(`http://127.0.0.1:${slowProxy.port}`);
    await assert.rejects(
      openProxyTunnel(
        slowParsed,
        { host: "127.0.0.1", port: 80 },
        { timeoutMs: 80, allowPrivateTargets: true }
      ),
      /timeout|timed out/i
    );

    const { parsed: deadProxy } = parseProxyInput("http://127.0.0.1:1");
    await assert.rejects(
      openProxyTunnel(
        deadProxy,
        { host: "127.0.0.1", port: 80 },
        { timeoutMs: 500, allowPrivateTargets: true }
      ),
      /ECONNREFUSED|connection refused/i
    );
  } finally {
    await slowProxy.close();
  }
});

test("regression 1: BufferedSocketReader releases listeners cleanly without trapping tunnel data", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    assert.equal(tunnel.socket.listenerCount("data"), 0, "socket data listeners should be released after handshake");
    const receivedChunks: Buffer[] = [];
    tunnel.socket.on("data", (chunk: Buffer) => receivedChunks.push(chunk));
    tunnel.socket.resume();

    const wireReq = `GET /fast-pipe HTTP/1.1\r\nHost: 127.0.0.1:${target.port}\r\nConnection: close\r\n\r\n`;
    tunnel.socket.write(wireReq);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const timer = setTimeout(() => reject(new Error("Timeout waiting for fast-pipe response on released socket")), 2000);
    tunnel.socket.once("end", () => {
      clearTimeout(timer);
      resolve();
    });

    await promise;
    const body = Buffer.concat(receivedChunks).toString("utf8");
    assert.ok(body.includes("200 OK"));
    assert.ok(body.includes("/fast-pipe"));
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("regression 2: requestThroughProxy handles chunked transfer-encoding and content-length strictly", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const head = buffer.subarray(0, headerEnd).toString("utf8");

      if (head.includes("/chunked-premature-eof")) {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nwi");
        socket.destroy();
        return;
      }

      if (head.includes("/chunked")) {
        socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: text/plain\r\n\r\n");
        socket.write("4\r\nwiki\r\n");
        socket.write("5\r\npedia\r\n");
        socket.write("f\r\n in \r\n\r\nchunks.\r\n");
        socket.write("0\r\n\r\n");
        return;
      }

      if (head.includes("/content-length")) {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Type: text/plain\r\n\r\nhello ");
        setTimeout(() => {
          socket.write("world");
        }, 30);
        return;
      }

      if (head.includes("/premature-eof")) {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\npartial");
        setTimeout(() => socket.destroy(), 30);
        return;
      }

    });
  });

  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);

    const tunnel1 = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    const chunkedRes = await requestThroughProxy(tunnel1.socket, {
      method: "GET",
      path: "/chunked",
      host: `127.0.0.1:${server.port}`,
      timeoutMs: 3000,
    });
    assert.equal(chunkedRes.statusCode, 200);
    assert.equal(chunkedRes.body, "wikipedia in \r\n\r\nchunks.");

    const tunnel2 = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    const clRes = await requestThroughProxy(tunnel2.socket, {
      method: "GET",
      path: "/content-length",
      host: `127.0.0.1:${server.port}`,
      timeoutMs: 3000,
    });
    assert.equal(clRes.statusCode, 200);
    assert.equal(clRes.body, "hello world");

    const tunnel3 = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    await assert.rejects(
      requestThroughProxy(tunnel3.socket, {
        method: "GET",
        path: "/premature-eof",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 1000,
      }),
      /socket closed|incomplete body|unexpected eof/i
    );
    assert.ok(tunnel3.socket.destroyed, "socket should be destroyed on premature EOF");

    const tunnel4 = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );
    await assert.rejects(
      requestThroughProxy(tunnel4.socket, {
        method: "GET",
        path: "/chunked-premature-eof",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 1000,
      }),
      /socket closed|incomplete chunk|chunk/i
    );
    assert.ok(tunnel4.socket.destroyed, "socket should be destroyed on chunked premature EOF");
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 3: SOCKS5 handshake enforces global deadline across multi-step negotiation", async () => {
  const proxy = await startMockSocks5Proxy({
    username: "u",
    password: "p",
    delayMethodMs: 70,
    delayAuthMs: 70,
  });

  try {
    const { parsed } = parseProxyInput(`socks5://u:p@127.0.0.1:${proxy.port}`);
    const start = Date.now();
    await assert.rejects(
      openProxyTunnel(
        parsed,
        { host: "127.0.0.1", port: 80 },
        { timeoutMs: 100, allowPrivateTargets: true }
      ),
      /timeout|timed out/i
    );
    const duration = Date.now() - start;
    assert.ok(duration < 220, `Handshake timeout should enforce global deadline (~100ms), took ${duration}ms`);
  } finally {
    await proxy.close();
  }
});

test("regression 4: SSRF address pinning connects directly to pinned IP and blocks private targets by default", async () => {
  const target = await startMockTargetEcho();
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);

    await assert.rejects(
      openProxyTunnel(
        parsed,
        { host: "127.0.0.1", port: target.port },
        { timeoutMs: 2000 }
      ),
      /restricted|ssrf|private/i
    );

    const tunnel = await openProxyTunnel(
      parsed,
      { host: "localhost", port: target.port },
      { timeoutMs: 3000, allowPrivateTargets: true, resolvedIp: "127.0.0.1" }
    );
    assert.ok(tunnel.socket);
    tunnel.socket.destroy();
  } finally {
    await proxy.close();
    await target.close();
  }
});

test("regression 5: HTTP CONNECT errors sanitize raw proxy error text and credentials", async () => {
  const proxy = await startMockHttpProxy({
    rejectedStatusLine: "HTTP/1.1 502 Bad Gateway with secret-token-12345",
  });

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    let capturedMessage = "";
    try {
      await openProxyTunnel(
        parsed,
        { host: "127.0.0.1", port: 80 },
        { timeoutMs: 2000, allowPrivateTargets: true }
      );
    } catch (err: unknown) {
      capturedMessage = err instanceof Error ? err.message : String(err);
    }

    assert.match(capturedMessage, /502/);
    assert.ok(!capturedMessage.includes("secret-token-12345"), `Error should not contain raw server text: ${capturedMessage}`);
  } finally {
    await proxy.close();
  }
});

test("regression 6: connectSocketToProxy validates proxy host against SSRF policy", async () => {
  const { parsed: privateProxy } = parseProxyInput("http://127.0.0.1:8080");
  await assert.rejects(
    openProxyTunnel(
      privateProxy,
      { host: "example.com", port: 80 },
      { timeoutMs: 2000 }
    ),
    /SSRF validation rejected proxy host/i
  );
});

test("regression 7: readAll throws and destroys socket when timeout occurs before stream ends", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\n\r\npartial stream without closing");
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    await assert.rejects(
      requestThroughProxy(tunnel.socket, {
        method: "GET",
        path: "/",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 100,
      }),
      /timeout/i
    );
    assert.ok(tunnel.socket.destroyed, "socket should be destroyed on readAll timeout");
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 8: reader enforces byte caps on headers and body", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.includes("/huge-headers")) {
        const hugeHeader = "X-Huge: " + "a".repeat(70 * 1024) + "\r\n";
        socket.write(`HTTP/1.1 200 OK\r\n${hugeHeader}\r\n`);
        socket.end();
      }
    });
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    await assert.rejects(
      requestThroughProxy(tunnel.socket, {
        method: "GET",
        path: "/huge-headers",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 2000,
      }),
      /maximum limit/i
    );
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 9: readAll rejects when socket errors even if socket is closed", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\n\r\npartial-content");
    // keep socket open without sending EOF
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    setTimeout(() => {
      tunnel.socket.destroy(new Error("ECONNRESET triggered intentionally"));
    }, 30);

    await assert.rejects(
      requestThroughProxy(tunnel.socket, {
        method: "GET",
        path: "/",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 1000,
      }),
      /ECONNRESET/i
    );
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 10: header size cap does not falsely trigger when body is included in same packet", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.on("data", () => {
      const headers = "HTTP/1.1 200 OK\r\nContent-Length: 70000\r\n\r\n";
      const body = "x".repeat(70000);
      socket.write(headers + body);
    });
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    const res = await requestThroughProxy(tunnel.socket, {
      method: "GET",
      path: "/",
      host: `127.0.0.1:${server.port}`,
      timeoutMs: 2000,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.rawBody.length, 70000);
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 11: requestThroughProxy rejects content-length exceeding MAX_BODY_BYTES", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10000000\r\n\r\n");
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    await assert.rejects(
      requestThroughProxy(tunnel.socket, {
        method: "GET",
        path: "/",
        host: `127.0.0.1:${server.port}`,
        timeoutMs: 2000,
      }),
      /Body exceeds max allowed size/i
    );
  } finally {
    await proxy.close();
    await server.close();
  }
});

test("regression 12: requestThroughProxy returns empty body on HEAD requests even if content-length is present", async () => {
  const server = await startScriptedRawHttpServer((socket) => {
    socket.write("HTTP/1.1 200 OK\r\nContent-Length: 5000\r\n\r\n");
  });
  const proxy = await startMockHttpProxy();

  try {
    const { parsed } = parseProxyInput(`http://127.0.0.1:${proxy.port}`);
    const tunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: server.port },
      { timeoutMs: 3000, allowPrivateTargets: true }
    );

    const res = await requestThroughProxy(tunnel.socket, {
      method: "HEAD",
      path: "/",
      host: `127.0.0.1:${server.port}`,
      timeoutMs: 1000,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "");
    assert.equal(res.rawBody.length, 0);
  } finally {
    await proxy.close();
    await server.close();
  }
});
