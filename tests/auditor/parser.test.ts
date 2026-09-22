import assert from "node:assert/strict";
import test from "node:test";
import { parseProxyInput } from "../../src/auditor/parser.js";

test("parses supported proxy URL protocols and credentials", () => {
  const cases = [
    ["http://user:pass@1.2.3.4:8080", "http", "1.2.3.4", 8080],
    ["https://1.2.3.4:443", "https", "1.2.3.4", 443],
    ["socks5://[::1]:1080", "socks5", "::1", 1080],
    ["socks4://1.1.1.1:1080", "socks4", "1.1.1.1", 1080],
  ] as const;

  for (const [input, protocol, host, port] of cases) {
    const { parsed } = parseProxyInput(input);
    assert.equal(parsed.protocol, protocol);
    assert.equal(parsed.host, host);
    assert.equal(parsed.port, port);
  }

  const { parsed, redacted } = parseProxyInput("http://user:pass@1.2.3.4:8080");
  assert.equal(parsed.username, "user");
  assert.equal(parsed.password, "pass");
  assert.equal(redacted.username, "user:********");
  assert.ok(!JSON.stringify(redacted).includes("pass"));
  assert.ok(!String(redacted).includes("pass"));
});

test("parses typed proxy object input and preserves valid whitespace in credentials", () => {
  const { parsed, redacted } = parseProxyInput({
    protocol: "https",
    host: "proxy.example.com",
    port: 8443,
    username: " alice with spaces ",
    password: " secret with spaces ",
  });
  assert.deepEqual(parsed, {
    protocol: "https",
    host: "proxy.example.com",
    port: 8443,
    username: " alice with spaces ",
    password: " secret with spaces ",
  });
  assert.equal(redacted.username, " alice with spaces :********");
  assert.equal(redacted.password, undefined);
  assert.ok(!JSON.stringify(redacted).includes("secret"));
});

test("rejects malformed ports, unsupported protocols, and empty hosts", () => {
  for (const input of [
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:not-a-port",
    "ftp://127.0.0.1:8080",
    "http://:8080",
  ]) {
    assert.throws(() => parseProxyInput(input));
  }
});

test("does not leak plaintext password when URL parsing fails", () => {
  const sensitivePassword = "super-secret-password-1234";
  const malformedInput = `http://myuser:${sensitivePassword}@1.2.3.4:not-a-port`;

  try {
    parseProxyInput(malformedInput);
    assert.fail("Should throw for invalid port in URL");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    assert.ok(
      !message.includes(sensitivePassword),
      `Error message leaked plaintext password: ${message}`
    );
    assert.match(message, /malformed|invalid|proxy/i);
  }
});

test("rejects prototype pollution attempts as protocols", () => {
  assert.throws(() =>
    parseProxyInput({
      protocol: "constructor",
      host: "example.com",
      port: 8080,
    })
  );
  assert.throws(() =>
    parseProxyInput({
      protocol: "__proto__",
      host: "example.com",
      port: 8080,
    })
  );
});
