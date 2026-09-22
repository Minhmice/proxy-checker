import assert from "node:assert/strict";
import dns from "node:dns/promises";
import test from "node:test";
import { isPrivateIp } from "../../src/auditor/security/ip-policy.js";
import { validateTargetHost } from "../../src/auditor/security/ssrf.js";

test("ip-policy rejects loopback, RFC1918, link-local, multicast, metadata, and zero addresses", () => {
  const privateIps = [
    "127.0.0.1",
    "127.255.255.254",
    "0.0.0.0",
    "10.0.0.1",
    "10.254.1.2",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "169.254.1.1",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:192.168.1.10",
  ];

  for (const ip of privateIps) {
    assert.equal(isPrivateIp(ip), true, `Expected ${ip} to be classified as private/restricted`);
  }

  const publicIps = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"];
  for (const ip of publicIps) {
    assert.equal(isPrivateIp(ip), false, `Expected ${ip} to be classified as public`);
  }
});

test("ip-policy rejects hex/word formatted IPv4-mapped IPv6 addresses (e.g. ::ffff:7f00:1 and ::ffff:a9fe:a9fe)", () => {
  const mappedHexIps = [
    "::ffff:7f00:1", // 127.0.0.1
    "::ffff:7f00:0001",
    "::ffff:a9fe:a9fe", // 169.254.169.254
    "::ffff:0a00:0001", // 10.0.0.1
    "::ffff:c0a8:0101", // 192.168.1.1
    "::ffff:ac10:0001", // 172.16.0.1
  ];

  for (const ip of mappedHexIps) {
    assert.equal(isPrivateIp(ip), true, `Expected hex-mapped IPv6 ${ip} to be blocked`);
  }

  // Public IPv4 mapped as hex should be allowed (e.g. 1.1.1.1 -> 0101:0101)
  assert.equal(isPrivateIp("::ffff:0101:0101"), false);
});

test("validateTargetHost rejects localhost and loopback targets", async () => {
  const targets = ["127.0.0.1", "localhost", "0.0.0.0", "10.0.0.1", "172.16.0.1", "192.168.1.1"];
  for (const target of targets) {
    const result = await validateTargetHost(target);
    assert.equal(result.valid, false, `Target ${target} should be rejected`);
    assert.ok(result.reason, `Target ${target} should have a failure reason`);
  }
});

test("validateTargetHost rejects cloud metadata IP and IPv6 link-local addresses", async () => {
  const meta = await validateTargetHost("169.254.169.254");
  assert.equal(meta.valid, false);
  assert.match(meta.reason ?? "", /private|metadata|loopback|restricted/i);

  const ipv6LinkLocal = await validateTargetHost("fe80::1");
  assert.equal(ipv6LinkLocal.valid, false);
});

test("validateTargetHost resolves domains and rejects if any record points to private IP", async () => {
  const result = await validateTargetHost("localhost");
  assert.equal(result.valid, false);
  assert.ok(result.resolvedIps.length > 0);
});

test("validateTargetHost handles mock multi-IP DNS resolution (A/AAAA) and blocks if any is private", async (t) => {
  const originalResolve4 = dns.resolve4;
  const originalResolve6 = dns.resolve6;

  t.after(() => {
    dns.resolve4 = originalResolve4;
    dns.resolve6 = originalResolve6;
  });

  // Mock domain returning 1 public IPv4 and 1 private IPv4
  dns.resolve4 = (async () => ["93.184.216.34", "10.0.0.5"]) as unknown as typeof dns.resolve4;
  dns.resolve6 = (async () => ["2606:2800:220:1:248:1893:25c8:1946"]) as unknown as typeof dns.resolve6;

  const mixedResult = await validateTargetHost("multi-ip.mock-domain.internal");
  assert.equal(mixedResult.valid, false);
  assert.ok(mixedResult.resolvedIps.includes("10.0.0.5"));
  assert.match(mixedResult.reason ?? "", /restricted IP/i);

  // Mock domain returning purely public A and AAAA records
  dns.resolve4 = (async () => ["93.184.216.34", "93.184.216.35"]) as unknown as typeof dns.resolve4;
  dns.resolve6 = (async () => ["2606:2800:220:1:248:1893:25c8:1946"]) as unknown as typeof dns.resolve6;

  const publicResult = await validateTargetHost("all-public.mock-domain.internal");
  assert.equal(publicResult.valid, true);
  assert.equal(publicResult.resolvedIps.length, 3);
});

test("validateTargetHost allows private targets only when allowPrivateTargets option is true", async () => {
  const blocked = await validateTargetHost("127.0.0.1");
  assert.equal(blocked.valid, false);

  const allowed = await validateTargetHost("127.0.0.1", { allowPrivateTargets: true });
  assert.equal(allowed.valid, true);
  assert.deepEqual(allowed.resolvedIps, ["127.0.0.1"]);

  const allowedDomain = await validateTargetHost("localhost", { allowPrivateTargets: true });
  assert.equal(allowedDomain.valid, true);
  assert.ok(allowedDomain.resolvedIps.length > 0);
});
