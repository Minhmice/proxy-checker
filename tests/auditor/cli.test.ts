import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { processProxyLines, writeFileAtomic } from "../../src/auditor/cli/bulk.js";
import type { BulkRecord } from "../../src/auditor/cli/bulk.js";
import { formatCsvRecords, formatHumanResult, sanitizeResult } from "../../src/auditor/cli/formatters.js";
import { runCli as runCliDirect } from "../../src/auditor/cli/index.js";
import type { ProxyAuditResult } from "../../src/auditor/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wrapper = path.join(root, "scripts/proxy-audit.mjs");

function result(host = "proxy.example"): ProxyAuditResult {
  return {
    proxy: {
      protocol: "http",
      host,
      port: 8080,
      username: "alice:********",
      password: undefined,
    },
    verdict: "WARN",
    scores: {
      overallSafety: null,
      transportSecurity: 80,
      privacy: 60,
      reputation: null,
      reliability: 90,
    },
    security: {
      inputValidation: { valid: true },
      ssrfProtection: { passed: true, resolvedIps: ["203.0.113.10"] },
    },
    riskFactors: [{
      id: "tls-old",
      severity: "medium",
      title: "Legacy TLS",
      description: "Endpoint negotiated TLS 1.2",
    }],
    recommendations: ["Require TLS 1.3"],
    metadata: {
      startedAt: "2026-09-22T00:00:00.000Z",
      completedAt: "2026-09-22T00:00:01.000Z",
      durationMs: 1_000,
      version: "1",
      toolVersion: "1",
      schemaVersion: "1",
    },
  };
}

async function runCli(args: string[], cwd = root): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ code: number | null; stdout: string; stderr: string }>();
  const child = spawn(process.execPath, [wrapper, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
  return await promise;
}

test("human output lists every score, risks, and recommendations without credentials", () => {
  const output = formatHumanResult(result());

  for (const label of ["Overall safety", "Transport security", "Privacy", "Reputation", "Reliability"]) {
    assert.match(output, new RegExp(label));
  }
  assert.match(output, /Overall safety:\s+Unknown/);
  assert.match(output, /Legacy TLS/);
  assert.match(output, /Endpoint negotiated TLS 1\.2/);
  assert.match(output, /Require TLS 1\.3/);
  assert.doesNotMatch(output, /alice|secret/i);
});

test("sanitizer removes credential fields and credential-bearing URLs", () => {
  const unsafe = {
    ...result(),
    connectivity: {
      reachable: false,
      error: "cannot connect to http://proxyuser:hunter2@proxy.example:8080",
    },
  };

  const serialized = JSON.stringify(sanitizeResult(unsafe));
  assert.doesNotMatch(serialized, /hunter2/);
  assert.doesNotMatch(serialized, /password/);
  assert.match(serialized, /\[REDACTED\]/);
});

test("bulk processing preserves order and bounds concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];

  const processing = processProxyLines(
    ["http://one.example:80", "http://two.example:80", "http://three.example:80"],
    { concurrency: 2 },
    async (proxy) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const index = proxy.includes("one") ? 0 : proxy.includes("two") ? 1 : 2;
      await gates[index].promise;
      active -= 1;
      return result(new URL(proxy).hostname);
    },
  );

  await Promise.resolve();
  assert.equal(maximum, 2);
  gates[1].resolve();
  await Promise.resolve();
  assert.equal(maximum, 2);
  gates[0].resolve();
  gates[2].resolve();

  const records = await processing;
  assert.deepEqual(records.map((record) => record.line), [1, 2, 3]);
  assert.deepEqual(records.map((record) => record.status), ["ok", "ok", "ok"]);
  assert.deepEqual(records.map((record) => record.status === "ok" ? record.result.proxy.host : ""), [
    "one.example",
    "two.example",
    "three.example",
  ]);
});

test("bulk processing keeps blank and invalid lines as sanitized structured failures", async () => {
  const password = "raw-password";
  const records = await processProxyLines(
    ["", `not-a-proxy-${password}`],
    { concurrency: 5 },
    async () => { throw new Error(`failed ${password}`); },
  );

  assert.deepEqual(records.map((record) => record.status), ["error", "error"]);
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, new RegExp(password));
  assert.doesNotMatch(serialized, /not-a-proxy/);
});

test("CSV uses RFC4180 quoting and neutralizes spreadsheet formulas", () => {
  const records: BulkRecord[] = [{
    line: 1,
    status: "ok",
    result: {
      ...result("=1+1,\"quoted\"\r\nnext"),
      recommendations: ["@IMPORTXML(\"https://example.invalid\")"],
    },
  }];

  const csv = formatCsvRecords(records);
  assert.match(csv, /"'=1\+1,""quoted""\r\nnext"/);
  assert.match(csv, /"'@IMPORTXML\(""https:\/\/example\.invalid""\)"/);
  assert.equal(csv.endsWith("\r\n"), true);
});

test("atomic writer replaces destination and leaves no temporary file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "proxy-audit-cli-"));
  const destination = path.join(directory, "results.json");
  await writeFile(destination, "old", "utf8");

  await writeFileAtomic(destination, "new");

  assert.equal(await readFile(destination, "utf8"), "new");
  assert.deepEqual((await readdir(directory)).sort(), ["results.json"]);
});

test("wrapper returns usage code without echoing credential arguments", async () => {
  const credential = "do-not-print-this";
  const completed = await runCli(["unknown-command", `http://alice:${credential}@proxy.example:8080`]);

  assert.equal(completed.code, 2);
  assert.match(completed.stderr, /Usage:/);
  assert.doesNotMatch(completed.stdout + completed.stderr, new RegExp(credential));
  assert.doesNotMatch(completed.stdout + completed.stderr, /alice/);
});

test("check-file reports missing input without exposing unrelated arguments", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "proxy-audit-cli-"));
  const completed = await runCli(["check-file", path.join(directory, "missing.txt")], directory);

  assert.equal(completed.code, 1);
  assert.match(completed.stderr, /Could not read proxy file/);
  assert.equal(completed.stdout, "");
});

test("check-file writes ordered structured failures to default results.json", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "proxy-audit-cli-"));
  const secret = "bulk-secret";
  await writeFile(path.join(directory, "proxies.txt"), `\ninvalid-${secret}\n`, "utf8");

  const completed = await runCli(["check-file", "proxies.txt"], directory);
  const output = await readFile(path.join(directory, "results.json"), "utf8");
  const records = JSON.parse(output) as BulkRecord[];

  assert.equal(completed.code, 1);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.line), [1, 2]);
  assert.deepEqual(records.map((record) => record.status), ["error", "error"]);
  assert.doesNotMatch(completed.stdout + completed.stderr + output, new RegExp(secret));
});

test("numeric options reject unsafe values with usage code", async () => {
  for (const args of [
    ["check", "http://proxy.example:80", "--timeout", "0"],
    ["check", "http://proxy.example:80", "--attempts", "1.5"],
    ["check-file", "proxies.txt", "--concurrency", "51"],
  ]) {
    const completed = await runCli(args);
    assert.equal(completed.code, 2);
    assert.match(completed.stderr, /Usage:/);
  }
});

test("direct CLI runner supports mock engine injection for unit validation", async () => {
  const token = "super-secret-pass-token";
  const outcome = await runCliDirect(
    ["check", `http://alice:${token}@proxy.example:8080`, "--json"],
    async () => result(),
  );

  assert.equal(outcome.exitCode, 0);
  assert.doesNotMatch(outcome.stdout ?? "", new RegExp(token));
  assert.match(outcome.stdout ?? "", /proxy\.example/);
});
