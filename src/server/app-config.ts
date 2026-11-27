import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomicSync } from "./fs-atomic.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function getSettingsFilePath(): string {
  if (process.env.APP_CONFIG_PATH) return process.env.APP_CONFIG_PATH;
  if (process.env.APP_DATA_DIR) {
    return path.join(path.resolve(process.env.APP_DATA_DIR), "settings.json");
  }
  return path.join(root, "data", "settings.json");
}

export interface AppSettings {
  controlPassword: string;
  nineRouterUrl: string;
  nineRouterPassword: string;
  nineRouterApiKey: string;
  antigravityRotatorEnabled: boolean;
  antigravityRotateMinutes: number;
}

export interface AppSettingsPublic {
  nineRouterUrl: string;
  nineRouterUrls?: string[];
  controlPasswordSet: boolean;
  nineRouterPasswordSet: boolean;
  nineRouterApiKeySet: boolean;
  antigravityRotatorEnabled: boolean;
  antigravityRotateMinutes: number;
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
  antigravityRotatorEnabled?: boolean;
  antigravityRotateMinutes?: number;
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
    antigravityRotatorEnabled: envBoolean("ANTIGRAVITY_ROTATOR_ENABLED", true),
    antigravityRotateMinutes: envNumber("ANTIGRAVITY_ROTATE_MINUTES", 10),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeSingleNineRouterUrl(raw: string): string {
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
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("URL must use http or https");
    return url.replace(/\/+$/, "");
  } catch (err) {
    if ((err as Error).message.includes("http")) throw err;
    throw new Error(`Invalid 9Router URL: ${raw}`, { cause: err });
  }
}

export function parseNineRouterUrls(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const entries: string[] = Array.isArray(raw)
    ? raw.flatMap((item) => (typeof item === "string" ? item.split(/[,\n;]+/) : []))
    : String(raw).split(/[,\n;]+/);

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const url = normalizeSingleNineRouterUrl(trimmed);
    if (!seen.has(url)) {
      seen.add(url);
      normalized.push(url);
    }
  }
  return normalized;
}

export function normalizeNineRouterUrl(raw: string): string {
  const urls = parseNineRouterUrls(raw);
  if (urls.length === 0) throw new Error("9Router URL cannot be empty");
  return urls.join(", ");
}

export function getNineRouterUrls(settingsValue?: AppSettings): string[] {
  const target = settingsValue ?? settings;
  if (!target?.nineRouterUrl) return [];
  return parseNineRouterUrls(target.nineRouterUrl);
}

function normalize(settingsValue: AppSettings): AppSettings {
  return {
    controlPassword: settingsValue.controlPassword,
    nineRouterUrl: normalizeNineRouterUrl(
      settingsValue.nineRouterUrl || "https://9router.minhmice.com",
    ),
    nineRouterPassword: settingsValue.nineRouterPassword,
    nineRouterApiKey: settingsValue.nineRouterApiKey,
    antigravityRotatorEnabled: settingsValue.antigravityRotatorEnabled !== false,
    antigravityRotateMinutes: clamp(
      Math.round(
        Number.isFinite(settingsValue.antigravityRotateMinutes)
          ? settingsValue.antigravityRotateMinutes
          : 10,
      ),
      1,
      60,
    ),
  };
}

function syncProcessEnv(next: AppSettings) {
  process.env.CONTROL_PASSWORD = next.controlPassword;
  process.env.NINEROUTER_URL = next.nineRouterUrl;
  process.env.NINEROUTER_PASSWORD = next.nineRouterPassword;
  process.env.NINEROUTER_API_KEY = next.nineRouterApiKey;
  process.env.ANTIGRAVITY_ROTATOR_ENABLED = String(next.antigravityRotatorEnabled);
  process.env.ANTIGRAVITY_ROTATE_MINUTES = String(next.antigravityRotateMinutes);
}

function writeSettingsFile(next: AppSettings) {
  const file = getSettingsFilePath();
  writeJsonAtomicSync(file, next);
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
      nineRouterUrls: parseNineRouterUrls(settings.nineRouterUrl),
      controlPasswordSet: Boolean(settings.controlPassword),
      nineRouterPasswordSet: Boolean(settings.nineRouterPassword),
      nineRouterApiKeySet: Boolean(settings.nineRouterApiKey),
      antigravityRotatorEnabled: settings.antigravityRotatorEnabled,
      antigravityRotateMinutes: settings.antigravityRotateMinutes,
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

  if (patch.antigravityRotatorEnabled !== undefined) {
    next.antigravityRotatorEnabled = Boolean(patch.antigravityRotatorEnabled);
    changed.push("antigravityRotatorEnabled");
  }

  if (patch.antigravityRotateMinutes !== undefined) {
    next.antigravityRotateMinutes = patch.antigravityRotateMinutes;
    changed.push("antigravityRotateMinutes");
  }

  if (!changed.length) return getSettingsPublic();

  settings = normalize(next);
  writeSettingsFile(settings);
  syncProcessEnv(settings);
  for (const listener of listeners) listener(settings, changed);
  return getSettingsPublic();
}

initAppConfig();
