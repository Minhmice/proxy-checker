import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("TokenUsageCard uses obsidian tokens and the dither engine, not a bespoke palette", () => {
  const code = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");

  assert.ok(code.includes("<DitherCard"), "Must use the dithercn DitherCard surface");
  assert.ok(!/#(?:A899FB|867ACF|3442DC|090F42|1C1B3E|121332)/i.test(code), "No off-palette purple");
  assert.ok(!code.includes("feDropShadow"), "No glow filters; texture comes from dithering");
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

  assert.ok(code.includes('"$":') || code.includes("$: ["), "Must support $ currency symbol");
  assert.ok(code.includes('"0":') && code.includes('"9":'), "Must support digits 0-9");
  assert.ok(
    code.includes('"."') || code.includes("'.'") || code.includes('".":'),
    "Must support decimal point",
  );
  assert.ok(code.includes('",":'), "Must support comma");
  assert.ok(code.includes('"+":'), "Must support positive sign");
  assert.ok(code.includes('"-":'), "Must support negative sign");

  assert.ok(
    code.includes("M:") && code.includes("K:") && code.includes("B:"),
    "Must support suffixes M, K, B",
  );

  assert.ok(
    code.includes("inactive-dots") && code.includes("var(--dither-ink)"),
    "Must render the continuous inactive dot grid in the dither ink colour",
  );
  assert.ok(
    code.includes("active-dots") && code.includes('fill="var(--ink)"'),
    "Must render active cells in the ink colour",
  );
});
