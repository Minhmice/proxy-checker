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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("provider adapters parse typed reports with explicit booleans, ISO checkedAt, and redacted raw", async () => {
  const clock = () => 1_700_000_000_000;
  const ipinfo = await fetchIpinfo("198.51.100.8", {
    apiKey: "ipinfo-secret-token",
    endpoint: "https://ipinfo.test",
    now: clock,
    fetch: async () =>
      json({
        country: "US",
        region: "California",
        city: "Los Angeles",
        asn: { asn: "AS64500", name: "Example ISP" },
        privacy: { hosting: true, vpn: false, relay: true },
        company: { type: "isp" },
      }),
  });
  const ipqs = await fetchIpqs("198.51.100.8", {
    apiKey: "ipqs-secret-token",
    endpoint: "https://ipqs.test",
    now: clock,
    fetch: async () =>
      json({
        success: true,
        fraud_score: 88,
        vpn: true,
        recent_abuse: true,
        frequent_abuser: true,
        bot_status: false,
        connection_type: "Corporate",
        ISP: "Example ISP",
        ASN: 64500,
      }),
  });
  const abuse = await fetchAbuseIpDb("198.51.100.8", {
    apiKey: "abuse-secret-key",
    endpoint: "https://abuse.test",
    now: clock,
    fetch: async () =>
      json({
        data: {
          abuseConfidenceScore: 67,
          totalReports: 12,
          numDistinctUsers: 5,
          lastReportedAt: "2026-09-20T10:00:00Z",
          usageType: "Data Center",
          domain: "example.test",
        },
      }),
  });

  assert.equal(ipinfo.status, "success");
  assert.equal(ipinfo.checkedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(ipinfo.data?.tor, undefined);
  assert.equal(ipinfo.data?.proxy, undefined);
  assert.equal(ipinfo.data?.relay, true);
  assert.equal(ipinfo.data?.residential, true);
  assert.deepEqual(ipinfo.data?.city, "Los Angeles");

  assert.equal(ipqs.status, "success");
  assert.equal(ipqs.checkedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(ipqs.data?.recentAbuse, true);
  assert.equal(ipqs.data?.frequentAbuser, true);
  assert.equal(ipqs.data?.bot, false);
  assert.equal(ipqs.data?.connectionType, "Corporate");
  assert.equal(ipqs.data?.tor, undefined);

  assert.equal(abuse.status, "success");
  assert.equal(abuse.checkedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(abuse.data?.numDistinctUsers, 5);
  assert.equal(abuse.data?.lastReportedAt, "2026-09-20T10:00:00Z");
  assert.equal(abuse.data?.usageType, "Data Center");
  assert.equal(abuse.data?.domain, "example.test");

  assert.equal(JSON.stringify(ipinfo.raw).includes("ipinfo-secret-token"), false);
  assert.equal(JSON.stringify(ipqs.raw).includes("ipqs-secret-token"), false);
  assert.equal(JSON.stringify(abuse.raw).includes("abuse-secret-key"), false);
});

test("provider adapters enforce response cap, redirect error, and private endpoint restriction", async () => {
  const bigPayload = { data: "x".repeat(1024 * 1024 + 10) };
  const bigResponse = await fetchIpinfo("198.51.100.8", {
    apiKey: "key",
    endpoint: "https://ipinfo.test",
    fetch: async () => json(bigPayload),
  });
  assert.equal(bigResponse.status, "error");
  assert.equal(bigResponse.error, "Network request failed for ipinfo");

  let redirectOption: string | undefined;
  await fetchIpqs("198.51.100.8", {
    apiKey: "key",
    endpoint: "https://ipqs.test",
    fetch: async (_input, init) => {
      redirectOption = init?.redirect;
      return json({ success: true });
    },
  });
  assert.equal(redirectOption, "error");

  const blockedPrivate = await fetchIpinfo("198.51.100.8", {
    apiKey: "key",
    endpoint: "https://127.0.0.1:8080",
  });
  assert.equal(blockedPrivate.status, "error");
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

test("token buckets honor signal and deadline cancellation", async () => {
  let now = 0;
  const limiter = new ProviderRateLimiter({
    capacity: 1,
    refillPerSecond: 1,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });

  await limiter.acquire("ipinfo");
  const controller = new AbortController();
  controller.abort(new Error("custom-abort"));
  await assert.rejects(
    limiter.acquire("ipinfo", { signal: controller.signal }),
    /custom-abort/
  );

  await assert.rejects(
    limiter.acquire("ipinfo", { deadlineMs: now - 1 }),
    /deadline/
  );
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
  assert.deepEqual(result.network, { type: "unknown" });
  assert.equal(result.reputation.score, null);
});

test("aggregation distinguishes privacy from malicious and sets unknown network type without inference", async () => {
  const result = await fetchReputationSignals("198.51.100.8", {
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64500 Broadband Provider", privacy: { vpn: true } });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 0, recent_abuse: true });
      return json({ data: { abuseConfidenceScore: 0, totalReports: 0 } });
    },
  });

  assert.equal(result.network.isVpn, true);
  assert.equal(result.network.isResidential, undefined);
  assert.equal(result.network.type, "unknown");
  assert.deepEqual(result.reputation.privacySignals, ["vpn"]);
  assert.deepEqual(result.reputation.maliciousSignals, ["recent_abuse"]);
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
    fetchIpinfo("198.51.100.9", { apiKey: secret, endpoint: "https://ipinfo.test", fetch: throwingFetch }),
    fetchIpqs("198.51.100.9", { apiKey: secret, endpoint: "https://ipqs.test", fetch: throwingFetch }),
  ]);
  assert.equal(ipinfoFailure.error?.includes(secret), false);
  assert.equal(ipqsFailure.error?.includes(secret), false);

  const [ipinfo429, ipqs429, abuse429] = await Promise.all([
    fetchIpinfo("198.51.100.9", { apiKey: "a", endpoint: "https://ipinfo.test", fetch: async () => json({}, 429) }),
    fetchIpqs("198.51.100.9", { apiKey: "b", endpoint: "https://ipqs.test", fetch: async () => json({}, 429) }),
    fetchAbuseIpDb("198.51.100.9", { apiKey: "c", endpoint: "https://abuse.test", fetch: async () => json({}, 429) }),
  ]);
  assert.deepEqual([ipinfo429.status, ipqs429.status, abuse429.status], ["unavailable", "unavailable", "unavailable"]);
});

test("aggregation starts provider requests concurrently", async () => {
  const pending: Array<() => void> = [];
  let started = 0;
  const request = fetchReputationSignals("203.0.113.77", {
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
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
    endpoints: { ipqs: "https://ipqs.test" },
    fetch: async () => json({ success: true, fraud_score: 91 }),
  });

  assert.equal(result.reputation.fraudScore, 91);
  assert.equal(result.reputation.score, null);
});

test("cache hit replays real provider statuses and data instead of synthetic success", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-raw-"));
  const cachePath = path.join(directory, "cache.json");
  let calls = 0;
  const options = {
    cachePath,
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64510 Real ISP" });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 40 });
      return json({ data: { abuseConfidenceScore: 20, totalReports: 2 } });
    },
  };

  const first = await fetchReputationSignals("198.51.100.90", options);
  const second = await fetchReputationSignals("198.51.100.90", options);
  assert.equal(calls, 3);
  assert.deepEqual(
    second.raw.map((report) => JSON.parse(JSON.stringify({ ...report, cached: undefined }))),
    first.raw.map((report) => JSON.parse(JSON.stringify({ ...report, cached: undefined }))),
  );
});

