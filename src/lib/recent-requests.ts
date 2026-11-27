import type { RecentRequest } from "./types";

/** A single request whose input exceeds this many tokens raises an alert. */
export const LARGE_INPUT_TOKENS = 500_000;

export type KeyedRequest = RecentRequest & { key: string };

export function isLargeRequest(request: Pick<RecentRequest, "promptTokens">): boolean {
  return request.promptTokens > LARGE_INPUT_TOKENS;
}

/** Stable identity across polls; identical requests get a numbered suffix so keys never collide. */
export function keyRequests(requests: RecentRequest[]): KeyedRequest[] {
  const counts = new Map<string, number>();
  return requests.map((request) => {
    const base = [
      request.nodeId,
      request.timestamp,
      request.model,
      request.provider,
      request.promptTokens,
      request.completionTokens,
    ].join("|");
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return { ...request, key: `${base}#${count}` };
  });
}

export function formatAgo(timestamp: string, now: number): string {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return "—";
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 2) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
