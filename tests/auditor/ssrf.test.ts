import assert from "node:assert/strict";
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
