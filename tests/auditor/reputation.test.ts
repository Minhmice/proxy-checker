import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchReputationSignals } from "../../src/auditor/reputation/aggregate.js";
import { ReputationCache } from "../../src/auditor/reputation/cache.js";
import { ProviderRateLimiter } from "../../src/auditor/reputation/limiter.js";
import { fetchIpinfo } from "../../src/auditor/reputation/ipinfo.js";
import { fetchIpqs } from "../../src/auditor/reputation/ipqs.js";
import { fetchAbuseIpDb } from "../../src/auditor/reputation/abuseipdb.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("provider adapters parse typed IPinfo, IPQS, and AbuseIPDB reports", async () => {
  const ipinfo = await fetchIpinfo("198.51.100.8", {
    apiKey: "ipinfo-key",
    endpoint: "https://ipinfo.test",
    fetch: async () => json({ country: "US", org: "AS64500 Example ISP", privacy: { hosting: true, vpn: false, proxy: false, tor: false } }),
  });
  const ipqs = await fetchIpqs("198.51.100.8", {
    apiKey: "ipqs-key",
    endpoint: "https://ipqs.test",
    fetch: async () => json({ success: true, fraud_score: 88, vpn: true, proxy: true, tor: false, ISP: "Example ISP", ASN: 64500 }),
  });
  const abuse = await fetchAbuseIpDb("198.51.100.8", {
    apiKey: "abuse-key",
    endpoint: "https://abuse.test",
    fetch: async () => json({ data: { abuseConfidenceScore: 67, totalReports: 12 } }),
  });

  assert.deepEqual(ipinfo.data, { asn: "AS64500", isp: "Example ISP", country: "US", hosting: true, vpn: false, proxy: false, tor: false });
  assert.deepEqual(ipqs.data, { asn: "AS64500", isp: "Example ISP", fraudScore: 88, vpn: true, proxy: true, tor: false });
  assert.deepEqual(abuse.data, { abuseConfidenceScore: 67, totalReports: 12 });
});

test("reputation cache expires ASN after 24h and reputation after 6h", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-"));
  let now = 1_000;
  const cache = new ReputationCache({ filePath: path.join(directory, "cache.json"), now: () => now });
  await cache.set("198.51.100.8", "asn", { asn: "AS64500" });
  await cache.set("198.51.100.8", "reputation", { fraudScore: 10 });

  now += 6 * 60 * 60 * 1_000 + 1;
  assert.deepEqual(await cache.get("198.51.100.8", "asn"), { asn: "AS64500" });
  assert.equal(await cache.get("198.51.100.8", "reputation"), undefined);
  now = 1_000 + 24 * 60 * 60 * 1_000 + 1;
  assert.equal(await cache.get("198.51.100.8", "asn"), undefined);
});

test("reputation cache recovers from corrupt files and rewrites valid JSON atomically", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-"));
  const filePath = path.join(directory, "cache.json");
  await writeFile(filePath, "{broken", "utf8");
  const cache = new ReputationCache({ filePath });

  assert.equal(await cache.get("203.0.113.2", "asn"), undefined);
  await cache.set("203.0.113.2", "asn", { asn: "AS64496" });
  const saved = await readFile(filePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(saved));
});
test("token buckets are isolated per provider", async () => {
  let now = 0;
  const waits: number[] = [];
  const limiter = new ProviderRateLimiter({
    capacity: 1,
    refillPerSecond: 1,
    now: () => now,
    sleep: async (ms) => { waits.push(ms); now += ms; },
  });

  await limiter.acquire("ipinfo");
  await limiter.acquire("ipqs");
  assert.deepEqual(waits, []);
  await limiter.acquire("ipinfo");
  assert.deepEqual(waits, [1_000]);
});

test("aggregation degrades unavailable and failed providers without throwing", async () => {
  const result = await fetchReputationSignals("198.51.100.8", {
    apiKeys: { ipqs: "ipqs-key", abuseipdb: "abuse-key" },
    endpoints: { ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async (input) => {
      const url = String(input);
      return url.includes("ipqs") ? json({}, 429) : json({}, 500);
    },
  });

  assert.deepEqual(result.raw.map(({ provider, status }) => ({ provider, status })), [
    { provider: "ipinfo", status: "unavailable" },
    { provider: "ipqs", status: "unavailable" },
    { provider: "abuseipdb", status: "error" },
  ]);
  assert.deepEqual(result.network, {});
  assert.equal(result.reputation.score, null);
});

test("aggregation keeps privacy indicators separate from malicious abuse", async () => {
  const result = await fetchReputationSignals("198.51.100.8", {
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64500 Privacy Network", privacy: { vpn: true, proxy: true, tor: false, hosting: false } });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 0, vpn: true, proxy: true, tor: false });
      return json({ data: { abuseConfidenceScore: 0, totalReports: 0 } });
    },
  });

  assert.equal(result.network.isVpn, true);
  assert.equal(result.network.isProxy, true);
  assert.deepEqual(result.reputation.privacySignals, ["vpn", "proxy"]);
  assert.deepEqual(result.reputation.maliciousSignals, []);
  assert.equal(result.reputation.score, 0);
});

