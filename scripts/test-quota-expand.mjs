import { chromium } from "playwright";
import path from "path";

const ARTIFACTS_DIR = path.resolve("artifacts/assessment-a");
const BASE_URL = "http://127.0.0.1:1300";

const enrichedAntigravityStatus = {
  lastRunAt: Date.now() - 120000,
  running: false,
  totalAccounts: 4,
  activeCount: 2,
  totalSessionQuotaPercentage: 85,
  maxPossiblePercentage: 200,
  degraded: false,
  error: null,
  groups: [
    { provider: "antigravity", activeCount: 1, totalAccounts: 2 },
    { provider: "codex", activeCount: 1, totalAccounts: 2 }
  ],
  accounts: [
    {
      id: "acc-ag-1",
      email: "primary-ag@example.com",
      name: "Antigravity Active #1",
      provider: "antigravity",
      isActive: true,
      sessionPercentage: 82,
      weeklyPercentage: 91,
      resetAt: new Date(Date.now() + 3600000).toISOString(),
      thresholdPercentage: 8,
      quotaAvailable: true,
      lastCheckedAt: Date.now() - 30000,
    },
    {
      id: "acc-ag-2",
      email: "standby-ag@example.com",
      name: "Antigravity Standby #2",
      provider: "antigravity",
      isActive: false,
      sessionPercentage: 98,
      weeklyPercentage: 98,
      resetAt: null,
      thresholdPercentage: null,
      quotaAvailable: true,
      lastCheckedAt: Date.now() - 45000,
    },
    {
      id: "acc-cdx-1",
      email: "primary-codex@example.com",
      name: "Codex Active #1",
      provider: "codex",
      isActive: true,
      sessionPercentage: 74,
      weeklyPercentage: 0,
      resetAt: new Date(Date.now() + 7200000).toISOString(),
      thresholdPercentage: 7,
      quotaAvailable: true,
      lastCheckedAt: Date.now() - 30000,
    },
    {
      id: "acc-cdx-2",
      email: "standby-codex@example.com",
      name: "Codex Standby #2",
      provider: "codex",
      isActive: false,
      sessionPercentage: 100,
      weeklyPercentage: 0,
      resetAt: null,
      thresholdPercentage: null,
      quotaAvailable: true,
      lastCheckedAt: Date.now() - 45000,
    }
  ]
};

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    baseURL: BASE_URL,
  });
  const page = await context.newPage();

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/auth/session") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: true }) });
    }
    if (pathname === "/api/antigravity/status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(enrichedAntigravityStatus) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript(() => {
    localStorage.setItem("minhmiceproxy-password", "valid-test-password");
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);

  // Find the quota widget trigger in the sidebar footer
  const quotaWidget = page.locator('button:has-text("Account quota")');
  if (await quotaWidget.count() > 0) {
    console.log("Found quota widget, clicking to expand...");
    await quotaWidget.click();
    await page.waitForTimeout(600);
    const shotPath = path.join(ARTIFACTS_DIR, "02-dashboard-sidebar-quota-expanded.png");
    await page.screenshot({ path: shotPath });
    console.log("Saved expanded quota widget shot:", shotPath);
  } else {
    console.log("Quota widget button not found!");
  }

  await browser.close();
}

main().catch(console.error);
