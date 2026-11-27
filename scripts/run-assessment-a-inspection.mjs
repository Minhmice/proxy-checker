import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const ARTIFACTS_DIR = path.resolve("artifacts/assessment-a");
fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

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

const mockTokenUsageData = {
  period: "today",
  totalRequests: 14820,
  totalPromptTokens: 8420000,
  totalCompletionTokens: 2150000,
  totalCachedTokens: 3200000,
  totalTokens: 10570000,
  totalCost: 14.82,
  byModel: {
    "claude-3-5-sonnet": {
      requests: 4200,
      promptTokens: 3100000,
      completionTokens: 950000,
      cachedTokens: 1200000,
      cost: 8.50,
      provider: "anthropic"
    },
    "gpt-4o": {
      requests: 5600,
      promptTokens: 2800000,
      completionTokens: 720000,
      cachedTokens: 1100000,
      cost: 4.20,
      provider: "openai"
    },
    "gemini-1.5-pro": {
      requests: 5020,
      promptTokens: 2520000,
      completionTokens: 480000,
      cachedTokens: 900000,
      cost: 2.12,
      provider: "google"
    }
  },
  nodes: [
    {
      id: "server-lan",
      name: "Controller Node",
      url: "http://127.0.0.1:20128",
      online: true,
      totalTokens: 10570000,
      requests: 14820
    }
  ]
};

const mockSettingsData = {
  settings: {
    nineRouterUrl: "http://127.0.0.1:20128",
    controlPasswordSet: true,
    nineRouterPasswordSet: true,
    nineRouterApiKeySet: false,
    antigravityRotatorEnabled: true,
    antigravityRotateMinutes: 60,
  },
  meta: {
    restartRequired: [],
    source: "settings",
  },
};

const mockBackupData = {
  ok: true,
  status: {
    lastBackupTime: Date.now() - 3600000,
    lastCommitSha: "c0ffee1",
    lastCommitMessage: "chore: automated backup snapshot",
    backupFileCount: 42,
    hasUncommittedChanges: false
  }
};

async function setupInterception(page, authenticated = true) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    const method = route.request().method();

    if (pathname === "/api/health") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    }

    if (pathname === "/api/auth/session") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated })
      });
    }

    if (pathname === "/api/auth/login") {
      let body = {};
      try { body = route.request().postDataJSON(); } catch {}
      if (body.password === "wrong-password") {
        return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Invalid control password" }) });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: true, expiresAt: Date.now() + 86400000 })
      });
    }

    if (pathname === "/api/auth/logout") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ authenticated: false }) });
    }

    if (pathname === "/api/settings") {
      if (method === "PUT") {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSettingsData) });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockSettingsData) });
    }

    if (pathname === "/api/settings/test-ninerouter") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, latencyMs: 38, activeConnections: 2 }) });
    }

    if (pathname === "/api/antigravity/status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(enrichedAntigravityStatus) });
    }

    if (pathname === "/api/antigravity/refresh" || pathname === "/api/antigravity/rotate") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ started: true, ok: true, snapshot: enrichedAntigravityStatus }) });
    }

    if (pathname === "/api/backup/status") {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockBackupData) });
    }

    if (pathname.startsWith("/api/ninerouter/stats") || pathname.includes("/stats")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(mockTokenUsageData) });
    }

    if (pathname === "/api/ninerouter/status") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "connected",
          accounts: enrichedAntigravityStatus.accounts,
          accountMetrics: {
            activeAccounts: 2,
            totalAccounts: 4,
            totalSessionQuotaRemaining: 156,
            maxPossibleQuota: 200,
          }
        })
      });
    }

    // Default catch-all
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
}

async function measurePage(page) {
  return await page.evaluate(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const hasHorizontalOverflow = docEl.scrollWidth > docEl.clientWidth || body.scrollWidth > body.clientWidth;

    // Small interactive targets (< 44x44 px)
    const interactives = Array.from(document.querySelectorAll('button, a, input, select, [role="button"], [role="tab"]'));
    const smallTargets = [];
    for (const el of interactives) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        if (rect.width < 44 || rect.height < 44) {
          const text = (el.innerText || el.getAttribute("aria-label") || el.tagName).trim().slice(0, 30);
          smallTargets.push({
            tag: el.tagName,
            text,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            class: el.className.slice(0, 50)
          });
        }
      }
    }

    return {
      title: document.title,
      hasHorizontalOverflow,
      scrollWidth: Math.max(docEl.scrollWidth, body.scrollWidth),
      clientWidth: docEl.clientWidth,
      totalInteractives: interactives.length,
      smallTargetsCount: smallTargets.length,
      sampleSmallTargets: smallTargets.slice(0, 10),
    };
  });
}