test("aggregation serves fresh cache without calling providers or extending TTL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-first-"));
  const cachePath = path.join(directory, "cache.json");
  let calls = 0;
  const options = {
    cachePath,
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    fetch: async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64500 Cached ISP", privacy: { vpn: true } });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 40, vpn: true });
      return json({ data: { abuseConfidenceScore: 20, totalReports: 2 } });
    },
  };

  const first = await fetchReputationSignals("198.51.100.44", options);
  const before = JSON.parse(await readFile(cachePath, "utf8")) as {
    asn: Record<string, { expiresAt: number }>;
    reputation: Record<string, { expiresAt: number }>;
  };
  const second = await fetchReputationSignals("198.51.100.44", options);
  const after = JSON.parse(await readFile(cachePath, "utf8")) as typeof before;

  assert.equal(calls, 3);
  assert.deepEqual(second.network, first.network);
  assert.deepEqual(second.reputation, first.reputation);
  assert.equal(after.asn["198.51.100.44"]?.expiresAt, before.asn["198.51.100.44"]?.expiresAt);
  assert.equal(after.reputation["198.51.100.44"]?.expiresAt, before.reputation["198.51.100.44"]?.expiresAt);
});

test("cache merges new IPs with existing file data and ignores malformed entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-merge-"));
  const filePath = path.join(directory, "cache.json");
  const first = new ReputationCache({ filePath });
  await first.set("198.51.100.1", "asn", { asn: "AS64501" });
  const second = new ReputationCache({ filePath });
  await second.set("198.51.100.2", "asn", { asn: "AS64502" });

  assert.deepEqual(await second.get("198.51.100.1", "asn"), { asn: "AS64501" });
  assert.deepEqual(await second.get("198.51.100.2", "asn"), { asn: "AS64502" });

  await writeFile(filePath, JSON.stringify({ asn: { broken: { data: { asn: "AS1" } } }, reputation: {} }), "utf8");
  const malformed = new ReputationCache({ filePath });
  assert.equal(await malformed.get("broken", "asn"), undefined);
});

test("provider failures hide URL credentials and HTTP 429 is unavailable", async () => {
  const secret = "token-that-must-not-leak";
  const throwingFetch = async () => {
    throw new Error(`request failed for https://provider.test/${secret}?token=${secret}`);
  };
  const [ipinfoFailure, ipqsFailure] = await Promise.all([
    fetchIpinfo("198.51.100.9", { apiKey: secret, fetch: throwingFetch }),
    fetchIpqs("198.51.100.9", { apiKey: secret, fetch: throwingFetch }),
  ]);
  assert.equal(ipinfoFailure.error?.includes(secret), false);
  assert.equal(ipqsFailure.error?.includes(secret), false);

  const [ipinfo429, ipqs429, abuse429] = await Promise.all([
    fetchIpinfo("198.51.100.9", { apiKey: "a", fetch: async () => json({}, 429) }),
    fetchIpqs("198.51.100.9", { apiKey: "b", fetch: async () => json({}, 429) }),
    fetchAbuseIpDb("198.51.100.9", { apiKey: "c", fetch: async () => json({}, 429) }),
  ]);
  assert.deepEqual([ipinfo429.status, ipqs429.status, abuse429.status], ["unavailable", "unavailable", "unavailable"]);
});

test("aggregation starts provider requests concurrently", async () => {
  const pending: Array<() => void> = [];
  let started = 0;
  const request = fetchReputationSignals("203.0.113.77", {
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    fetch: async (input) => {
      started += 1;
      const { promise, resolve } = Promise.withResolvers<void>();
      pending.push(resolve);
      await promise;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64500 Example" });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 10 });
      return json({ data: { abuseConfidenceScore: 10, totalReports: 0 } });
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, 3);
  for (const resolve of pending) resolve();
  await request;
});

test("one provider score is not treated as consensus", async () => {
  const result = await fetchReputationSignals("203.0.113.78", {
    apiKeys: { ipqs: "only-provider" },
    fetch: async () => json({ success: true, fraud_score: 91 }),
  });

  assert.equal(result.reputation.fraudScore, 91);
  assert.equal(result.reputation.score, null);
});
