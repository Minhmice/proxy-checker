import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("C1 & C2: TokenUsageCard does not hardcode fake fallback token counts, fake cost or fabricated 14.8% trend", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");
  assert.ok(!code.includes("506351607"), "Must not hardcode 506351607 fallback");
  assert.ok(!code.includes("299159906"), "Must not hardcode 299159906 fallback");
  assert.ok(!code.includes("14.8%"), "Must not hardcode 14.8% trend");
  assert.ok(!code.includes("totalTokens * 0.08"), "Must not calculate fake 8% delta");
  assert.ok(
    code.includes("Unable to load token usage"),
    "Must render actionable error state when fetch fails",
  );
});

test("C3 & C5: TokenUsageCard derives node health and period label dynamically from real data", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");
  assert.ok(!code.includes("Master Node (Pi) Live"), "Must not hardcode Master Node (Pi) Live");
  assert.ok(!code.includes("Dual-Core Live"), "Must not hardcode Dual-Core Live");
  assert.ok(
    !code.includes("today • 9Router Cluster"),
    "Must not hardcode static today cluster string",
  );
});

test("C4: Streamgraph does not display fake 00:00 and 12:00 timeline timestamps for static ratios", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");
  assert.ok(
    !code.includes("00:00"),
    "Must not display misleading 00:00 timestamp on ratio breakdown",
  );
  assert.ok(
    !code.includes("12:00"),
    "Must not display misleading 12:00 timestamp on ratio breakdown",
  );
});

test("C6, C7, C8, C9: Overview page table headers, failover copy, sync labels, and hero status are truthful", () => {
  const code = fs.readFileSync("src/app/(dashboard)/page.tsx", "utf8");
  assert.ok(
    code.includes('<TableHead className="text-xs font-mono w-12">#</TableHead>') ||
      code.includes('<TableHead className="text-xs font-mono">#</TableHead>'),
    "Table must have a column header for rank number (#)",
  );
  assert.ok(!code.includes("instant failover"), "Must not claim instant failover");
  assert.ok(
    !code.includes('"9Router Core Live"'),
    "Must not claim 9Router Core Live based solely on local config",
  );
  assert.ok(
    !code.includes("Last Successful Sync"),
    "Must label sync timestamp as Last Sync rather than Last Successful Sync",
  );
});

test("C11: CobeGlobe decoration without telemetry markers is removed from Overview page", () => {
  const code = fs.readFileSync("src/app/(dashboard)/page.tsx", "utf8");
  assert.ok(
    !code.includes("<CobeGlobe"),
    "Empty CobeGlobe without telemetry coordinates should not be rendered on Overview",
  );
  assert.ok(
    !code.includes("Global Egress Telemetry"),
    "Must not claim Global Egress Telemetry when no telemetry coordinate data exists",
  );
});

test("C12: Traffic chart reflects actual active route count history rather than traffic/capacity", () => {
  const code = fs.readFileSync("src/components/traffic-chart.tsx", "utf8");
  assert.ok(
    !code.includes("Pool Traffic & Capacity"),
    "Must not claim Traffic & Capacity when only charting active proxy counts",
  );
  assert.ok(
    code.includes("Active Proxy History") || code.includes("Active Route History"),
    "Must accurately label history of active proxies",
  );
});
