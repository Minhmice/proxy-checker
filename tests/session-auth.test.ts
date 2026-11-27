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

  const cookieHeader = `${SESSION_COOKIE_NAME}=${session.token}`;
  assert.equal(readSession(cookieHeader, 2000), true);

  const expiredTime = session.expiresAt + 1;
  assert.equal(readSession(cookieHeader, expiredTime), false);

  assert.equal(readSession(undefined, 2000), false);
  assert.equal(readSession("", 2000), false);
  assert.equal(readSession("foo=bar", 2000), false);
  assert.equal(readSession(`${SESSION_COOKIE_NAME}=nonexistent-token`, 2000), false);

  revokeSession(cookieHeader);
  assert.equal(readSession(cookieHeader, 2000), false);
});

test("session cookies reject malformed or encoded tokens without revoking valid sessions", () => {
  const session = createSession(1000);
  const valid = `${SESSION_COOKIE_NAME}=${session.token}`;
  const encoded = `${SESSION_COOKIE_NAME}=%${session.token.charCodeAt(0).toString(16)}${session.token.slice(1)}`;
  for (const value of [
    "%",
    "%GG",
    encoded.slice(SESSION_COOKIE_NAME.length + 1),
    session.token.toUpperCase(),
    session.token + "0",
  ]) {
    const cookie = `${SESSION_COOKIE_NAME}=${value}`;
    assert.equal(readSession(cookie, 2000), false);
    assert.doesNotThrow(() => revokeSession(cookie));
    assert.deepEqual(requireDashboardAuth({ headers: { cookie } } as IncomingMessage, 2000), {
      authenticated: false,
    });
    assert.equal(readSession(valid, 2000), true);
  }
  revokeSession(valid);
  assert.equal(readSession(valid, 2000), false);
});

test("malformed legacy cookie fails closed without throwing", () => {
  const request = { headers: { cookie: "minhmiceproxy-auth=%" } } as IncomingMessage;
  assert.deepEqual(requireDashboardAuth(request, 2000), { authenticated: false });
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

  const validReq = {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${session.token}`,
    },
  } as unknown as IncomingMessage;
  assert.deepEqual(requireDashboardAuth(validReq, 2000), { authenticated: true });

  const unauthReq = {
    headers: {},
  } as unknown as IncomingMessage;
  assert.deepEqual(requireDashboardAuth(unauthReq, 2000), { authenticated: false });
});
