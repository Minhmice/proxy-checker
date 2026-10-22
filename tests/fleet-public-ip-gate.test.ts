import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePublicIp,
  validateTailscaleIpv4,
  validatePublicIpv4,
} from "../src/proxyfleet/public-ip-gate.js";

test("validateTailscaleIpv4 accepts exact 100.64.0.0/10 range and trims whitespace", () => {
  assert.equal(validateTailscaleIpv4("100.64.0.0"), "100.64.0.0");
  assert.equal(validateTailscaleIpv4(" 100.127.255.255 "), "100.127.255.255");
  assert.equal(validateTailscaleIpv4("100.90.108.8"), "100.90.108.8");

  assert.throws(() => validateTailscaleIpv4("100.63.255.255"), /100\.64\.0\.0\/10/);
  assert.throws(() => validateTailscaleIpv4("100.128.0.0"), /100\.64\.0\.0\/10/);
  assert.throws(() => validateTailscaleIpv4("192.168.1.1"), /100\.64\.0\.0\/10/);
  assert.throws(() => validateTailscaleIpv4("fd7a:115c:a1e0::1"), /IPv4/);
  assert.throws(() => validateTailscaleIpv4(""), /required/);
});

test("validatePublicIpv4 accepts global unicast IPv4 and rejects non-global ranges", () => {
  assert.equal(validatePublicIpv4("1.1.1.1"), "1.1.1.1");
  assert.equal(validatePublicIpv4("8.8.8.8"), "8.8.8.8");

  // Private, loopback, link-local, multicast, test/doc ranges, and Tailscale range
  assert.throws(() => validatePublicIpv4("127.0.0.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("10.0.0.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("192.168.1.50"), /global unicast/);
  assert.throws(() => validatePublicIpv4("172.16.0.5"), /global unicast/);
  assert.throws(() => validatePublicIpv4("169.254.1.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("100.64.0.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("203.0.113.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("198.51.100.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("224.0.0.1"), /global unicast/);
  assert.throws(() => validatePublicIpv4("255.255.255.255"), /global unicast/);
  assert.throws(() => validatePublicIpv4("2001:db8::1"), /IPv4/);
});

test("evaluatePublicIp returns lookup_failed when observation is missing or invalid", () => {
  assert.deepEqual(evaluatePublicIp({ observed: null, expected: null, activePeerIps: [] }), {
    status: "lookup_failed",
    reason: "Public IP lookup returned no result",
  });
  assert.deepEqual(evaluatePublicIp({ observed: "invalid-ip", expected: null, activePeerIps: [] }), {
    status: "lookup_failed",
    reason: "Observed public IP is not valid global unicast IPv4",
  });
  assert.deepEqual(evaluatePublicIp({ observed: "192.168.1.1", expected: null, activePeerIps: [] }), {
    status: "lookup_failed",
    reason: "Observed public IP is not valid global unicast IPv4",
  });
});

test("evaluatePublicIp prioritizes expected_mismatch over duplicate", () => {
  const result = evaluatePublicIp({
    observed: "1.1.1.1",
    expected: "8.8.8.8",
    activePeerIps: ["1.1.1.1"],
  });
  assert.equal(result.status, "expected_mismatch");
  assert.match(result.reason || "", /Expected public IP 8\.8\.8\.8, observed 1\.1\.1\.1/);
});

test("evaluatePublicIp marks duplicate when observed matches another active worker", () => {
  const result = evaluatePublicIp({
    observed: "1.1.1.1",
    expected: "1.1.1.1",
    activePeerIps: ["1.1.1.1", "8.8.4.4"],
  });
  assert.equal(result.status, "duplicate");
  assert.match(result.reason || "", /Duplicate public IP 1\.1\.1\.1/);

  // Without expected IP specified, duplicate still triggers
  const noExpected = evaluatePublicIp({
    observed: "1.1.1.1",
    expected: null,
    activePeerIps: ["1.1.1.1"],
  });
  assert.equal(noExpected.status, "duplicate");
});

test("evaluatePublicIp marks verified when unique and matching expectation or when unique with no expectation", () => {
  const withExpected = evaluatePublicIp({
    observed: "1.1.1.1",
    expected: "1.1.1.1",
    activePeerIps: ["8.8.8.8"],
  });
  assert.deepEqual(withExpected, {
    status: "verified",
    reason: null,
  });

  const withoutExpected = evaluatePublicIp({
    observed: "1.1.1.1",
    expected: null,
    activePeerIps: ["8.8.8.8"],
  });
  assert.deepEqual(withoutExpected, {
    status: "verified",
    reason: null,
  });
});
