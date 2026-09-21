import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const settingsFile = path.join(root, "data", "settings.json");

export interface AppSettings {
  controlPassword: string;
  nineRouterUrl: string;
  nineRouterPassword: string;
  nineRouterApiKey: string;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
}

export interface AppSettingsPublic {
  nineRouterUrl: string;
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
}

export interface SettingsMeta {
  restartRequired: string[];
  source: "settings" | "env";
}

export interface SettingsUpdatePatch {
  controlPassword?: string;
  currentPassword?: string;
  nineRouterUrl?: string;
  nineRouterPassword?: string;
  nineRouterApiKey?: string;
  activePoolLimit?: number;
  nineRouterSyncMinutes?: number;
  checkConcurrency?: number;
  checkTimeoutMs?: number;
  proxyTtlMinutes?: number;
}

type ChangeListener = (settings: AppSettings, changed: string[]) => void;

let settings: AppSettings;
const listeners: ChangeListener[] = [];

function envString(key: string, fallback = ""): string {
  return (process.env[key] ?? fallback).trim();
}

function envNumber(key: string, fallback: number): number {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function defaultsFromEnv(): AppSettings {
  return {
    controlPassword: envString("CONTROL_PASSWORD"),
    nineRouterUrl: envString("NINEROUTER_URL", "https://9router.minhmice.com").replace(/\/$/, ""),
    nineRouterPassword: envString("NINEROUTER_PASSWORD") || envString("9ROUTER_PASSWORD"),
    nineRouterApiKey: envString("NINEROUTER_API_KEY") || envString("9ROUTER_API_KEY"),
    activePoolLimit: envNumber("ACTIVE_POOL_LIMIT", 50),
    nineRouterSyncMinutes: envNumber("NINEROUTER_SYNC_MINUTES", 60),
    checkConcurrency: envNumber("CHECK_CONCURRENCY", 10),
    checkTimeoutMs: envNumber("CHECK_TIMEOUT_MS", 6000),
    proxyTtlMinutes: envNumber("PROXY_TTL_MINUTES", 15),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function validateUrl(url: string) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL must use http or https");
  } catch {
    throw new Error("Invalid 9Router URL");
  }
}

function normalize(settingsValue: AppSettings): AppSettings {
  return {
    controlPassword: settingsValue.controlPassword,
    nineRouterUrl: settingsValue.nineRouterUrl.replace(/\/$/, ""),
    nineRouterPassword: settingsValue.nineRouterPassword,
    nineRouterApiKey: settingsValue.nineRouterApiKey,
    activePoolLimit: clamp(Math.round(settingsValue.activePoolLimit), 1, 200),
    nineRouterSyncMinutes: clamp(Math.round(settingsValue.nineRouterSyncMinutes), 1, 1440),
    checkConcurrency: clamp(Math.round(settingsValue.checkConcurrency), 1, 50),
    checkTimeoutMs: clamp(Math.round(settingsValue.checkTimeoutMs), 2000, 30000),
    proxyTtlMinutes: clamp(Math.round(settingsValue.proxyTtlMinutes), 1, 1440),
  };
}

function syncProcessEnv(next: AppSettings) {
  process.env.CONTROL_PASSWORD = next.controlPassword;
  process.env.NINEROUTER_URL = next.nineRouterUrl;
  process.env.NINEROUTER_PASSWORD = next.nineRouterPassword;
  process.env.NINEROUTER_API_KEY = next.nineRouterApiKey;
  process.env.ACTIVE_POOL_LIMIT = String(next.activePoolLimit);
  process.env.NINEROUTER_SYNC_MINUTES = String(next.nineRouterSyncMinutes);
  process.env.CHECK_CONCURRENCY = String(next.checkConcurrency);
  process.env.CHECK_TIMEOUT_MS = String(next.checkTimeoutMs);
  process.env.PROXY_TTL_MINUTES = String(next.proxyTtlMinutes);
}

function writeSettingsFile(next: AppSettings) {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const temp = `${settingsFile}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, settingsFile);
}

function loadFromDisk(): AppSettings | null {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as Partial<AppSettings>;
    return normalize({ ...defaultsFromEnv(), ...raw });
  } catch {
    return null;
  }
}

export function initAppConfig() {
  const fromDisk = loadFromDisk();
  if (fromDisk) {
    settings = fromDisk;
  } else {
    settings = normalize(defaultsFromEnv());
    if (!settings.controlPassword) {
      throw new Error("CONTROL_PASSWORD is required in .env or data/settings.json on first run.");
    }
    writeSettingsFile(settings);
  }
  syncProcessEnv(settings);
}

export function onSettingsChange(listener: ChangeListener) {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

export function getSettingsSecrets(): AppSettings {
  return { ...settings };
}

export function getSettingsPublic(): { settings: AppSettingsPublic; meta: SettingsMeta } {
  return {
    settings: {
      nineRouterUrl: settings.nineRouterUrl,
      controlPasswordSet: Boolean(settings.controlPassword),
      nineRouterPasswordSet: Boolean(settings.nineRouterPassword),
      nineRouterApiKeySet: Boolean(settings.nineRouterApiKey),
      activePoolLimit: settings.activePoolLimit,
      nineRouterSyncMinutes: settings.nineRouterSyncMinutes,
      checkConcurrency: settings.checkConcurrency,
      checkTimeoutMs: settings.checkTimeoutMs,
      proxyTtlMinutes: settings.proxyTtlMinutes,
    },
    meta: {
      restartRequired: [],
      source: fs.existsSync(settingsFile) ? "settings" : "env",
    },
  };
}

export function verifyControlPassword(candidate: string): boolean {
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(settings.controlPassword);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function updateSettings(patch: SettingsUpdatePatch) {
  const next = { ...settings };
  const changed: string[] = [];

  if (patch.controlPassword !== undefined) {
    if (!patch.currentPassword || !verifyControlPassword(patch.currentPassword)) {
      throw new Error("Current control password is incorrect");
    }
    if (!patch.controlPassword.trim()) throw new Error("New control password cannot be empty");
    next.controlPassword = patch.controlPassword;
    changed.push("controlPassword");
  }

  if (patch.nineRouterUrl !== undefined) {
    validateUrl(patch.nineRouterUrl);
    next.nineRouterUrl = patch.nineRouterUrl;
    changed.push("nineRouterUrl");
  }

  if (patch.nineRouterPassword !== undefined && patch.nineRouterPassword.trim()) {
    next.nineRouterPassword = patch.nineRouterPassword;
    changed.push("nineRouterPassword");
  }

  if (patch.nineRouterApiKey !== undefined) {
    next.nineRouterApiKey = patch.nineRouterApiKey.trim();
    changed.push("nineRouterApiKey");
  }

  if (patch.activePoolLimit !== undefined) {
    next.activePoolLimit = patch.activePoolLimit;
    changed.push("activePoolLimit");
  }

  if (patch.nineRouterSyncMinutes !== undefined) {
    next.nineRouterSyncMinutes = patch.nineRouterSyncMinutes;
    changed.push("nineRouterSyncMinutes");
  }

  if (patch.checkConcurrency !== undefined) {
    next.checkConcurrency = patch.checkConcurrency;
    changed.push("checkConcurrency");
  }

  if (patch.checkTimeoutMs !== undefined) {
    next.checkTimeoutMs = patch.checkTimeoutMs;
    changed.push("checkTimeoutMs");
  }

  if (patch.proxyTtlMinutes !== undefined) {
    next.proxyTtlMinutes = patch.proxyTtlMinutes;
    changed.push("proxyTtlMinutes");
  }


  if (!changed.length) return getSettingsPublic();

  settings = normalize(next);
  writeSettingsFile(settings);
  syncProcessEnv(settings);
  for (const listener of listeners) listener(settings, changed);
  return getSettingsPublic();
}

initAppConfig();
