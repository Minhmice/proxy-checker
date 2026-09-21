import test from "node:test";
import assert from "node:assert/strict";
import { parseProxy, proxyUrl } from "../src/server/proxy-core";

test("formats IPv6 proxy URLs correctly", () => {
  const proxy = parseProxy("socks5://[::1]:1080");
  assert.equal(proxy?.endpoint, "[::1]:1080");
  assert.equal(proxyUrl(proxy!), "socks5://[::1]:1080");
});

test("never emits credentials unless explicitly needed for router configuration", () => {
  const proxy = parseProxy("http://user:secret@example.com:3128");
  assert.equal(proxyUrl(proxy!), "http://example.com:3128");
  assert.equal(proxyUrl(proxy!, true), "http://user:secret@example.com:3128");
});

test("rejects malformed ports and normalizes HTTPS list labels", () => {
  assert.equal(parseProxy("example.com:70000"), null);
  assert.equal(parseProxy("https://example.com:3128")?.protocol, "http");
});
