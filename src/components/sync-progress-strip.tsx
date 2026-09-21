import { Progress } from "@/components/ui/progress";
import type { PoolStatus } from "@/lib/types";

export function SyncProgressStrip({ status }: { status: PoolStatus | null }) {
  if (!status?.running || !status.syncProgress) return null;

  const { phase, checked, total } = status.syncProgress;
  const pending = status.stats.pending ?? 0;
  const checking = status.stats.checking ?? 0;
  const done = total > 0 ? checked : 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : phase === "fetch" ? 8 : 0;

  let label = "Syncing…";
  if (phase === "login") label = "Connecting to 9Router…";
  else if (phase === "fetch") label = "Loading proxy list…";
  else if (phase === "check" && total > 0) label = `Health check ${done}/${total}`;
  else if (phase === "rank") label = "Ranking by latency…";
  else if (phase === "activate") label = "Updating 9Router…";

  const visualPercent = Math.max(percent, phase === "check" ? 4 : 12);

  return (
    <div className="sync-strip" role="status" aria-live="polite" aria-label={label}>
      <div className="sync-strip__head">
        <span className="sync-strip__label">{label}</span>
        <span className="sync-strip__meta">
          {checking > 0 && `${checking} checking`}
          {checking > 0 && pending > 0 && " · "}
          {pending > 0 && `${pending} queued`}
          {phase === "check" && total > 0 && ` · ${percent}%`}
        </span>
      </div>
      <Progress value={visualPercent} aria-hidden />
    </div>
  );
}
