import assert from "node:assert/strict";

const BASE_URL = process.env.PROXY_URL || "http://127.0.0.1:1300";
const PASSWORD = process.env.CONTROL_PASSWORD || "minh2908";

async function runSmoke() {
  console.log(`[Smoke] Testing Proxy Operations Console at ${BASE_URL}...`);

  // 1. Unauthenticated request to sensitive endpoint must be rejected
  const unauthRes = await fetch(`${BASE_URL}/api/proxies/unified`);
  assert.equal(unauthRes.status, 401, "Direct request without session must be rejected with 401");
  console.log("✓ Handler auth boundary successfully rejects unauthenticated request");

  // 2. Login to obtain session cookie
  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(loginRes.status, 200, "Login must succeed with valid password");
  const cookieHeader = loginRes.headers.get("set-cookie") || "";
  assert.ok(cookieHeader.includes("minhmiceproxy-session"), "Login must issue session cookie");
  const sessionCookie = cookieHeader.split(";")[0];
  console.log("✓ Session authentication login succeeded and issued session cookie");

  const authHeaders = {
    Cookie: sessionCookie,
    "Content-Type": "application/json",
  };

  // 3. Verify session endpoint
  const sessionRes = await fetch(`${BASE_URL}/api/auth/session`, { headers: authHeaders });
  assert.equal(sessionRes.status, 200);
  const sessionBody = await sessionRes.json();
  assert.equal(sessionBody.authenticated, true);
  console.log("✓ Session validation confirmed");

  // 4. Test Unified Proxies with facets & pagination
  const unifiedRes = await fetch(`${BASE_URL}/api/proxies/unified?health=working&pageSize=5`, {
    headers: authHeaders,
  });
  assert.equal(unifiedRes.status, 200);
  const unifiedBody = await unifiedRes.json();
  assert.ok(unifiedBody.pagination, "Response must include pagination");
  assert.ok(unifiedBody.facets, "Response must include facets");
  assert.ok(unifiedBody.meta?.generatedAt, "Response must include server metadata");
  console.log(`✓ Unified proxies query succeeded (${unifiedBody.total} total proxies, ${unifiedBody.items.length} returned)`);

  // 5. Test Import Preview (does not mutate DB)
  const previewRes = await fetch(`${BASE_URL}/api/intelligence/import/preview`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      source: "smoke-test.txt",
      content: "http://1.1.1.1:8080\nsocks5://2.2.2.2:1080\ninvalid-proxy\n",
    }),
  });
  assert.equal(previewRes.status, 200);
  const previewBody = await previewRes.json();
  assert.equal(previewBody.preview.valid, 2);
  assert.equal(previewBody.preview.invalid, 1);
  console.log("✓ Import preview correctly validates proxies without database write");

  // 6. Test Privileged Credential Export Policy
  // Requesting credentials without confirmation MUST be 403 Forbidden
  const unconfirmedExportRes = await fetch(
    `${BASE_URL}/api/settings/proxy-export?includeCredentials=true`,
    { headers: authHeaders }
  );
  assert.equal(unconfirmedExportRes.status, 403, "Credential export without confirmation must be forbidden");
  console.log("✓ Credential export strictly blocked without confirmation");

  // Confirmed credential export succeeds
  const confirmedExportRes = await fetch(
    `${BASE_URL}/api/settings/proxy-export?includeCredentials=true&confirmCredentials=yes`,
    { headers: authHeaders }
  );
  assert.equal(confirmedExportRes.status, 200, "Confirmed credential export must succeed");
  console.log("✓ Confirmed credential export succeeded");

  // 7. Test Jobs listing
  const jobsRes = await fetch(`${BASE_URL}/api/intelligence/jobs`, { headers: authHeaders });
  assert.equal(jobsRes.status, 200);
  const jobsBody = await jobsRes.json();
  assert.ok(Array.isArray(jobsBody.jobs));
  console.log(`✓ Audit jobs list accessible (${jobsBody.jobs.length} jobs in history)`);

  console.log("\n[Smoke] All API and security checks PASSED cleanly!");
}

runSmoke().catch((err) => {
  console.error("\n[Smoke FAILED]:", err);
  process.exit(1);
});
