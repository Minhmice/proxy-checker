import test from "node:test";
import assert from "node:assert/strict";
import { classifyQuotaResponse, proxyEndpointKey } from "../src/server/antigravity-observation.js";

const route = {
  routerUrl: "http://router-a",
  accountId: "a",
  proxyPoolId: "pool-a",
  bindingRevision: 1,
  poolRevision: 1,
};
test("quota 403 remains unknown and never fabricates exhaustion", () => {
  const result = classifyQuotaResponse(
    { message: "Antigravity quota API access forbidden. Chat may still work.", quotas: {} },
    route,
  );
  assert.equal(result.status, "unknown");
  assert.equal(result.sessionPercentage, null);
});
test("valid zero session quota is distinct from missing session", () => {
  assert.equal(
    classifyQuotaResponse({ quotas: { gemini_session: { remainingPercentage: 0 } } }, route)
      .sessionPercentage,
    0,
  );
  assert.equal(
    classifyQuotaResponse({ quotas: { gemini_weekly: { remainingPercentage: 88 } } }, route)
      .sessionPercentage,
    null,
  );
});
test("physical proxy identity excludes credentials and path", () => {
  assert.equal(
    proxyEndpointKey("http://alice:secret@EXAMPLE.com:8080/path?x=1"),
    "http://example.com:8080",
  );
  assert.equal(proxyEndpointKey("socks5h://example.com"), "socks5://example.com:1080");
});
