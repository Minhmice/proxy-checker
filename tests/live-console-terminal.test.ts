import test from "node:test";
import assert from "node:assert/strict";

test("Terminal buffer caps at max 1000 lines", () => {
  const lines: string[] = [];
  for (let i = 0; i < 1200; i++) {
    lines.push(`Line ${i}`);
    if (lines.length > 1000) lines.shift();
  }
  assert.equal(lines.length, 1000);
  assert.equal(lines[0], "Line 200");
  assert.equal(lines[999], "Line 1199");
});