test("partial provider failure retries failed providers after successful provider cache", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-partial-"));
  const cachePath = path.join(directory, "cache.json");
  let calls = 0;
  let recovered = false;
  const options = {
    cachePath,
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64511 Partial ISP" });
      if (!recovered) return json({}, url.includes("ipqualityscore") ? 429 : 500);
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 40 });
      return json({ data: { abuseConfidenceScore: 20, totalReports: 2 } });
    },
  };

  const first = await fetchReputationSignals("198.51.100.93", options);
  recovered = true;
  const second = await fetchReputationSignals("198.51.100.93", options);
  assert.equal(calls, 6);
  assert.deepEqual(first.raw.map((report) => report.status), ["success", "unavailable", "error"]);
  assert.deepEqual(second.raw.map((report) => report.status), ["success", "success", "success"]);
});

test("custom TTLs apply to in-memory aggregate cache without cache path", async () => {
  let calls = 0;
  const options = {
    cacheTtlAsnMs: 0,
    cacheTtlReputationMs: 0,
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64512 TTL ISP" });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 40 });
      return json({ data: { abuseConfidenceScore: 20, totalReports: 2 } });
    },
  };
  await fetchReputationSignals("198.51.100.94", options);
  await fetchReputationSignals("198.51.100.94", options);
  assert.equal(calls, 6);
});

