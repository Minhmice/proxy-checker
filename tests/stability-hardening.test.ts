import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireDataLease, LEASE_STALE_MS } from "../src/db/common/maintenance-lease.js";
import {
  clearNineRouterSession,
  listAntigravityConnections,
  updateConnection,
} from "../src/server/nine-router-client.js";

test("9Router GET retries once on 502; mutations never replay", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  clearNineRouterSession();
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/auth/login")) {
      return new Response("{}", { status: 200, headers: { "set-cookie": "auth_token=t; Path=/" } });
    }
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (calls.length === 1 || init?.method === "PUT") {
      return new Response("bad gateway", { status: 502 });
    }
    return new Response(JSON.stringify({ connections: [] }), { status: 200 });
  }) as typeof fetch;

  const accounts = await listAntigravityConnections({ url: "http://pi:1", timeoutMs: 2000 });
  assert.deepEqual(accounts, []);
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2);

  calls.length = 0;
  await assert.rejects(updateConnection("x", { isActive: true }, { url: "http://pi:1" }));
  assert.equal(calls.length, 1);
});

test("lease left by crashed owner is reclaimed even if PID now belongs to a live node process", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-reuse-"));
  try {
    const owner = path.join(dir, ".proxy-checker.lease", "owner");
    fs.mkdirSync(path.dirname(owner));
    fs.writeFileSync(owner, `application\n${process.ppid}\n`);
    const old = new Date(Date.now() - LEASE_STALE_MS - 1000);
    fs.utimesSync(owner, old, old);
    const release = acquireDataLease(dir, "application");
    release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lease with fresh heartbeat from live owner still blocks a second instance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-live-"));
  try {
    const owner = path.join(dir, ".proxy-checker.lease", "owner");
    fs.mkdirSync(path.dirname(owner));
    fs.writeFileSync(owner, `application\n${process.ppid}\n`);
    assert.throws(() => acquireDataLease(dir, "application"), /locked/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
