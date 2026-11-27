"use client";

import { Fire } from "@/components/dithercn/fire";

const CALM = ["transparent", "--dither-ink", "--primary"] as const;
const CRITICAL = ["transparent", "red", "orange"] as const;

/**
 * Low flame along the bottom edge of the quota cell of an ACTIVE account.
 * Tongues rise as quota drains (capped so the % and the bar stay on clear
 * ground) and the heat turns red once quota is at or below the rotation
 * threshold. Decorative: the percentage and progress bar carry the data.
 * Renders nothing when quota is unavailable (never fake 0%).
 * Parent must be `relative isolate`.
 */
export function QuotaFlame({
  quotaPercent,
  threshold,
}: {
  quotaPercent: number | null;
  threshold?: number | null;
}) {
  if (quotaPercent == null || !Number.isFinite(quotaPercent)) {
    return null;
  }
  const used = 1 - Math.min(100, Math.max(0, quotaPercent)) / 100;
  const critical = threshold != null && quotaPercent <= threshold;
  return (
    <Fire
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 -z-10 h-7"
      height={0.45 + 0.5 * used}
      intensity={critical ? 0.5 : 0.3}
      palette={critical ? CRITICAL : CALM}
      scale={2.2}
      embers={0}
      cell={2}
      speed={0.7}
      fps={20}
    />
  );
}
