import { Activity, CheckCircle2, Clock3, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { PoolRecord } from "@/lib/types";

export function ProxyHealthBadge({ pool }: { pool: PoolRecord }) {
  const testState = pool.testState ?? "idle";

  if (testState === "queued" || pool.healthStatus === "pending") {
    return (
      <Badge className="health-badge health-badge--pending" variant="secondary">
        <Clock3 aria-hidden />
        <span>Queued</span>
      </Badge>
    );
  }

  if (testState === "retrying") {
    return (
      <Badge className="health-badge health-badge--checking" variant="secondary">
        <RotateCcw className="ops-spin" aria-hidden />
        <span>Retrying</span>
      </Badge>
    );
  }

  if (testState === "checking" || pool.healthStatus === "checking") {
    return (
      <Badge className="health-badge health-badge--checking" variant="secondary">
        <span className="health-badge__ring" aria-hidden />
        <Activity aria-hidden />
        <span>Checking</span>
      </Badge>
    );
  }

  if (pool.remoteState === "revived") {
    return (
      <Badge className="health-badge health-badge--revived" variant="secondary">
        <RotateCcw aria-hidden />
        <span>Revived · ready to restore</span>
      </Badge>
    );
  }

  if (pool.remoteState === "delete_failed") {
    return (
      <Badge className="health-badge health-badge--dead" variant="destructive">
        <XCircle aria-hidden />
        <span>Removal failed · retry delete</span>
      </Badge>
    );
  }

  if (pool.remoteState === "removed") {
    return (
      <Badge className="health-badge health-badge--removed" variant="secondary">
        <XCircle aria-hidden />
        <span>Offline · removed from 9Router</span>
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
