import crypto from "node:crypto";

export type ActivityLevel = "info" | "warn" | "error" | "success";
export type SyncPhase = "idle" | "login" | "fetch" | "check" | "rank" | "activate" | "done";

export interface ActivityEntry {
  id: string;
  at: number;
  level: ActivityLevel;
  message: string;
}

export interface SyncProgress {
  phase: SyncPhase;
  checked: number;
  total: number;
  remoteTotal: number;
}

// 40 was too small: bulk audit progress (started/periodic/finished) pushed sync
// entries out within a single run. 200 keeps sync + audit visible together.
const MAX_ENTRIES = 200;
const entries: ActivityEntry[] = [];
let progress: SyncProgress = { phase: "idle", checked: 0, total: 0, remoteTotal: 0 };
const throttleKeys = new Map<string, number>();

export function levelPrefix(level: ActivityLevel): string {
  if (level === "error") return "[ERROR]";
  if (level === "warn") return "[WARN ]";
  if (level === "success") return "[OK   ]";
  return "[INFO ]";
}

export function formatScope(scope: string, fn?: string): string {
  return fn ? `[${scope}::${fn}]` : `[${scope}]`;
}

export function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const pairs = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => {
      if (typeof v === "object" && v !== null) {
        return `${k}=${JSON.stringify(v)}`;
      }
      return `${k}=${v}`;
    });
  return pairs.length > 0 ? ` | ${pairs.join(" ")}` : "";
}

export function logScoped(
  scope: string,
  fn: string,
  level: ActivityLevel,
  message: string,
  meta?: Record<string, unknown>,
) {
  const metaStr = formatMeta(meta);
  const scopeTag = formatScope(scope, fn);
  logActivity(level, `${scopeTag} ${message}${metaStr}`);
}

export function logActivity(level: ActivityLevel, message: string) {
  const entry: ActivityEntry = { id: crypto.randomUUID(), at: Date.now(), level, message };
  entries.unshift(entry);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  const stamp = new Date(entry.at).toISOString().slice(11, 19);
  console.log(`[9router ${stamp}] ${levelPrefix(level)} ${message}`);
}

/** Skip duplicate messages with the same key within ttlMs (default 60s). */
export function logActivityThrottled(
  key: string,
  level: ActivityLevel,
  message: string,
  ttlMs = 60_000,
) {
  const now = Date.now();
  if (now - (throttleKeys.get(key) ?? 0) < ttlMs) return;
  throttleKeys.set(key, now);
  logActivity(level, message);
}

export function setSyncProgress(patch: Partial<SyncProgress>) {
  progress = { ...progress, ...patch };
}

export function resetSyncProgress() {
  progress = { phase: "idle", checked: 0, total: 0, remoteTotal: 0 };
}

export function getActivitySnapshot() {
  return { entries: [...entries], progress: { ...progress } };
}

export function clearActivity() {
  entries.length = 0;
}
