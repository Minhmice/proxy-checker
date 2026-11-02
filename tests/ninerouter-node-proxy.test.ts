import test from "node:test";
import assert from "node:assert/strict";
import { getNodeInventory, resolveNodeUrl } from "../src/server/ninerouter-node-proxy.js";

test("getNodeInventory returns single Pi Master node", () => {
  const nodes = getNodeInventory();
  assert.equal(nodes.length, 1);
  const lan = nodes.find((n) => n.id === "server-lan");
  const vpn = nodes.find((n) => n.id === "server-vpn");
  assert.ok(lan, "Master Node LAN must exist");
  assert.equal(vpn, undefined, "Decommissioned server-vpn must not exist");
  assert.equal(lan.url.includes("192.168.1.54"), true);
});

test("resolveNodeUrl resolves Pi base url and rejects unknown node IDs", () => {
  const urlLan = resolveNodeUrl("server-lan");
  assert.equal(urlLan, "http://192.168.1.54:20128");
  assert.throws(() => resolveNodeUrl("server-vpn"), /Unknown 9Router node ID/);
});
