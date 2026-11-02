import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Overview page exposes token usage and account-proxy status", () => {
  const content = fs.readFileSync("src/app/(dashboard)/page.tsx", "utf8");
  assert.ok(content.includes("<TokenUsageCard"), "Must render token usage");
  assert.ok(content.includes("<AccountProxyStatusCard"), "Must render account-proxy status");
  assert.ok(content.includes('href="/proxies"'), "Must link to proxy management");
  assert.ok(content.includes('href="/bindings"'), "Must link to account bindings");
});
