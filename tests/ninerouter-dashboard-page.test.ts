import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Dashboard page file exists and imports components", () => {
  const content = fs.readFileSync("src/app/(dashboard)/ninerouter/dashboard/page.tsx", "utf8");
  assert.ok(content.includes("MiniUsageCard"), "Must render MiniUsageCard");
  assert.ok(content.includes("LiveConsoleTerminal"), "Must render LiveConsoleTerminal");
  assert.ok(content.includes("server-lan"), "Must configure server-lan");
  assert.ok(content.includes("server-vpn"), "Must configure server-vpn");
});
