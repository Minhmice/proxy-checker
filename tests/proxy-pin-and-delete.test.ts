import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openProxyIntelligenceDb } from "../src/server/proxy-intelligence-db.js";
import { createProxyIntelligenceRepository } from "../src/server/proxy-intelligence-repository.js";

test("proxy repository supports pin, tags, soft delete from router, and guarded hard delete", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pin-test-"));
  const db = openProxyIntelligenceDb(tmpDir);
  const repo = createProxyIntelligenceRepository({ db });

  try {
    // 1. Import a test proxy
    await repo.importProxies({ content: "http://user:pass@1.2.3.4:8080", source: "test" });
    const list = await repo.getUnifiedProxies({});
    assert.equal(list.items.length, 1);
    const proxy = list.items[0];
    assert.equal(proxy.isPinned, false);
    assert.equal(proxy.routerState, "unmanaged");
    assert.deepEqual(proxy.tags, []);

    // 2. Pin proxy and update tags
    const pinRes = await repo.setPin(proxy.proxyKey, true);
    assert.equal(pinRes, true);
    await repo.updateTags(proxy.proxyKey, ["custom", "residential"]);
    let updated = await repo.getProxy(proxy.proxyKey);
    assert.equal(updated?.isPinned, true);
    assert.deepEqual(updated?.tags, ["custom", "residential"]);

    // 3. Record test failure and soft delete from router
    await repo.recordTestResult(proxy.proxyKey, false, undefined, "Connection timeout");
    await repo.softDeleteFromRouter(proxy.proxyKey, "Connection timeout");
    updated = await repo.getProxy(proxy.proxyKey);
    assert.equal(updated?.status, "dead");
    assert.equal(updated?.routerState, "removed");
    assert.ok(updated?.removedAt);
    assert.equal(updated?.lastError, "Connection timeout");

    // 4. Guarded hard delete: cannot delete pinned proxy without force
    await assert.rejects(
      async () => await repo.hardDeleteProxy(proxy.proxyKey, false),
      /is pinned/i
    );

    // 5. Force hard delete removes record completely
    const delRes = await repo.hardDeleteProxy(proxy.proxyKey, true);
    assert.equal(delRes.deleted, true);
    const afterDel = await repo.getProxy(proxy.proxyKey);
    assert.equal(afterDel, null);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
