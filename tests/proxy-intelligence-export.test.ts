import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("exportWorkingProxies returns only strict qualifying proxies", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-export-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });
    const now = Date.now();

    // 1. Insert 4 proxies
    await repo.importProxies({
      source: "bulk.txt",
      content: [
        "http://user1:pass1@perfect.com:8080",
        "http://unreliable.com:8080",
        "http://dangerous.com:8080",
        "http://stale.com:8080",
      ].join("\n"),
    });

    // Update proxies directly: perfect is usable, others are dead
    db.run("UPDATE proxies SET status = 'usable', last_verdict = 'PASS' WHERE proxy_key LIKE '%perfect%'");
    db.run("UPDATE proxies SET status = 'dead', last_verdict = 'FAIL' WHERE proxy_key NOT LIKE '%perfect%'");
    // Test default TXT export (strict)
    const txtResult = await repo.exportWorkingProxies({
      format: "txt",
      includeCredentials: false,
    });

    const lines = txtResult.body.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "http://perfect.com:8080");

    // Test with includeCredentials = true
    const txtWithAuth = await repo.exportWorkingProxies({
      format: "txt",
      includeCredentials: true,
    });
    assert.ok(txtWithAuth.body.includes("http://user1:pass1@perfect.com:8080"));

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  }
});
