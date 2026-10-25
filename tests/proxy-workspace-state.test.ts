import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProxyQuery,
  serializeProxyQuery,
  type ProxyWorkspaceQuery,
} from "../src/lib/proxy-url-state.js";

test("parseProxyQuery parses search, health, protocol, and pagination", () => {
  const query = parseProxyQuery(
    "?q=1.2.3.4&health=regressed&protocol=socks5&page=3&pageSize=25&sort=latency&direction=asc",
  );
  assert.equal(query.q, "1.2.3.4");
  assert.equal(query.health, "regressed");
  assert.equal(query.protocol, "socks5");
  assert.equal(query.page, 3);
  assert.equal(query.pageSize, 25);
  assert.equal(query.sort, "latency");
  assert.equal(query.direction, "asc");
});

test("parseProxyQuery applies defaults for missing or invalid parameters", () => {
  const query = parseProxyQuery("");
  assert.equal(query.health, "all");
  assert.equal(query.protocol, "all");
  assert.equal(query.page, 1);
  assert.equal(query.pageSize, 50);
  assert.equal(query.sort, "health");
  assert.equal(query.direction, "asc");
  assert.equal(query.q, "");
});

test("serializeProxyQuery omits default or empty values", () => {
  const defaultQuery: ProxyWorkspaceQuery = {
    q: "",
    health: "all",
    protocol: "all",
    source: "",
    sort: "health",
    direction: "asc",
    page: 1,
    pageSize: 50,
  };
  assert.equal(serializeProxyQuery(defaultQuery), "");

  const activeQuery: ProxyWorkspaceQuery = {
    ...defaultQuery,
    q: "10.0.0.1",
    health: "working",
    page: 2,
  };
  assert.equal(serializeProxyQuery(activeQuery), "q=10.0.0.1&health=working&page=2");
});
