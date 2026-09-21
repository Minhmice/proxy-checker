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

function harness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "server-routes-"));
  const inputDir = path.join(root, "input");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  fs.writeFileSync(path.join(inputDir, "test-file.txt"), "127.0.0.1:8080\n");

  const poolRanker = createPoolRanker({ dataDir });
  const diagnostics = createDiagnosticRunner({ inputDir, dataDir });

  function json(res: http.ServerResponse, payload: unknown, status = 200) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": body.length });
    res.end(body);
  }

  async function handleTest(reqBody: Record<string, unknown>, res: http.ServerResponse) {
    if (!Array.isArray(reqBody.ids) || reqBody.ids.length === 0) {
      return json(res, { error: "ids must be a non-empty array of strings" }, 400);
    }
    for (const item of reqBody.ids) {
      if (typeof item !== "string" || !item.trim()) {
        return json(res, { error: "Each id must be a non-empty string" }, 400);
      }
    }
    const rawIds = reqBody.ids as string[];
    const uniqueIds = Array.from(new Set(rawIds));
    if (uniqueIds.length !== rawIds.length) {
      return json(res, { error: "Duplicate pool ids are not allowed in test batch" }, 400);
    }
    const state = poolRanker.readState();
    for (const id of rawIds) {
      if (!state.pools[id]) {
        return json(res, { error: `Pool not found: ${id}` }, 404);
      }
    }
    const result = await poolRanker.testPools(rawIds);
    return json(res, result, 202);
  }

  async function handleDiagRun(reqBody: Record<string, unknown>, res: http.ServerResponse) {
    const hasPercent = reqBody.samplePercent !== undefined && reqBody.samplePercent !== null;
    const hasCount = reqBody.sampleCount !== undefined && reqBody.sampleCount !== null;

    if (!hasPercent && !hasCount) {
      return json(res, { error: "Either samplePercent or sampleCount is required" }, 400);
    }
    if (hasPercent && hasCount) {
      return json(res, { error: "Cannot specify both samplePercent and sampleCount" }, 400);
    }
    if (hasPercent) {
      const p = Number(reqBody.samplePercent);
      if (!Number.isFinite(p) || p <= 0) {
        return json(res, { error: "samplePercent must be a positive finite number" }, 400);
      }
    }
    if (hasCount) {
      const c = Number(reqBody.sampleCount);
      if (!Number.isFinite(c) || c <= 0 || !Number.isInteger(c)) {
        return json(res, { error: "sampleCount must be a positive integer" }, 400);
      }
    }
    if (typeof reqBody.file === "string") {
      const available = diagnostics.files().map((f) => f.name);
      if (!available.includes(reqBody.file)) {
        return json(res, { error: `File not found: ${reqBody.file}` }, 404);
      }
    } else {
      return json(res, { error: "file must be a string" }, 400);
    }
    return json(res, { started: true }, 202);
  }

  return { handleTest, handleDiagRun, poolRanker };
}

function mockRes() {
  let status = 200;
  let body: unknown = null;
  const res = {
    writeHead(s: number) { status = s; },
    end(b: Buffer) { body = JSON.parse(b.toString("utf8")); },
  } as unknown as http.ServerResponse;
  return { res, get status() { return status; }, get body() { return body as Record<string, unknown>; } };
}

test("test route rejects malformed, unknown, and duplicate IDs", async () => {
  const { handleTest } = harness();
  const res1 = mockRes();
  await handleTest({ ids: [] }, res1.res);
  assert.equal(res1.status, 400);

  const res2 = mockRes();
  await handleTest({ ids: ["valid", 123] }, res2.res);
  assert.equal(res2.status, 400);

  const res3 = mockRes();
  await handleTest({ ids: ["a", "a"] }, res3.res);
  assert.equal(res3.status, 400);

  const res4 = mockRes();
  await handleTest({ ids: ["unknown-id"] }, res4.res);
  assert.equal(res4.status, 404);
});

test("diagnostics run route validates files and scope boundaries", async () => {
  const { handleDiagRun } = harness();
  const res1 = mockRes();
  await handleDiagRun({}, res1.res);
  assert.equal(res1.status, 400);

  const res2 = mockRes();
  await handleDiagRun({ samplePercent: 30, sampleCount: 10 }, res2.res);
  assert.equal(res2.status, 400);

  const res3 = mockRes();
  await handleDiagRun({ samplePercent: -5, file: "test-file.txt" }, res3.res);
  assert.equal(res3.status, 400);

  const res4 = mockRes();
  await handleDiagRun({ sampleCount: 2.5, file: "test-file.txt" }, res4.res);
  assert.equal(res4.status, 400);

  const res5 = mockRes();
  await handleDiagRun({ samplePercent: 50, file: "missing.txt" }, res5.res);
  assert.equal(res5.status, 404);

  const res6 = mockRes();
  await handleDiagRun({ samplePercent: 50, file: "test-file.txt" }, res6.res);
  assert.equal(res6.status, 202);
});
