import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Proxies page integrates both bindings and pools tables", () => {
  const content = fs.readFileSync("src/app/(dashboard)/ninerouter/proxies/page.tsx", "utf8");
  assert.ok(content.includes("AccountBindingsTable"), "Must contain bindings table");
  assert.ok(content.includes("ProxyPoolsTable"), "Must contain proxy pools table");
});
