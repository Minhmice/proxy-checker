export function formatCountdown(
  resetAt: string | null | undefined,
  now: number = Date.now(),
  prefix = "",
): string {
  if (!resetAt) return "No reset info";
  const target = new Date(resetAt).getTime();
  if (!Number.isFinite(target)) return "No reset info";
  const diffMs = target - now;
  if (diffMs <= 0) return "Resetting soon";
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  return hours > 0 ? `${prefix}${hours}h ${mins % 60}m` : `${prefix}${mins}m`;
}
