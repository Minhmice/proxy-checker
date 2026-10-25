#!/usr/bin/env node
import "../src/server/load-env.js";
import { listPools, testPool, nineRouterConfigured } from "../src/server/nine-router-client.js";

async function main() {
  if (!nineRouterConfigured()) {
    console.error("\x1b[31mError: 9Router is not configured in settings or environment.\x1b[0m");
    process.exit(1);
  }

  console.log("\x1b[36mFetching proxy pools from 9Router...\x1b[0m");
  const pools = await listPools();
  if (pools.length === 0) {
    console.log("\x1b[33mNo proxy pools found on 9Router.\x1b[0m");
    return;
  }

  console.log(
    `\x1b[32mFound ${pools.length} pool(s). Starting 9Router terminal health check...\x1b[0m\n`,
  );

  let passed = 0;
  let failed = 0;
  const startTime = Date.now();
  const concurrency = 5;
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < pools.length) {
      const i = currentIndex++;
      const pool = pools[i];
      const indexStr = `[${i + 1}/${pools.length}]`.padEnd(8);
      const nameStr = (pool.name || "unnamed").padEnd(16);

      try {
        const res = await testPool(pool.id);
        if (res.ok) {
          passed++;
          const elapsed = res.elapsedMs ? `${res.elapsedMs}ms` : "OK";
          console.log(
            `${indexStr} ${nameStr} (${pool.proxyUrl}) ... \x1b[32mPASS\x1b[0m (${elapsed})`,
          );
        } else {
          failed++;
          const errMsg = res.error || `HTTP ${res.status || "FAIL"}`;
          console.log(
            `${indexStr} ${nameStr} (${pool.proxyUrl}) ... \x1b[31mFAIL\x1b[0m (${errMsg})`,
          );
        }
      } catch (err: unknown) {
        failed++;
        console.log(
          `${indexStr} ${nameStr} (${pool.proxyUrl}) ... \x1b[31mERROR\x1b[0m (${(err as Error).message})`,
        );
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n\x1b[36mCompleted in ${duration}s | Total: ${pools.length} | Passed: \x1b[32m${passed}\x1b[36m | Failed: \x1b[31m${failed}\x1b[0m\n`,
  );
}

main().catch((err) => {
  console.error("\x1b[31mHealth check failed:\x1b[0m", err.message);
  process.exit(1);
});
