import test from "node:test";
import assert from "node:assert/strict";
import { parseNineRouterUrls, normalizeNineRouterUrl } from "../src/server/app-config.js";

test("multi-target: parseNineRouterUrls correctly parses and normalizes dual URLs", () => {
  const parsed = parseNineRouterUrls("192.168.1.54, 9router.minhmice.com");
  assert.deepEqual(parsed, ["http://192.168.1.54", "http://9router.minhmice.com"]);
  const withProtocols = parseNineRouterUrls(
    "http://192.168.1.54:20128, https://9router.minhmice.com",
  );
  assert.deepEqual(withProtocols, ["http://192.168.1.54:20128", "https://9router.minhmice.com"]);

  const normalized = normalizeNineRouterUrl(
    "http://192.168.1.54:20128, https://9router.minhmice.com",
  );
  assert.equal(normalized, "http://192.168.1.54:20128, https://9router.minhmice.com");
});
