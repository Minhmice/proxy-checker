import { validateFleetWireGuardSettings, type FleetWireGuardSettings } from "../proxyfleet/wireguard.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function getSettingsFilePath(): string {
  return process.env.APP_CONFIG_PATH || path.join(root, "data", "settings.json");
}

export interface AppSettings {
  controlPassword: string;
  nineRouterUrl: string;
  nineRouterPassword: string;
  nineRouterApiKey: string;
  nineRouterAutoSync: boolean;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
  antigravityRotatorEnabled: boolean;
  antigravityActiveLimit: number;
  antigravityRotateMinutes: number;
  antigravitySessionThreshold: number;
  fleetWireguard?: FleetWireGuardSettings | null;
}

export interface AppSettingsPublic {
  nineRouterUrl: string;
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  nineRouterAutoSync: boolean;
  activePoolLimit: number;
  nineRouterSyncMinutes: number;
  checkConcurrency: number;
  checkTimeoutMs: number;
  proxyTtlMinutes: number;
  antigravityRotatorEnabled: boolean;
  antigravityActiveLimit: number;
  antigravityRotateMinutes: number;
  antigravitySessionThreshold: number;
  fleetWireguard?: FleetWireGuardSettings | null;
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
  nineRouterAutoSync?: boolean;
  activePoolLimit?: number;
  nineRouterSyncMinutes?: number;
  checkConcurrency?: number;
  checkTimeoutMs?: number;
  proxyTtlMinutes?: number;
  antigravityRotatorEnabled?: boolean;
  antigravityActiveLimit?: number;
  antigravityRotateMinutes?: number;
  antigravitySessionThreshold?: number;
  fleetWireguard?: FleetWireGuardSettings | null;
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
function envBoolean(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}


function defaultsFromEnv(): AppSettings {
  return {
    controlPassword: envString("CONTROL_PASSWORD"),
    nineRouterUrl: envString("NINEROUTER_URL", "https://9router.minhmice.com").replace(/\/$/, ""),
    nineRouterPassword: envString("NINEROUTER_PASSWORD") || envString("9ROUTER_PASSWORD"),
    nineRouterApiKey: envString("NINEROUTER_API_KEY") || envString("9ROUTER_API_KEY"),
    nineRouterAutoSync: envBoolean("NINEROUTER_AUTO_SYNC", true),
    activePoolLimit: envNumber("ACTIVE_POOL_LIMIT", 20),
    nineRouterSyncMinutes: envNumber("NINEROUTER_SYNC_MINUTES", 360),
    checkConcurrency: envNumber("CHECK_CONCURRENCY", 10),
    checkTimeoutMs: envNumber("CHECK_TIMEOUT_MS", 6000),
    proxyTtlMinutes: envNumber("PROXY_TTL_MINUTES", 15),
    antigravityRotatorEnabled: envBoolean("ANTIGRAVITY_ROTATOR_ENABLED", true),
    antigravityActiveLimit: envNumber("ANTIGRAVITY_ACTIVE_LIMIT", 3),
    antigravityRotateMinutes: envNumber("ANTIGRAVITY_ROTATE_MINUTES", 10),
    antigravitySessionThreshold: envNumber("ANTIGRAVITY_SESSION_THRESHOLD", 20),
    fleetWireguard: null,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeNineRouterUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (!url) throw new Error("9Router URL cannot be empty");
  if (/^[a-z0-9+.-]+:\/\//i.test(url)) {
    if (!/^https?:\/\//i.test(url)) {
      throw new Error("URL must use http or https");
    }
  } else {
    url = `http://${url}`;
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL must use http or https");
    return url.replace(/\/+$/, "");
  } catch (err) {
    if ((err as Error).message.includes("http")) throw err;
    throw new Error("Invalid 9Router URL", { cause: err });
  }
}

function normalize(settingsValue: AppSettings): AppSettings {
  return {
    controlPassword: settingsValue.controlPassword,
    nineRouterUrl: normalizeNineRouterUrl(settingsValue.nineRouterUrl || "https://9router.minhmice.com"),
    nineRouterPassword: settingsValue.nineRouterPassword,
    nineRouterApiKey: settingsValue.nineRouterApiKey,
    nineRouterAutoSync: settingsValue.nineRouterAutoSync !== false,
    activePoolLimit: clamp(Math.round(settingsValue.activePoolLimit), 1, 200),
    nineRouterSyncMinutes: clamp(Math.round(settingsValue.nineRouterSyncMinutes), 1, 1440),
    checkConcurrency: clamp(Math.round(settingsValue.checkConcurrency), 1, 50),
    checkTimeoutMs: clamp(Math.round(settingsValue.checkTimeoutMs), 2000, 30000),
    proxyTtlMinutes: clamp(Math.round(settingsValue.proxyTtlMinutes), 1, 1440),
    antigravityRotatorEnabled: settingsValue.antigravityRotatorEnabled !== false,
    antigravityActiveLimit: clamp(Math.round(settingsValue.antigravityActiveLimit ?? 3), 1, 10),
    antigravityRotateMinutes: clamp(Math.round(settingsValue.antigravityRotateMinutes ?? 10), 1, 60),
    antigravitySessionThreshold: clamp(Math.round(settingsValue.antigravitySessionThreshold ?? 20), 5, 50),
    fleetWireguard: settingsValue.fleetWireguard == null ? null : validateFleetWireGuardSettings(settingsValue.fleetWireguard),
  };
}

function syncProcessEnv(next: AppSettings) {
  process.env.CONTROL_PASSWORD = next.controlPassword;
  process.env.NINEROUTER_URL = next.nineRouterUrl;
  process.env.NINEROUTER_PASSWORD = next.nineRouterPassword;
  process.env.NINEROUTER_API_KEY = next.nineRouterApiKey;
  process.env.NINEROUTER_AUTO_SYNC = String(next.nineRouterAutoSync);
  process.env.ACTIVE_POOL_LIMIT = String(next.activePoolLimit);
  process.env.NINEROUTER_SYNC_MINUTES = String(next.nineRouterSyncMinutes);
  process.env.CHECK_CONCURRENCY = String(next.checkConcurrency);
  process.env.CHECK_TIMEOUT_MS = String(next.checkTimeoutMs);
  process.env.PROXY_TTL_MINUTES = String(next.proxyTtlMinutes);
  process.env.ANTIGRAVITY_ROTATOR_ENABLED = String(next.antigravityRotatorEnabled);
  process.env.ANTIGRAVITY_ACTIVE_LIMIT = String(next.antigravityActiveLimit);
  process.env.ANTIGRAVITY_ROTATE_MINUTES = String(next.antigravityRotateMinutes);
  process.env.ANTIGRAVITY_SESSION_THRESHOLD = String(next.antigravitySessionThreshold);
}

function writeSettingsFile(next: AppSettings) {
  const file = getSettingsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, file);
}

function loadFromDisk(): AppSettings | null {
  try {
    const file = getSettingsFilePath();
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<AppSettings>;
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
      nineRouterAutoSync: settings.nineRouterAutoSync,
      activePoolLimit: settings.activePoolLimit,
      nineRouterSyncMinutes: settings.nineRouterSyncMinutes,
      checkConcurrency: settings.checkConcurrency,
      checkTimeoutMs: settings.checkTimeoutMs,
      proxyTtlMinutes: settings.proxyTtlMinutes,
      antigravityRotatorEnabled: settings.antigravityRotatorEnabled,
      antigravityActiveLimit: settings.antigravityActiveLimit,
      antigravityRotateMinutes: settings.antigravityRotateMinutes,
      antigravitySessionThreshold: settings.antigravitySessionThreshold,
      fleetWireguard: settings.fleetWireguard ?? null,
    },
    meta: {
      restartRequired: [],
      source: fs.existsSync(getSettingsFilePath()) ? "settings" : "env",
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
  if (patch.fleetWireguard !== undefined) {
    next.fleetWireguard = patch.fleetWireguard === null ? null : validateFleetWireGuardSettings(patch.fleetWireguard);
    changed.push("fleetWireguard");
  }

  if (patch.controlPassword !== undefined) {
    if (!patch.currentPassword || !verifyControlPassword(patch.currentPassword)) {
      throw new Error("Current control password is incorrect");
    }
    if (!patch.controlPassword.trim()) throw new Error("New control password cannot be empty");
    next.controlPassword = patch.controlPassword;
    changed.push("controlPassword");
  }

  if (patch.nineRouterUrl !== undefined) {
    const validUrl = normalizeNineRouterUrl(patch.nineRouterUrl);
    next.nineRouterUrl = validUrl;
    changed.push("nineRouterUrl");
  }

  if (patch.nineRouterPassword !== undefined) {
    next.nineRouterPassword = patch.nineRouterPassword.trim();
    changed.push("nineRouterPassword");
  }

  if (patch.nineRouterApiKey !== undefined) {
    next.nineRouterApiKey = patch.nineRouterApiKey.trim();
    changed.push("nineRouterApiKey");
  }

  if (patch.nineRouterAutoSync !== undefined) {
    next.nineRouterAutoSync = Boolean(patch.nineRouterAutoSync);
    changed.push("nineRouterAutoSync");
  }

  if (patch.activePoolLimit !== undefined) {
    next.activePoolLimit = patch.activePoolLimit;
    changed.push("activePoolLimit");
  }

  if (patch.nineRouterSyncMinutes !== undefined) {
    next.nineRouterSyncMinutes = clamp(Math.round(patch.nineRouterSyncMinutes), 1, 1440);
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

  if (patch.antigravityRotatorEnabled !== undefined) {
    next.antigravityRotatorEnabled = Boolean(patch.antigravityRotatorEnabled);
    changed.push("antigravityRotatorEnabled");
  }

  if (patch.antigravityActiveLimit !== undefined) {
    next.antigravityActiveLimit = patch.antigravityActiveLimit;
    changed.push("antigravityActiveLimit");
  }

  if (patch.antigravityRotateMinutes !== undefined) {
    next.antigravityRotateMinutes = patch.antigravityRotateMinutes;
    changed.push("antigravityRotateMinutes");
  }

  if (patch.antigravitySessionThreshold !== undefined) {
    next.antigravitySessionThreshold = patch.antigravitySessionThreshold;
    changed.push("antigravitySessionThreshold");
  }

  if (!changed.length) return getSettingsPublic();

  settings = normalize(next);
  writeSettingsFile(settings);
  syncProcessEnv(settings);
  for (const listener of listeners) listener(settings, changed);
  return getSettingsPublic();
}

initAppConfig();
