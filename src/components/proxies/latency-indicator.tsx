import * as React from "react";
import { cn } from "@/lib/utils";

export interface LatencyIndicatorProps {
  latencyMs: number | null | undefined;
  isDead?: boolean;
  className?: string;
  showBar?: boolean;
}

export function LatencyIndicator({
  latencyMs,
  isDead = false,
  className,
  showBar = false,
}: LatencyIndicatorProps) {
  if (latencyMs == null || isDead || !Number.isFinite(latencyMs)) {
    return <span className={cn("text-muted-foreground/60 font-mono text-xs", className)}>—</span>;
  }

  const rounded = Math.round(latencyMs);
  const tone =
    rounded < 300 ? "text-emerald-400" : rounded < 1000 ? "text-foreground" : "text-amber-400";

  const barColor =
    rounded < 300 ? "bg-emerald-400" : rounded < 1000 ? "bg-[#FF8555]" : "bg-amber-400";

  // Clamp bar percentage between 10% and 100% for 0 - 2000ms
  const barPercent = Math.min(100, Math.max(10, Math.round((rounded / 2000) * 100)));

  return (
    <div className={cn("inline-flex flex-col items-end gap-1 font-mono text-xs", className)}>
      <span className={cn("font-medium tabular-nums", tone)}>
        {rounded} <span className="text-[10px] text-muted-foreground/80 font-normal">ms</span>
      </span>
      {showBar && (
        <div className="w-12 h-1 bg-muted/40 rounded-full overflow-hidden" aria-hidden="true">
          <div
            className={cn("h-full rounded-full transition-all duration-300", barColor)}
            style={{ width: `${barPercent}%` }}
          />
        </div>
      )}
    </div>
  );
}
