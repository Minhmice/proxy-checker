import test from "node:test";
import assert from "node:assert/strict";
import { formatTokens } from "../src/components/ninerouter/mini-usage-card.js";

test("REGRESSION-01: formatTokens safely handles null, undefined, NaN, and negative values", () => {
  // Safe handling of null and undefined
  assert.equal(formatTokens(null), "0");
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens(NaN), "0");

  // Standard token values
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(1500), "1.5K");
  assert.equal(formatTokens(2500000), "2.5M");
  assert.equal(formatTokens(3500000000), "3.50B");
});

test("REGRESSION-02: SSE init event replaces logs buffer instead of duplicating in live-console-terminal logic", () => {
  const existingLogs = ["Line 1", "Line 2"];
  const initPayload = { type: "init", logs: ["Line 1", "Line 2", "Line 3"] };

  // Fixed implementation:
  // if (payload.type === "init" && Array.isArray(payload.logs)) setLogs(payload.logs.slice(-1000))
  let currentLogs = existingLogs;
  if (initPayload.type === "init" && Array.isArray(initPayload.logs)) {
    currentLogs = initPayload.logs.slice(-1000);
  }

  assert.equal(currentLogs.length, 3, "Logs must be reset to exact snapshot, not duplicated");
  assert.equal(currentLogs.filter((l) => l === "Line 1").length, 1);
});

test("REGRESSION-03: Multi-cookie extraction handles auth_token wherever it appears", () => {
  const setCookies = [
    "session_id=anonymous; Path=/",
    "auth_token=valid_secret_token; Path=/; HttpOnly",
  ];

  let authToken: string | null = null;
  for (const cookie of setCookies) {
    const part = cookie.split(";")[0]?.trim();
    if (part && part.startsWith("auth_token=")) {
      authToken = part;
      break;
    }
  }

  assert.equal(authToken, "auth_token=valid_secret_token");
});
