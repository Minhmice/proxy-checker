import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDiagnosticRunner } from "../src/server/detailed-checker.js";

test("diagnostic runner caps every run at a 30 percent sample", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-diagnostics-"));
  const input = path.join(root, "input");
  const data = path.join(root, "data");
  fs.mkdirSync(input);
  fs.writeFileSync(path.join(input, "sample.txt"), Array.from({ length: 10 }, (_, index) => `127.0.0.1:${1 + index}`).join("\n"));
  const runner = createDiagnosticRunner({ inputDir: input, dataDir: data });
  await runner.run({ file: "sample.txt", samplePercent: 100 });
  const job = runner.getJob();
  assert.equal(job.samplePercent, 30);
  assert.equal(job.eligible, 10);
  assert.equal(job.total, 3);
  assert.equal(job.checked, 3);
  assert.equal(job.status, "done");
});
