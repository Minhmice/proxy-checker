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
      { timeoutMs: 3000 }
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
      { timeoutMs: 3000 }
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
        { timeoutMs: 3000 }
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
      { timeoutMs: 3000 }
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
      /socks4.*ipv4|domain/i
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
      { timeoutMs: 3000 }
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
      { timeoutMs: 3000 }
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
        { timeoutMs: 3000 }
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
      { timeoutMs: 3000, resolveDnsLocally: true }
    );
    assert.equal(proxy.lastTarget?.type, "ipv4");
    assert.equal(proxy.lastTarget?.host, "127.0.0.1");
    ipv4Tunnel.socket.destroy();

    const domainTunnel = await openProxyTunnel(
      parsed,
      { host: "127.0.0.1", port: target.port },
      { timeoutMs: 3000, resolveDnsLocally: false, targetDomain: "localhost" }
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
        { timeoutMs: 80 }
      ),
      /timeout|timed out/i
    );

    const { parsed: deadProxy } = parseProxyInput("http://127.0.0.1:1");
    await assert.rejects(
      openProxyTunnel(
        deadProxy,
        { host: "127.0.0.1", port: 80 },
        { timeoutMs: 500 }
      ),
      /ECONNREFUSED|connection refused/i
    );
  } finally {
    await slowProxy.close();
  }
});
