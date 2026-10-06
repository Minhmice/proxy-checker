import type { ActivityEntry } from "./types";

export interface SyncSessionSummary {
  id: string;
  startedAt: number;
  finishedAt?: number;
  durationSeconds?: number;
  status: "running" | "success" | "failed";
  activeCount?: number;
  reserveCount?: number;
  deadCount?: number;
  checkedCount?: number;
  retriesCount: number;
  revivedCount: number;
  removedCount: number;
  renamedCount: number;
  errorMessages: string[];
  warningMessages: string[];
  highlights: string[];
}

/**
 * Shorten raw UUIDs in log messages to reduce visual noise.
 * e.g., "7debd05e-a4dc-4c99-9340-7c1f1a6c70fd" -> "7debd05e..."
 */
export function sanitizeLogMessage(message: string): string {
  return message.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (match) => `${match.slice(0, 8)}…`
  );
}

/**
 * Groups raw ActivityEntries into clean sync sessions + highlights.
 */
export function groupActivityBySync(entries: ActivityEntry[]): SyncSessionSummary[] {
  if (!entries || entries.length === 0) return [];

  // Sort chronological for grouping (oldest to newest)
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const sessions: SyncSessionSummary[] = [];

  let current: SyncSessionSummary = {
    id: "initial-session",
    startedAt: sorted[0].at,
    status: "running",
    retriesCount: 0,
    revivedCount: 0,
    removedCount: 0,
    renamedCount: 0,
    errorMessages: [],
    warningMessages: [],
    highlights: [],
  };

  for (const entry of sorted) {
    const msg = entry.message;
    const cleanMsg = sanitizeLogMessage(msg);

    if (msg.startsWith("Sync started")) {
      // If previous session had items, close and push it
      if (current.highlights.length > 0 || current.errorMessages.length > 0 || current.warningMessages.length > 0) {
        sessions.push(current);
      }
      current = {
        id: entry.id,
        startedAt: entry.at,
        status: "running",
        retriesCount: 0,
        revivedCount: 0,
        removedCount: 0,
        renamedCount: 0,
        errorMessages: [],
        warningMessages: [],
        highlights: [],
      };
      continue;
    }

    if (msg.includes("Sync finished in")) {
      current.status = "success";
      current.finishedAt = entry.at;
      const secMatch = msg.match(/in (\d+)s/);
      if (secMatch) current.durationSeconds = parseInt(secMatch[1], 10);
      const countMatch = msg.match(/(\d+) active,\s*(\d+) reserve/);
      if (countMatch) {
        current.activeCount = parseInt(countMatch[1], 10);
        current.reserveCount = parseInt(countMatch[2], 10);
      }
      current.highlights.push(cleanMsg);
      continue;
    }

    if (msg.includes("Sync failed:")) {
      current.status = "failed";
      current.finishedAt = entry.at;
      current.errorMessages.push(cleanMsg);
      continue;
    }

    // Tally specific operational events
    if (msg.includes("retrying immediately")) {
      current.retriesCount += 1;
    } else if (msg.includes("Proxy revived:")) {
      current.revivedCount += 1;
    } else if (msg.includes("Removed dead proxy") || msg.includes("Confirmed dead after retry")) {
      current.removedCount += 1;
    } else if (msg.includes("Renamed pool")) {
      current.renamedCount += 1;
    } else if (msg.includes("Listed") && msg.includes("proxies")) {
      const match = msg.match(/Listed (\d+) proxies/);
      if (match) current.checkedCount = parseInt(match[1], 10);
    }

    // Keep errors and warnings prominent
    if (entry.level === "error") {
      current.errorMessages.push(cleanMsg);
    } else if (entry.level === "warn") {
      current.warningMessages.push(cleanMsg);
    } else if (entry.level === "success") {
      current.highlights.push(cleanMsg);
    }
  }

  sessions.push(current);

  // Return newest sessions first
  return sessions.reverse();
}
