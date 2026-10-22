import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiApp } from '../src/server/api/app.js';
import type { ApiDependencies } from '../src/server/api/types.js';
import { SESSION_COOKIE_NAME } from '../src/server/session-auth.js';

function createMockDeps(): ApiDependencies {
  return {
    verifyControlPassword: (candidate) => candidate === 'test-control-pass-123',
    proxyIntelligenceRepo:
      {} as unknown as ApiDependencies['proxyIntelligenceRepo'],
    fleetRepo: {} as unknown as ApiDependencies['fleetRepo'],
    poolRanker: {} as unknown as ApiDependencies['poolRanker'],
    antigravityRotator: {} as unknown as ApiDependencies['antigravityRotator'],
    unifiedSyncCoordinator:
      {} as unknown as ApiDependencies['unifiedSyncCoordinator'],
    fleetWireguard: () => null,
    handleFleetRuntimeApi: async () => false,
    handleFleetApi: async () => false,
    handleProxyCheck: async () => false,
    router: {} as unknown as ApiDependencies['router'],
    settings: {} as unknown as ApiDependencies['settings'],
    legacyHandlers: {
      handleNineRouter: async () => {},
      handleAntigravity: async () => {},
      handleSettings: async (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ settings: { autoSync: true } }));
      },
      handleIntelligence: async () => {},
      handleProxiesUnified: async () => {},
    },
  };
}

test('hono contract: health check returns ok: true', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request('/api/health');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ok: true });
});

test('hono contract: session endpoint returns unauthenticated by default', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request('/api/auth/session');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { authenticated: false });
});

test('hono contract: login rejects invalid password with 401', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { error: 'Invalid control password' });
});

test('hono contract: login succeeds with valid password and issues session cookie', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-control-pass-123' }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    authenticated: boolean;
    expiresAt: number;
  };
  assert.equal(data.authenticated, true);
  assert.equal(typeof data.expiresAt, 'number');

  const setCookie = res.headers.get('Set-Cookie');
  assert.ok(setCookie);
  assert.ok(setCookie.includes(SESSION_COOKIE_NAME));

  // Extract session token and verify authenticated session
  const tokenMatch = setCookie.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`),
  );
  assert.ok(tokenMatch);
  const cookieValue = `${SESSION_COOKIE_NAME}=${tokenMatch[1]}`;

  const sessionRes = await app.request('/api/auth/session', {
    headers: { Cookie: cookieValue },
  });
  assert.equal(sessionRes.status, 200);
  const sessionData = await sessionRes.json();
  assert.deepEqual(sessionData, { authenticated: true });

  // Logout clears session
  const logoutRes = await app.request('/api/auth/logout', {
    method: 'POST',
    headers: { Cookie: cookieValue },
  });
  assert.equal(logoutRes.status, 200);
  const logoutData = await logoutRes.json();
  assert.deepEqual(logoutData, { authenticated: false });
});

test('hono contract: protected routes reject unauthenticated requests with 401', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request('/api/settings');
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { error: 'Unauthorized' });
});

test('hono contract: unknown api route returns 404 not found', async () => {
  const app = createApiApp(createMockDeps());
  const res = await app.request(
    '/api/non-existent-route?password=test-control-pass-123',
  );
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.deepEqual(data, { error: 'not found' });
});

test('hono contract: login rejects payload exceeding 10 KB with 413', async () => {
  const app = createApiApp(createMockDeps());
  const oversizedPassword = 'a'.repeat(11_000);
  const body = JSON.stringify({ password: oversizedPassword });
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.deepEqual(data, { error: 'Payload too large' });
});
