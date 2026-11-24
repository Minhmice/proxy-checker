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

test("C6, C7: Overview exposes labeled account status", () => {
  const status = fs.readFileSync("src/components/account-status-card.tsx", "utf8");
  assert.ok(status.includes("Identity / Account"), "Table must label the account column");
  assert.ok(status.includes("Gemini Session Quota"), "Table must label session quota");
  assert.ok(!status.includes("Assigned Proxy"), "Table must not contain proxy column");
});
