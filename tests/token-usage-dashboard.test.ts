import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { formatTokens } from "../src/components/ninerouter/mini-usage-card.js";
import { fetchTokenUsage } from "../src/lib/api.js";

test("Token usage dashboard integration: Overview page imports and renders TokenUsageCard", () => {
  const pageContent = fs.readFileSync("src/app/(dashboard)/page.tsx", "utf8");
  assert.ok(
    pageContent.includes("TokenUsageCard"),
    "Overview page must import and render TokenUsageCard",
  );
  assert.ok(
    pageContent.includes("<TokenUsageCard"),
    "Overview page JSX must contain <TokenUsageCard",
  );
});

test("Token usage component file exists and exports TokenUsageCard", () => {
  const componentContent = fs.readFileSync("src/components/token-usage-card.tsx", "utf8");
  assert.ok(
    componentContent.includes("export function TokenUsageCard"),
    "token-usage-card.tsx must export TokenUsageCard function",
  );
  assert.ok(
    componentContent.includes("fetchTokenUsage"),
    "token-usage-card.tsx must use fetchTokenUsage API",
  );
  assert.ok(
    componentContent.includes("formatTokens"),
    "token-usage-card.tsx must use formatTokens utility",
  );
});

test("API routes: NineRouter routes include /stats aggregate endpoint", () => {
  const routeContent = fs.readFileSync("src/server/api/routes/ninerouter.ts", "utf8");
  assert.ok(
    routeContent.includes('router.get("/stats"'),
    "ninerouter.ts must expose GET /stats endpoint",
  );
  assert.ok(
    routeContent.includes("getNodeInventory"),
    "ninerouter.ts must query node inventory for stats",
  );
});

test("Token formatting edge cases handle boundaries correctly", () => {
  assert.equal(formatTokens(null), "0");
  assert.equal(formatTokens(undefined), "0");
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_000), "1.0K");
  assert.equal(formatTokens(1_500_000), "1.5M");
  assert.equal(formatTokens(2_450_000_000), "2.45B");
});

test("fetchTokenUsage falls back to node stats on 404", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const calls: string[] = [];
    globalThis.fetch = async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      calls.push(urlStr);
      if (urlStr.includes("/api/ninerouter/stats")) {
        return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }
      if (urlStr.includes("/api/ninerouter/nodes/server-lan/stats")) {
        return new Response(
          JSON.stringify({
            totalRequests: 10,
            totalPromptTokens: 2000,
            totalCompletionTokens: 500,
            totalCachedTokens: 300,
            totalCost: 0.05,
            byModel: {
              "gemini-3.8-flash": {
                requests: 10,
                promptTokens: 2000,
                completionTokens: 500,
                cachedTokens: 300,
                cost: 0.05,
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const result = await fetchTokenUsage("password123", "today");

    assert.equal(calls.length, 2, "Should try aggregate first, then node fallback");
    assert.ok(calls[0].includes("/api/ninerouter/stats"));
    assert.ok(calls[1].includes("/api/ninerouter/nodes/server-lan/stats"));
    assert.equal(result.totalTokens, 2800);
    assert.equal(result.totalPromptTokens, 2000);
    assert.equal(result.totalCompletionTokens, 500);
    assert.equal(result.totalCachedTokens, 300);
    assert.equal(result.nodes[0].id, "server-lan");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
