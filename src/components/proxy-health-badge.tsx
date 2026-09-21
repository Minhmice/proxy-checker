import { Activity, CheckCircle2, Clock3, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { HealthStatus, PoolRecord } from "@/lib/types";

function resolveHealth(pool: PoolRecord): HealthStatus {
  if (pool.healthStatus) return pool.healthStatus;
  return "done";
}

export function ProxyHealthBadge({ pool }: { pool: PoolRecord }) {
  const health = resolveHealth(pool);

  if (health === "pending") {
    return (
      <Badge className="health-badge health-badge--pending" variant="secondary">
        <Clock3 aria-hidden />
        <span>Queued</span>
      </Badge>
    );
  }

  if (health === "checking") {
    return (
      <Badge className="health-badge health-badge--checking" variant="secondary">
        <span className="health-badge__ring" aria-hidden />
        <Activity aria-hidden />
        <span>Checking</span>
      </Badge>
    );
  }

  if (pool.status === "usable") {
    return (
      <Badge className="health-badge health-badge--ok" variant="secondary">
        <CheckCircle2 aria-hidden />
        <span>Usable</span>
      </Badge>
    );
  }

  return (
    <Badge className="health-badge health-badge--dead" variant="destructive">
      <XCircle aria-hidden />
      <span>Dead</span>
    </Badge>
  );
}
