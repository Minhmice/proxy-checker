import { http, HttpResponse, type RequestHandler } from "msw";
import {
  mockHealth,
  mockLoginSuccess,
  mockNineRouterStatus,
  mockProxiesList,
  mockSessionAuthenticated,
  mockSettings,
} from "./fixtures";

export function createHandlers(origin = "*"): RequestHandler[] {
  const prefix = origin === "*" ? "*/api" : `${origin}/api`;

  return [
    http.get(`${prefix}/health`, () => {
      return HttpResponse.json(mockHealth);
    }),

    http.get(`${prefix}/auth/session`, () => {
      return HttpResponse.json(mockSessionAuthenticated);
    }),

    http.post(`${prefix}/auth/login`, async ({ request }) => {
      let body: Record<string, unknown> = {};
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {}
      if (body.password === "wrong-password") {
        return HttpResponse.json({ error: "Invalid control password" }, { status: 401 });
      }
      return HttpResponse.json(mockLoginSuccess);
    }),

    http.post(`${prefix}/auth/logout`, () => {
      return HttpResponse.json({ authenticated: false });
    }),

    http.get(`${prefix}/ninerouter/status`, () => {
      return HttpResponse.json(mockNineRouterStatus);
    }),

    http.get(`${prefix}/settings`, () => {
      return HttpResponse.json(mockSettings);
    }),

    http.get(`${prefix}/intelligence/proxies`, () => {
      return HttpResponse.json(mockProxiesList);
    }),

    http.get(`${prefix}/proxies/unified`, () => {
      return HttpResponse.json({
        items: mockProxiesList.items,
        counts: { all: 1, working: 1, regressed: 0, dead: 0 },
        total: 1,
        page: 1,
        pageSize: 50,
      });
    }),
  ];
}

export const handlers: RequestHandler[] = createHandlers();
