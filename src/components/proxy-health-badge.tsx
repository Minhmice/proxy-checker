import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import type { PoolRecord } from "@/lib/types";

export function ProxyHealthBadge({ pool }: { pool: PoolRecord }) {
  const testState = pool.testState ?? "idle";

  if (testState === "queued" || pool.healthStatus === "pending") {
    return (
      <Status variant="default">
        <StatusIndicator />
        <StatusLabel>Queued</StatusLabel>
      </Status>
    );
  }

  if (testState === "retrying") {
    return (
      <Status variant="warning">
        <StatusIndicator pulse />
        <StatusLabel>Retrying</StatusLabel>
      </Status>
    );
  }

  if (testState === "checking" || pool.healthStatus === "checking") {
    return (
      <Status variant="info">
        <StatusIndicator pulse />
        <StatusLabel>Checking</StatusLabel>
      </Status>
    );
  }

  if (pool.remoteState === "revived") {
    return (
      <Status variant="info">
        <StatusIndicator />
        <StatusLabel>Revived · ready to restore</StatusLabel>
      </Status>
    );
  }

  if (pool.remoteState === "delete_failed") {
    return (
      <Status variant="error">
        <StatusIndicator />
        <StatusLabel>Removal failed · retry delete</StatusLabel>
      </Status>
    );
  }

  if (pool.remoteState === "removed") {
    return (
      <Status variant="default">
        <StatusIndicator />
        <StatusLabel>Offline · removed from 9Router</StatusLabel>
      </Status>
    );
  }

  if (pool.status === "usable") {
    return (
      <Status variant="success">
        <StatusIndicator />
        <StatusLabel>Usable</StatusLabel>
      </Status>
    );
  }

  return (
    <Status variant="error">
      <StatusIndicator />
      <StatusLabel>Dead</StatusLabel>
    </Status>
  );
}
