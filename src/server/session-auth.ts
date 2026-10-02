import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import { verifyControlPassword } from "./app-config.js";

export const SESSION_COOKIE_NAME = "minhmiceproxy-session";
export const LEGACY_COOKIE_NAME = "minhmiceproxy-auth";
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface DashboardSession {
  token: string;
  expiresAt: number;
}

const activeSessions = new Map<string, number>();

function cleanupExpired(now: number) {
  for (const [token, expiresAt] of activeSessions.entries()) {
    if (expiresAt <= now) {
      activeSessions.delete(token);
    }
  }
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split("; ").find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return decodeURIComponent(match.slice(name.length + 1));
}

export function createSession(now = Date.now()): DashboardSession {
  cleanupExpired(now);
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = now + SESSION_TTL_MS;
  activeSessions.set(token, expiresAt);
  return { token, expiresAt };
}

export function readSession(cookieHeader: string | undefined, now = Date.now()): boolean {
  const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!token) return false;
  const expiresAt = activeSessions.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    activeSessions.delete(token);
    return false;
  }
  return true;
}

export function revokeSession(cookieHeader: string | undefined): void {
  const token = parseCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (token) {
    activeSessions.delete(token);
  }
}

export function sessionCookie(token: string, secure = false): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

export function requireDashboardAuth(
  request: IncomingMessage,
  now = Date.now()
): { authenticated: boolean } {
  // 1. Primary: Session cookie
  if (readSession(request.headers.cookie, now)) {
    return { authenticated: true };
  }

  // 2. Compatibility: Basic admin:<password>
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon >= 0 && decoded.slice(0, colon) === "admin") {
        const pass = decoded.slice(colon + 1);
        if (verifyControlPassword(pass)) {
          return { authenticated: true };
        }
      }
    } catch {}
  }

  // 3. Compatibility: Bearer <password>
  if (authHeader?.startsWith("Bearer ")) {
    const pass = authHeader.slice(7).trim();
    if (verifyControlPassword(pass)) {
      return { authenticated: true };
    }
  }

  // 4. Compatibility: Legacy cookie
  const legacyPass = parseCookie(request.headers.cookie, LEGACY_COOKIE_NAME);
  if (legacyPass && verifyControlPassword(legacyPass)) {
    return { authenticated: true };
  }

  return { authenticated: false };
}
