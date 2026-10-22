import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { startIsolatedServer } from "../helpers/isolated-server.js";

const routes = [
  "/",
  "/proxies",
  "/proxy-endpoints",
  "/nodes",
  "/monitoring",
  "/events",
  "/settings",
  "/wallet",
  "/reseller",
  "/referral",
  "/invoice",
  "/cdk",
  "/scraping",
  "/help",
] as const;

test("dashboard routes have no selected WCAG violations", { timeout: 180_000 }, async (t) => {
  const app = await startIsolatedServer({ mode: "production", mockApi: false });
  t.after(() => app.stop());

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  const context = await browser.newContext({ baseURL: app.baseUrl });
  const login = await context.request.post("/api/auth/login", {
    data: { password: app.password },
  });
  assert.equal(login.status(), 200);
  const loginBody = (await login.json()) as { authenticated: boolean };
  assert.equal(loginBody.authenticated, true);

  for (const route of routes) {
    const page = await context.newPage();
    try {
      const response = await page.goto(route, { waitUntil: "domcontentloaded", timeout: 15_000 });
      assert.equal(response?.status(), 200, `${route} returned non-200 status`);
      await page
        .locator("main")
        .waitFor({ state: "visible", timeout: 10_000 })
        .catch(() => {});
      assert.notEqual(new URL(page.url()).pathname, "/auth", `${route} redirected to /auth`);

      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      if (result.violations.length > 0) {
        console.error(`Axe violations on ${route}:`, JSON.stringify(result.violations, null, 2));
      }
      assert.deepEqual(result.violations, [], `${route} has accessibility violations`);
    } finally {
      await page.close();
    }
  }
});
