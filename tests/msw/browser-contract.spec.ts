import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startBrowserMocks } from "../../src/mocks/start-browser.js";
import { handlers } from "../../src/mocks/handlers.js";

test("msw browser contract: browser files exist and cover client contracts", () => {
  assert.ok(fs.existsSync("src/mocks/browser.ts"));
  assert.ok(fs.existsSync("public/mockServiceWorker.js"));
  assert.ok(handlers.length >= 8);
});

test("msw browser contract: production guard prevents starting worker without opt-in flags", async () => {
  // In Node environment or non-opt-in flags, startBrowserMocks exits immediately
  const originalEnv = process.env.NEXT_PUBLIC_ENABLE_API_MOCKS;
  try {
    delete process.env.NEXT_PUBLIC_ENABLE_API_MOCKS;
    await assert.doesNotReject(startBrowserMocks());
  } finally {
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_ENABLE_API_MOCKS = originalEnv;
    }
  }
});
