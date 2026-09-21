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
    if (active > maxActive) maxActive = active;
    const current = callCount++;
    if (options.testDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.testDelayMs));
    }
    active--;

    if (options.failIndex !== undefined && current === options.failIndex) {
      throw new Error(`Synthetic probe failure on item ${current}`);
    }

    return {
      id: Buffer.from(proxy.endpoint).toString("base64url"),
      endpoint: proxy.endpoint,
      protocol: proxy.protocol,
      status: "SUCCESS",
      statusCode: 200,
      latencyMs: 12,
      exitIp: "203.0.113.195",
      country: "US",
      isp: "Synthetic Telecom",
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
      getConcurrency: () => options.concurrency ?? 5,
      persistIntervalMs: 50,
    }
  );

  return {
    runner,
    get maxActive() {
      return maxActive;
    },
    get callCount() {
      return callCount;
    },
  };
}

test("diagnostic file listing tolerates a file removed during scan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-diagnostics-race-"));
  const input = path.join(root, "input");
  const data = path.join(root, "data");
  fs.mkdirSync(input, { recursive: true });
  fs.writeFileSync(path.join(input, "vanishing.txt"), "127.0.0.1:8080\n");
  const runner = createDiagnosticRunner({ inputDir: input, dataDir: data });
  const originalReadDir = fs.readdirSync;
  try {
    fs.readdirSync = ((directory: fs.PathLike, options?: fs.ObjectEncodingOptions | BufferEncoding | null) => {
      const names = originalReadDir(directory, options as never) as string[];
      fs.unlinkSync(path.join(input, "vanishing.txt"));
      return names;
    }) as typeof fs.readdirSync;
    assert.doesNotThrow(() => runner.files());
  } finally {
    fs.readdirSync = originalReadDir;
  }
});

test("diagnostics honors percent and custom count scopes", async () => {
  const percent = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await percent.runner.run({ file: "sample.txt", samplePercent: 50 });
  assert.equal(percent.runner.getJob().total, 5);

  const count = createRunnerHarness({ endpoints: 10, concurrency: 3 });
  await count.runner.run({ file: "sample.txt", samplePercent: 10, sampleCount: 7 });
  assert.equal(count.runner.getJob().total, 7);
});

test("diagnostics never exceeds configured concurrency and continues after failure", async () => {
  const harness = createRunnerHarness({ endpoints: 8, concurrency: 3, failIndex: 2, testDelayMs: 5 });
  await harness.runner.run({ file: "sample.txt", sampleCount: 8 });
  assert.ok(harness.maxActive <= 3, `Expected maxActive <= 3, got ${harness.maxActive}`);
  assert.equal(harness.runner.getJob().checked, 8);
  assert.equal(harness.runner.getJob().status, "done");
});

test("diagnostics tracks aggregate passed and failed beyond 500 result cap", async () => {
  const harness = createRunnerHarness({ endpoints: 550, concurrency: 20, failIndex: 10 });
  await harness.runner.run({ file: "sample.txt", sampleCount: 550 });
  const job = harness.runner.getJob();
  assert.equal(job.checked, 550);
  assert.equal(job.results.length, 500);
  assert.equal(job.passedCount, 549);
  assert.equal(job.failedCount, 1);
});
