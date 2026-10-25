import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("previewImport calculates counts and protocols without mutating database", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prev-test-"));
  try {
    const db = openProxyIntelligenceDb(tmpDir);
    const repo = createProxyIntelligenceRepository({ db });

    const content = `
      http://1.1.1.1:8080
      socks5://2.2.2.2:1080
      socks5://2.2.2.2:1080
      invalid-not-a-proxy
      https://3.3.3.3:8443
    `;

    // 1. Preview
    const preview = await repo.previewImport({
      source: "test-batch.txt",
      content,
    });

    assert.equal(preview.totalLines, 5);
    assert.equal(preview.valid, 3);
    assert.equal(preview.duplicates, 1);
    assert.equal(preview.invalid, 1);
    assert.equal(preview.protocols.http, 1);
    assert.equal(preview.protocols.socks5, 1);
    assert.equal(preview.protocols.https, 1);
    assert.equal(preview.invalidLines.length, 1);
    assert.equal(preview.invalidLines[0]?.text.trim(), "invalid-not-a-proxy");

    // Verify DB was NOT mutated
    const countBefore =
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count ?? 0;
    assert.equal(countBefore, 0, "previewImport must not write to database");

    // 2. Commit Import
    const result = await repo.importProxies({
      source: "test-batch.txt",
      content,
    });

    assert.equal(result.inserted, 3);
    assert.equal(result.duplicates, 1);
    assert.equal(result.invalid, 1);

    const countAfter =
      db.get<{ count: number }>("SELECT COUNT(*) AS count FROM proxies")?.count ?? 0;
    assert.equal(countAfter, 3, "importProxies commits valid records");

    db.close();
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
});
