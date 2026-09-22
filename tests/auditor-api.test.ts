import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  cancelAuditorJob,
  createAuditorJob,
  deleteAuditorHistory,
  downloadAuditorExport,
  fetchAuditorHistory,
  fetchAuditorJob,
  getAuditorExportUrl,
} from "../src/lib/auditor-api.js";
import type { AuditorJob } from "../src/lib/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordFetch(body: unknown, status = 200) {
  const request = { url: "", init: {} as RequestInit };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    request.url = String(input);
    request.init = init ?? {};
    const resBody = status === 204 ? null : JSON.stringify(body);
    return new Response(resBody, {
      status,
      headers: status === 204 ? {} : { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return request;
}

const fixtureJob: AuditorJob = {
  id: "job-123",
  mode: "single",
  status: "queued",
  sourceName: "Single proxy",
  createdAt: 1000,
  startedAt: null,
  finishedAt: null,
  total: 1,
  checked: 0,
  passCount: 0,
  warnCount: 0,
  failCount: 0,
  unknownCount: 0,
  duplicateCount: 0,
  browserAudit: false,
  attempts: 1,
  timeoutMs: 2000,
  concurrency: 1,
  results: [],
  resultsCapped: false,
  persistenceWarning: "",
  error: "",
};

test("createAuditorJob posts to /api/auditor/jobs with Basic auth", async () => {
  const request = recordFetch({ job: fixtureJob }, 202);
  const result = await createAuditorJob("testpass", {
    mode: "single",
    proxy: "http://example.com:8080",
    options: { attempts: 1, timeoutMs: 2000, concurrency: 1, reputation: false, browser: false },
  });

  assert.equal(request.url, "/api/auditor/jobs");
  assert.equal(request.init.method, "POST");
  const headers = request.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${btoa("admin:testpass")}`);
  assert.equal(result.id, "job-123");
});

test("cancelAuditorJob posts to encoded job route", async () => {
  const request = recordFetch({ job: { ...fixtureJob, status: "cancelled" } }, 200);
  const result = await cancelAuditorJob("testpass", "job/special-123");

  assert.equal(request.url, "/api/auditor/jobs/job%2Fspecial-123/cancel");
  assert.equal(request.init.method, "POST");
  assert.equal(result.status, "cancelled");
});

test("fetchAuditorJob fetches job by id", async () => {
  const request = recordFetch({ job: fixtureJob }, 200);
  const result = await fetchAuditorJob("testpass", "job-123");

  assert.equal(request.url, "/api/auditor/jobs/job-123");
  assert.equal(result.id, "job-123");
});

test("fetchAuditorHistory requests history with limit query", async () => {
  const request = recordFetch({ jobs: [fixtureJob] }, 200);
  const result = await fetchAuditorHistory("testpass", 10);

  assert.equal(request.url, "/api/auditor/history?limit=10");
  assert.equal(result.length, 1);
});

test("deleteAuditorHistory calls DELETE on encoded history route", async () => {
  const request = recordFetch({}, 204);
  await deleteAuditorHistory("testpass", "job-123");

  assert.equal(request.url, "/api/auditor/history/job-123");
  assert.equal(request.init.method, "DELETE");
});

test("getAuditorExportUrl returns properly encoded route", () => {
  const url = getAuditorExportUrl("job/123", "csv");
  assert.equal(url, "/api/auditor/jobs/job%2F123/export?format=csv");
});

test("helpers throw server error message when status is non-ok", async () => {
  recordFetch({ error: "Job already finished" }, 409);
  await assert.rejects(
    cancelAuditorJob("testpass", "job-123"),
    /Job already finished/
  );
});

test("downloadAuditorExport returns blob and extracted filename", async () => {
  globalThis.fetch = (async () => {
    const headers = new Headers({
      "content-type": "text/csv",
      "content-disposition": 'attachment; filename="custom-audit.csv"',
    });
    return new Response("col1,col2\nval1,val2", { status: 200, headers });
  }) as typeof fetch;

  const { blob, filename } = await downloadAuditorExport("testpass", "job-123", "csv");
  assert.equal(filename, "custom-audit.csv");
  assert.equal(blob.type, "text/csv");
  const text = await blob.text();
  assert.equal(text, "col1,col2\nval1,val2");
});
