import "../src/server/load-env.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DetailedDiagnosticResult } from "../src/lib/types.js";
import { createDiagnosticRunner } from "../src/server/detailed-checker.js";

function createRunnerHarness(options: {
  endpoints: number;
  concurrency?: number;
  failIndex?: number;
  testDelayMs?: number;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-diagnostics-"));
  const input = path.join(root, "input");
  const data = path.join(root, "data");
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(
    path.join(input, "sample.txt"),
    Array.from({ length: options.endpoints }, (_, i) => `127.0.0.1:${1000 + i}`).join("\n")
  );

  let active = 0;
  let maxActive = 0;
  let callCount = 0;

  const fakeTestProxy = async (proxy: { endpoint: string; protocol: "http" | "socks5" }): Promise<DetailedDiagnosticResult> => {
    active++;
    maxActive = Math.max(maxActive, active);
    const index = callCount++;
    if (options.testDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.testDelayMs));
    }
    active--;
    if (options.failIndex !== undefined && index === options.failIndex) {
      return {
        id: Buffer.from(proxy.endpoint).toString("base64url"),
        endpoint: proxy.endpoint,
        protocol: proxy.protocol,
        status: "FAILED",
        statusCode: 500,
        latencyMs: 15,
        exitIp: null,
        country: null,
        isp: null,
        isProxyOrHosting: null,
        headerLeakage: null,
        leakedHeaders: [],
        checkedAt: Date.now(),
        error: "simulated failure",
      };
    }
    return {
      id: Buffer.from(proxy.endpoint).toString("base64url"),
      endpoint: proxy.endpoint,
      protocol: proxy.protocol,
      status: "SUCCESS",
      statusCode: 200,
      latencyMs: 10,
      exitIp: "198.51.100.1",
      country: "US",
      isp: "Test ISP",
      isProxyOrHosting: false,
      headerLeakage: false,
      leakedHeaders: [],
      checkedAt: Date.now(),
    };
  };

  const runner = createDiagnosticRunner(
    { inputDir: input, dataDir: data },
    {
      testProxy: fakeTestProxy,
      getConcurrency: () => options.concurrency ?? 3,
      persistIntervalMs: 25,
    }
  );

  return {
    runner,
    get maxActive() {
      return maxActive;
    },
  };
}

test("diagnostics honors percent and custom count scopes", async () => {
  const percent = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await percent.runner.run({ file: "sample.txt", samplePercent: 50 });
  assert.equal(percent.runner.getJob().total, 5);

  const count = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await count.runner.run({ file: "sample.txt", samplePercent: 10, sampleCount: 7 });
  assert.equal(count.runner.getJob().total, 7);
});

test("diagnostics never exceeds configured concurrency and continues after failure", async () => {
  const harness = createRunnerHarness({ endpoints: 8, concurrency: 3, failIndex: 2, testDelayMs: 20 });
  await harness.runner.run({ file: "sample.txt", sampleCount: 8 });
  assert.ok(harness.maxActive <= 3, `Expected maxActive <= 3, got ${harness.maxActive}`);
  assert.equal(harness.runner.getJob().checked, 8);
  assert.equal(harness.runner.getJob().status, "done");
});
