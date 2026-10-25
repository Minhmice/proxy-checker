import test from "node:test";
import assert from "node:assert/strict";
import { poolKey, accountKey, detectRouterAlias } from "../src/server/dual-router/identity.js";

test("poolKey: distinguishes non-equivalent proxy credentials and protocols", () => {
  assert.notEqual(
    poolKey("http://u:one@host.test:8080"),
    poolKey("http://u:two@host.test:8080"),
    "different users must yield different keys",
  );
  assert.notEqual(
    poolKey("socks5://host.test:8080"),
    poolKey("http://host.test:8080"),
    "different protocols must yield different keys",
  );
  assert.notEqual(
    poolKey("http://host.test:8080/a"),
    poolKey("http://host.test:8080/b"),
    "different paths must yield different keys",
  );
  assert.notEqual(
    poolKey("http://host.test:8080"),
    poolKey("http://host.test:8081"),
    "different ports must yield different keys",
  );
});

test("poolKey: preserves credentials verbatim without lowercasing", () => {
  const keyUpper = poolKey("http://UserOne:SecretPass@host.test:8080");
  const keyLower = poolKey("http://userone:secretpass@host.test:8080");
  assert.notEqual(keyUpper, keyLower, "credentials case must be preserved");
  assert.match(keyUpper, /UserOne:SecretPass/);
});

test("poolKey: normalizes protocol and host case", () => {
  assert.equal(
    poolKey("HTTP://HOST.TEST:8080"),
    poolKey("http://host.test:8080"),
    "protocol and host must be normalized to lowercase",
  );
});

test("poolKey: resolves explicit default ports for standard protocols", () => {
  assert.equal(
    poolKey("http://host.test"),
    poolKey("http://host.test:80"),
    "http default port 80 must be explicit",
  );
  assert.equal(
    poolKey("https://host.test"),
    poolKey("https://host.test:443"),
    "https default port 443 must be explicit",
  );
  assert.equal(
    poolKey("socks5://host.test"),
    poolKey("socks5://host.test:1080"),
    "socks5 default port 1080 must be explicit",
  );
  assert.equal(
    poolKey("socks5h://host.test"),
    poolKey("socks5h://host.test:1080"),
    "socks5h default port 1080 must be explicit",
  );
});

test("poolKey: normalizes pathname preserving meaningful components", () => {
  assert.equal(
    poolKey("http://host.test:8080/"),
    poolKey("http://host.test:8080"),
    "trailing slash on root must be normalized",
  );
  assert.equal(
    poolKey("http://host.test:8080/path/to/proxy"),
    poolKey("http://host.test:8080/path/to/proxy/"),
    "trailing slash on non-root must be normalized",
  );
  assert.equal(
    poolKey("http://host.test:8080//path///to//proxy"),
    poolKey("http://host.test:8080/path/to/proxy"),
    "consecutive slashes must be collapsed",
  );
  assert.match(
    poolKey("http://host.test:8080/CaseSensitivePath"),
    /\/CaseSensitivePath/,
    "path casing must be preserved",
  );
});

test("poolKey: normalizes query parameters in canonical sorted order", () => {
  assert.equal(
    poolKey("http://host.test:8080?b=2&a=1"),
    poolKey("http://host.test:8080?a=1&b=2"),
    "query parameters with different order must yield identical key",
  );
  assert.equal(
    poolKey("http://host.test:8080?timeout=5&retry=2"),
    "http://host.test:8080?retry=2&timeout=5",
  );
});

test("accountKey: preserves stable subject across email changes", () => {
  assert.equal(
    accountKey("antigravity", "subject-1", "a@test.invalid"),
    accountKey("antigravity", "subject-1", "renamed@test.invalid"),
    "accounts with same subject must have identical key regardless of email",
  );
});

test("accountKey: normalizes provider case and whitespace", () => {
  assert.equal(
    accountKey("  AntiGravity  ", "subject-1", null),
    accountKey("antigravity", "subject-1", null),
    "provider must be trimmed and lowercased",
  );
});

test("accountKey: falls back to normalized email when subject missing", () => {
  // Provider-appropriate normalization for antigravity (case-insensitive localpart & domain)
  assert.equal(
    accountKey("antigravity", null, "User@EXAMPLE.COM"),
    accountKey("antigravity", null, "user@example.com"),
  );
  assert.equal(
    accountKey("antigravity", "", "  user@example.com  "),
    "antigravity:user@example.com",
  );

  // Generic provider normalizes domain to lowercase while preserving localpart
  assert.equal(
    accountKey("custom-provider", null, "CaseSensitiveUser@DOMAIN.COM"),
    "custom-provider:CaseSensitiveUser@domain.com",
  );
});

test("accountKey: throws on identity ambiguity when subject and email missing", () => {
  assert.throws(
    () => accountKey("antigravity", null, null),
    /identity/i,
    "must throw on identity ambiguity when both subject and email null",
  );
  assert.throws(
    () => accountKey("antigravity", "", ""),
    /identity/i,
    "must throw when both subject and email are empty strings",
  );
  assert.throws(
    () => accountKey("antigravity", "   ", "   "),
    /identity/i,
    "must throw when both subject and email are whitespace",
  );
  assert.throws(
    () => accountKey("", "subject-1", "a@test.com"),
    /identity/i,
    "must throw when provider is empty",
  );
});

test("detectRouterAlias: detects routers pointing to same host/port/scheme", () => {
  const registrations = [
    { routerId: "router-a", url: "http://192.168.1.50:8000" },
    { routerId: "router-b", url: "http://192.168.1.50:8000/" },
    { routerId: "router-c", url: "http://192.168.1.51:8000" },
  ];

  const result = detectRouterAlias(registrations);
  assert.deepEqual(result.aliases, [["router-a", "router-b"]]);
  assert.equal(result.uniqueUrls.length, 2);
});

test("detectRouterAlias: detects default port equivalence as aliases", () => {
  const registrations = [
    { routerId: "r1", url: "http://router.local" },
    { routerId: "r2", url: "http://router.local:80" },
    { routerId: "r3", url: "https://router.local" },
    { routerId: "r4", url: "https://router.local:443" },
  ];

  const result = detectRouterAlias(registrations);
  assert.deepEqual(result.aliases, [
    ["r1", "r2"],
    ["r3", "r4"],
  ]);
  assert.equal(result.uniqueUrls.length, 2);
});

test("detectRouterAlias: detects loopback aliases", () => {
  const registrations = [
    { routerId: "r-local", url: "http://localhost:20128" },
    { routerId: "r-ip", url: "http://127.0.0.1:20128" },
  ];

  const result = detectRouterAlias(registrations);
  assert.deepEqual(result.aliases, [["r-local", "r-ip"]]);
  assert.equal(result.uniqueUrls.length, 1);
});

test("detectRouterAlias: keeps distinct schemes/ports/hosts separate", () => {
  const registrations = [
    { routerId: "r1", url: "http://10.0.0.1:8080" },
    { routerId: "r2", url: "https://10.0.0.1:8080" },
    { routerId: "r3", url: "http://10.0.0.1:8081" },
    { routerId: "r4", url: "http://10.0.0.2:8080" },
  ];

  const result = detectRouterAlias(registrations);
  assert.deepEqual(result.aliases, []);
  assert.equal(result.uniqueUrls.length, 4);
});