async function main() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const results = {};

  const viewports = [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844, isMobile: true, hasTouch: true }
  ];

  try {
    // 1. /auth route inspection
    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        isMobile: vp.isMobile,
        hasTouch: vp.hasTouch,
        baseURL: BASE_URL,
      });
      const page = await context.newPage();
      const consoleErrors = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      await setupInterception(page, false);

      await page.goto("/auth", { waitUntil: "networkidle" });
      await page.waitForTimeout(1000);

      const shotPath = path.join(ARTIFACTS_DIR, `01-auth-${vp.name}.png`);
      await page.screenshot({ path: shotPath, fullPage: true });

      const metrics = await measurePage(page);
      results[`auth-${vp.name}`] = { metrics, consoleErrors, screenshot: shotPath };

      // Test auth form interaction on desktop
      if (vp.name === "desktop") {
        // Try wrong password
        const passwordInput = page.locator('input[type="password"]');
        if (await passwordInput.count() > 0) {
          await passwordInput.fill("wrong-password");
          await page.locator('button[type="submit"]').click();
          await page.waitForTimeout(600);
          const errShot = path.join(ARTIFACTS_DIR, `01-auth-error-state.png`);
          await page.screenshot({ path: errShot });
          results[`auth-error-state`] = { screenshot: errShot };
        }
      }

      await context.close();
    }

    // Authenticated routes: /, /settings, /help, /help/components
    const authRoutes = [
      { path: "/", id: "dashboard" },
      { path: "/settings", id: "settings" },
      { path: "/help", id: "help" },
      { path: "/help/components", id: "help-components" }
    ];

    for (const route of authRoutes) {
      for (const vp of viewports) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          isMobile: vp.isMobile,
          hasTouch: vp.hasTouch,
          baseURL: BASE_URL,
        });
        const page = await context.newPage();
        const consoleErrors = [];
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        await setupInterception(page, true);

        // Pre-set localStorage authentication
        await page.addInitScript(() => {
          localStorage.setItem("minhmiceproxy-password", "valid-test-password");
          localStorage.setItem("minhmiceproxy-password-date", String(Date.now()));
        });

        await page.goto(route.path, { waitUntil: "networkidle" });
        await page.waitForTimeout(1200);

        const shotPath = path.join(ARTIFACTS_DIR, `0${authRoutes.indexOf(route) + 2}-${route.id}-${vp.name}.png`);
        await page.screenshot({ path: shotPath, fullPage: true });

        const metrics = await measurePage(page);
        results[`${route.id}-${vp.name}`] = { metrics, consoleErrors, screenshot: shotPath };

        // Test route-specific interactions on desktop
        if (vp.name === "desktop") {
          if (route.id === "dashboard") {
            // Click telemetry card to toggle Token <-> Cost
            const telemetryToggle = page.locator('[role="button"][aria-label*="Current metric"]');
            if (await telemetryToggle.count() > 0) {
              await telemetryToggle.click();
              await page.waitForTimeout(500);
              const costShot = path.join(ARTIFACTS_DIR, `02-dashboard-cost-mode.png`);
              await page.screenshot({ path: costShot });
              results[`dashboard-cost-mode`] = { screenshot: costShot };
              // click back
              await telemetryToggle.click();
            }

            // Click period buttons
            const weekBtn = page.locator('button[aria-label="Token usage period"], [role="group"] button:has-text("7D")');
            if (await weekBtn.count() > 0) {
              await weekBtn.click();
              await page.waitForTimeout(400);
            }
          } else if (route.id === "settings") {
            // Click through tabs: Router, Antigravity, Backup, Security
            const tabs = ["router", "antigravity", "backup", "security"];
            for (const t of tabs) {
              const tabTrigger = page.locator(`button[role="tab"][value="${t}"], [role="tab"]:has-text("${t}")`);
              if (await tabTrigger.count() > 0) {
                await tabTrigger.first().click();
                await page.waitForTimeout(400);
                const tabShot = path.join(ARTIFACTS_DIR, `03-settings-tab-${t}.png`);
                await page.screenshot({ path: tabShot, fullPage: true });
                results[`settings-tab-${t}`] = { screenshot: tabShot };
              }
            }
          } else if (route.id === "help-components") {
            // Switch tabs in component showcase
            const tabsTrigger = page.locator('[role="tab"]:has-text("Cult UI")');
            if (await tabsTrigger.count() > 0) {
              await tabsTrigger.click();
              await page.waitForTimeout(400);
              const cultShot = path.join(ARTIFACTS_DIR, `05-help-components-cult.png`);
              await page.screenshot({ path: cultShot, fullPage: true });
              results[`help-components-cult`] = { screenshot: cultShot };
            }
          }
        }

        await context.close();
      }
    }

    fs.writeFileSync(
      path.join(ARTIFACTS_DIR, "inspection-results.json"),
      JSON.stringify(results, null, 2)
    );
    console.log("Inspection successfully completed! Summary:");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error in inspection script:", err);
  process.exit(1);
});