test("custom TTL cache is reused until expiry", async () => {
  let now = 1_000;
  let calls = 0;
  const options = {
    cacheTtlAsnMs: 60_000,
    cacheTtlReputationMs: 60_000,
    now: () => now,
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async (input: string | URL | Request) => {
      calls += 1;
      const url = String(input);
      if (url.includes("ipinfo")) return json({ org: "AS64513 Reused TTL ISP" });
      if (url.includes("ipqualityscore")) return json({ success: true, fraud_score: 40 });
      return json({ data: { abuseConfidenceScore: 20, totalReports: 2 } });
    },
  };

  await fetchReputationSignals("198.51.100.95", options);
  await fetchReputationSignals("198.51.100.95", options);
  assert.equal(calls, 3);
  now += 60_001;
  await fetchReputationSignals("198.51.100.95", options);
  assert.equal(calls, 6);
});

test("all-provider failure is not cached so next call retries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-retry-"));
  let calls = 0;
  const options = {
    cachePath: path.join(directory, "cache.json"),
    apiKeys: { ipinfo: "a", ipqs: "b", abuseipdb: "c" },
    endpoints: { ipinfo: "https://ipinfo.test", ipqs: "https://ipqs.test", abuseipdb: "https://abuse.test" },
    fetch: async () => {
      calls += 1;
      return json({}, 500);
    },
  };

  await fetchReputationSignals("198.51.100.91", options);
  await fetchReputationSignals("198.51.100.91", options);
  assert.equal(calls, 6);
});

test("custom TTLs survive file persistence without extending in-memory expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-ttl-"));
  const filePath = path.join(directory, "cache.json");
  let now = 100;
  const writer = new ReputationCache({ filePath, now: () => now, asnTtlMs: 10, reputationTtlMs: 20 });
  await writer.set("198.51.100.92", "asn", { asn: "AS64592" });
  await writer.set("198.51.100.92", "reputation", { score: 5 });

  now = 111;
  const reader = new ReputationCache({ filePath, now: () => now, asnTtlMs: 10, reputationTtlMs: 20 });
  assert.equal(await reader.get("198.51.100.92", "asn"), undefined);
  assert.deepEqual(await reader.get("198.51.100.92", "reputation"), { score: 5 });
  now = 121;
  assert.equal(await writer.get("198.51.100.92", "reputation"), undefined);
});

test("concurrent cache writers preserve entries from both instances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "proxy-auditor-cache-lock-"));
  const filePath = path.join(directory, "cache.json");
  const first = new ReputationCache({ filePath });
  const second = new ReputationCache({ filePath });
  await Promise.all([
    first.set("198.51.100.101", "asn", { asn: "AS65101" }),
    second.set("198.51.100.102", "asn", { asn: "AS65102" }),
  ]);
  const reader = new ReputationCache({ filePath });
  assert.deepEqual(await reader.get("198.51.100.101", "asn"), { asn: "AS65101" });
  assert.deepEqual(await reader.get("198.51.100.102", "asn"), { asn: "AS65102" });
});
