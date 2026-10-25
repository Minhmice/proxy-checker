import test from "node:test";
import assert from "node:assert/strict";

function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(2)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
}

test("formatTokens formats values correctly", () => {
  assert.equal(formatTokens(98227261), "98.2M");
  assert.equal(formatTokens(64552877), "64.6M");
  assert.equal(formatTokens(389387), "389.4K");
  assert.equal(formatTokens(1259), "1.3K");
});
