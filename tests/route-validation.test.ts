import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initAppConfig } from "../src/server/app-config.js";
import { createPoolRanker } from "../src/server/pool-ranker.js";
import { createDiagnosticRunner } from "../src/server/detailed-checker.js";

initAppConfig();

test("diagnostics run route accepts sampleCount precedence and clamps properly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diag-run-test-"));
  const inputDir = path.join(root, "input");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(inputDir, "sample.txt"), "127.0.0.1:8080\n");

  const runner = createDiagnosticRunner(
    { inputDir, dataDir },
    {
      testProxy: async (proxy) => ({
        id: Buffer.from(proxy.endpoint).toString("base64url"),
        endpoint: proxy.endpoint,
        protocol: proxy.protocol,
        status: "SUCCESS",
        statusCode: 200,
        latencyMs: 10,
        exitIp: "203.0.113.1",
        country: "US",
        isp: "Test ISP",
        isProxyOrHosting: false,
        headerLeakage: false,
        leakedHeaders: [],
        checkedAt: Date.now(),
      }),
    }
  );
  assert.equal(runner.files().length, 1);
  assert.equal(runner.files()[0].name, "sample.txt");

  // Run with both scope keys — sampleCount takes precedence
  await runner.run({ file: "sample.txt", samplePercent: 50, sampleCount: 1 });
  const job = runner.getJob();
  assert.equal(job.sampleCount, 1);
  assert.equal(job.total, 1);
});
