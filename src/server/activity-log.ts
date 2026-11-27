export type ActivityLevel = "info" | "warn" | "error" | "success";

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
  const stamp = new Date(Date.now()).toISOString().slice(11, 19);
  console.log(`[9router ${stamp}] ${levelPrefix(level)} ${message}`);
}
