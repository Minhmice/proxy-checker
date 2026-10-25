import test from "node:test";
import assert from "node:assert/strict";
import { getNodeInventory, resolveNodeUrl } from "../src/server/ninerouter-node-proxy.js";

test("getNodeInventory returns both LAN and VPN nodes", () => {
  const nodes = getNodeInventory();
  assert.equal(nodes.length >= 2, true);
  const lan = nodes.find((n) => n.id === "server-lan");
  const vpn = nodes.find((n) => n.id === "server-vpn");
  assert.ok(lan, "Master Node LAN must exist");
  assert.ok(vpn, "Tailscale Node VPN must exist");
  assert.equal(lan.url.includes("192.168.1.54"), true);
  assert.equal(vpn.url.includes("100.73.175.42"), true);
});

test("resolveNodeUrl resolves correct base url", () => {
  const urlLan = resolveNodeUrl("server-lan");
  assert.equal(urlLan, "http://192.168.1.54:20128");
  const urlVpn = resolveNodeUrl("server-vpn");
  assert.equal(urlVpn, "http://100.73.175.42:20128");
});
