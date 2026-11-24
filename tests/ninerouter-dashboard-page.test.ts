import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Overview page exposes token usage and account status", () => {
  const content = fs.readFileSync("src/app/(dashboard)/page.tsx", "utf8");
  assert.ok(content.includes("<TokenUsageCard"), "Must render token usage");
  assert.ok(content.includes("<AccountStatusCard"), "Must render account status");
  assert.ok(!content.includes('href="/proxies"'), "Must not link to proxies");
  assert.ok(!content.includes('href="/bindings"'), "Must not link to bindings");
});
