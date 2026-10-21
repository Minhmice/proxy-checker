import type { FleetNodeStatus, FleetHealthStatus } from "../proxyfleet/types.js";

export function redactCredential(val: string): string {
  if (!val) return "";
  return "•".repeat(Math.min(12, Math.max(8, val.length)));
}

export function formatFleetNodeStatus(status: FleetNodeStatus): {
  label: string;
  variant: "default" | "success" | "destructive" | "warning" | "secondary";
} {
  switch (status) {
    case "online":
      return { label: "Online", variant: "success" };
    case "offline":
      return { label: "Offline", variant: "destructive" };
    case "degraded":
      return { label: "Degraded", variant: "warning" };
    default:
      return { label: status, variant: "secondary" };
  }
}

export function formatFleetNodeRole(role?: string): {
  label: string;
  badgeVariant: "default" | "secondary" | "outline";
} {
  if (role === "controller-worker") {
    return { label: "Controller + Worker", badgeVariant: "default" };
  }
  return { label: "Worker", badgeVariant: "secondary" };
}

export function formatHealthStatus(status: FleetHealthStatus): {
  label: string;
  variant: "default" | "success" | "destructive" | "warning" | "secondary";
} {
  switch (status) {
    case "healthy":
      return { label: "Healthy", variant: "success" };
    case "degraded":
      return { label: "Degraded", variant: "warning" };
    case "offline":
      return { label: "Offline", variant: "destructive" };
    case "route_leak":
      return { label: "Route Leak", variant: "destructive" };
    case "auth_error":
      return { label: "Auth Error", variant: "destructive" };
    case "timeout":
      return { label: "Timeout", variant: "warning" };
    case "configuration_error":
      return { label: "Config Error", variant: "destructive" };
    default:
      return { label: status, variant: "secondary" };
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = (bytes / Math.pow(1024, i)).toFixed(1);
  return `${val} ${units[i] || "B"}`;
}

export function formatRelativeTime(timestamp: number): string {
  if (!timestamp) return "Never";
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 5) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}

export function formatHeartbeatStatus(timestamp: number | null): {
  label: string;
  severity: "normal" | "warning" | "critical";
} {
  if (!timestamp) return { label: "Never", severity: "critical" };
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  const label = formatRelativeTime(timestamp);
  if (diffSec < 300) return { label, severity: "normal" };
  if (diffSec < 3600) return { label, severity: "warning" };
  return { label, severity: "critical" };
}

export function formatPlatform(os: string | null, arch: string | null): string {
  const o = (os || "unknown").toLowerCase().replace("win32", "windows");
  const a = (arch || "unknown").toLowerCase().replace("x64", "amd64");
  return `${o}/${a}`;
}
