import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("TokenUsageCard follows purple Net Worth design system and palette tokens", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");

  // Core reference palette tokens
  assert.ok(code.includes("#A899FB"), "Must include Lavender highlight #A899FB");
  assert.ok(code.includes("#867ACF"), "Must include Muted purple #867ACF");
  assert.ok(code.includes("#3442DC"), "Must include Electric blue #3442DC");
  assert.ok(code.includes("#090F42"), "Must include Midnight navy #090F42");
  assert.ok(code.includes("#FFFFFF"), "Must include Primary white dots #FFFFFF");
  assert.ok(code.includes("#6974B8"), "Must include Inactive dots #6974B8");
  assert.ok(code.includes("#DCFF39"), "Must include Positive trend lime #DCFF39");
  assert.ok(code.includes("#FF8B93"), "Must include Negative trend coral #FF8B93");
  assert.ok(code.includes("#A2A8D0"), "Must include Secondary text #A2A8D0");
});

test("TokenUsageCard removes unwanted decoration: TOKEN COUNT, Click to flip, orange boxes", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");

  assert.ok(!code.includes("TOKEN COUNT"), "Must completely remove TOKEN COUNT badge");
  assert.ok(
    !code.includes("Click to flip"),
    "Must completely remove persistent Click to flip text",
  );
  assert.ok(!code.includes("border-[#FF5B22]"), "Must remove thick orange outlines around numbers");
  assert.ok(!code.includes("bg-[#FF5B22]"), "Must remove orange background panel");
  assert.ok(!code.includes("DUAL-CORE LIVE"), "Must remove DUAL-CORE LIVE badge");
});

test("Dot-matrix renderer implements complete 5x7 glyph set including numbers, symbols, and suffixes", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");

  // Digits and currency
  assert.ok(code.includes('"$":') || code.includes("$: ["), "Must support $ currency symbol");
  assert.ok(code.includes('"0":') && code.includes('"9":'), "Must support digits 0-9");
  assert.ok(
    code.includes('"."') || code.includes("'.'") || code.includes('".":'),
    "Must support decimal point",
  );
  assert.ok(code.includes('",":'), "Must support comma");
  assert.ok(code.includes('"+":'), "Must support positive sign");
  assert.ok(code.includes('"-":'), "Must support negative sign");

  // Suffixes
  assert.ok(
    code.includes("M:") && code.includes("K:") && code.includes("B:"),
    "Must support suffixes M, K, B",
  );

  // Continuous inactive background grid
  assert.ok(
    code.includes("inactive-dots") && code.includes('fill="#6974B8"'),
    "Must render continuous inactive dot grid in #6974B8",
  );
  assert.ok(
    code.includes("active-dots") && code.includes('fill="#FFFFFF"'),
    "Must render active illuminated dots in #FFFFFF",
  );
});

test("TokenUsageCard preserves accessible Token <-> Cost switching", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");

  assert.ok(
    code.includes('role="button"') && code.includes("tabIndex={0}"),
    "Numeric display must have semantic button role and tabIndex 0",
  );
  assert.ok(
    code.includes('e.key === "Enter"') || code.includes("Enter"),
    "Must support Enter keyboard activation",
  );
  assert.ok(
    code.includes('e.key === " "') || code.includes("Space"),
    "Must support Space keyboard activation",
  );
  assert.ok(
    code.includes("aria-label"),
    "Must provide accessible aria-label describing metric and toggle action",
  );
  assert.ok(code.includes("formatTokens"), "Must format token count with formatTokens utility");
});
