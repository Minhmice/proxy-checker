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
    { provider: "ipqs", status: "error" },
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
