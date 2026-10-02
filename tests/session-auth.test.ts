import test from "node:test";
import assert from "node:assert/strict";
import {
  createSession,
  readSession,
  revokeSession,
  sessionCookie,
  clearSessionCookie,
  requireDashboardAuth,
  SESSION_COOKIE_NAME,
} from "../src/server/session-auth.js";
import type { IncomingMessage } from "node:http";

test("session auth lifecycle: create, read, revoke, and clear", () => {
  const session = createSession(1000);
  assert.ok(session.token);
  assert.equal(session.token.length >= 32, true);
  assert.equal(session.expiresAt, 1000 + 24 * 60 * 60 * 1000);

  // Read valid session
  const cookieHeader = `${SESSION_COOKIE_NAME}=${session.token}`;
  assert.equal(readSession(cookieHeader, 2000), true);

  // Expired session
  const expiredTime = session.expiresAt + 1;
  assert.equal(readSession(cookieHeader, expiredTime), false);

  // Malformed or empty cookie
  assert.equal(readSession(undefined, 2000), false);
  assert.equal(readSession("", 2000), false);
  assert.equal(readSession("foo=bar", 2000), false);
  assert.equal(readSession(`${SESSION_COOKIE_NAME}=nonexistent-token`, 2000), false);

  // Revoke session
  revokeSession(cookieHeader);
  assert.equal(readSession(cookieHeader, 2000), false);
});

test("session cookie formatting and attributes", () => {
  const cookieStr = sessionCookie("test-token-12345", false);
  assert.ok(cookieStr.includes(`${SESSION_COOKIE_NAME}=test-token-12345`));
  assert.ok(cookieStr.includes("HttpOnly"));
  assert.ok(cookieStr.includes("Path=/"));
  assert.ok(cookieStr.includes("SameSite=Lax"));
  assert.equal(cookieStr.includes("Secure"), false);

  const secureCookieStr = sessionCookie("test-token-12345", true);
  assert.ok(secureCookieStr.includes("Secure"));

  const cleared = clearSessionCookie();
  assert.ok(cleared.includes(`${SESSION_COOKIE_NAME}=;`));
  assert.ok(cleared.includes("Max-Age=0"));
});

test("requireDashboardAuth extracts and verifies request session or valid header auth", () => {
  const session = createSession(1000);

  // Valid session cookie
  const validReq = {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
    },
  } as unknown as IncomingMessage;
  assert.deepEqual(requireDashboardAuth(validReq, 2000), { authenticated: true });

  // Missing auth
  const unauthReq = {
    headers: {},
  } as unknown as IncomingMessage;
  assert.deepEqual(requireDashboardAuth(unauthReq, 2000), { authenticated: false });
});
