import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("proxy management repository endpoints handle pin, unlink, and delete contracts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-mgmt-api-test-"));
  const db = openProxyIntelligenceDb(tmpDir);
  const repo = createProxyIntelligenceRepository({ db });

  try {
    const key = "http://10.0.0.1:8080";
    await repo.importProxies({ content: key, source: "test" });

    // 1. Toggle pin
    const pinRes = await repo.setPin(key, true);
    assert.equal(pinRes, true);
    let p = await repo.getProxy(key);
    assert.equal(p?.isPinned, true);

    // 2. Unlink from router
    await repo.softDeleteFromRouter(key, "User unlinked");
    p = await repo.getProxy(key);
    assert.equal(p?.routerState, "removed");
    assert.equal(p?.lastError, "User unlinked");

    // 3. Guarded hard delete fails when pinned
    await assert.rejects(async () => await repo.hardDeleteProxy(key, false), /is pinned/i);

    // 4. Force hard delete succeeds
    const delRes = await repo.hardDeleteProxy(key, true);
    assert.equal(delRes.deleted, true);
    p = await repo.getProxy(key);
    assert.equal(p, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
