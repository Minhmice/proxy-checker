import test from "node:test";
import assert from "node:assert/strict";
import {
  LARGE_INPUT_TOKENS,
  formatAgo,
  isLargeRequest,
  keyRequests,
} from "../src/lib/recent-requests.js";

const base = {
  nodeId: "n",
  timestamp: "2026-01-01T00:00:00.000Z",
  model: "m",
  provider: "p",
  promptTokens: 10,
  completionTokens: 1,
  status: "ok",
};

test("identical requests get distinct stable keys", () => {
  const keys = keyRequests([base, base, { ...base, promptTokens: 11 }]).map((r) => r.key);
  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(
    keyRequests([base, base]).map((r) => r.key),
    keys.slice(0, 2),
  );
});

test("large threshold is strictly greater than 500,000", () => {
  assert.equal(isLargeRequest({ promptTokens: LARGE_INPUT_TOKENS }), false);
  assert.equal(isLargeRequest({ promptTokens: LARGE_INPUT_TOKENS + 1 }), true);
});

test("formatAgo never goes negative", () => {
  const now = Date.parse(base.timestamp);
  assert.equal(formatAgo(base.timestamp, now - 5000), "just now");
  assert.equal(formatAgo(base.timestamp, now + 5000), "5s ago");
  assert.equal(formatAgo(base.timestamp, now + 120_000), "2m ago");
});
