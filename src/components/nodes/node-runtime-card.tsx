"use client";

import { useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  Clock,
  Cpu,
  HardDrive,
  Info,
  Layers,
  Network,
  Radio,
  RefreshCw,
  Server,
  Shield,
  Wifi,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatBytes, formatRelativeTime } from "@/lib/fleet-ui-utils";
import type { FleetNodeRecord, FleetNodeConfigurationView } from "@/proxyfleet/types";
import type {
  FleetDeviceInfo,
  FleetRuntimeSnapshot,
  FleetCapacitySettings,
} from "@/proxyfleet/runtime";

function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec == null) return "—";
  if (bytesPerSec <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const i = Math.max(
    0,
    Math.min(units.length - 1, Math.floor(Math.log(bytesPerSec) / Math.log(1024))),
  );
  const val = (bytesPerSec / Math.pow(1024, i)).toFixed(1);
  return `${val} ${units[i]}`;
}

function formatUptimeDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${Math.floor(seconds % 60)}s`;
}

export interface NodeRuntimeCardProps {
  node: FleetNodeRecord;
  device?: FleetDeviceInfo | null;
  runtime?: FleetRuntimeSnapshot | null;
  runtimeReceivedAt?: number | null;
  capacity?: FleetCapacitySettings | null;
  onRefresh?: () => void;
  loading?: boolean;
}

export function NodeRuntimeCard({
  node,
  device,
  runtime,
  runtimeReceivedAt,
  capacity,
  onRefresh,
  loading = false,
}: NodeRuntimeCardProps) {
  const isStale = runtimeReceivedAt ? Date.now() - runtimeReceivedAt > 60_000 : false;

  // Status axis 1: Agent liveness
  const agentStatus = node.status;
  // Status axis 2: Configuration convergence
  const config = node.configuration;
  // Status axis 3: Overlay tunnel
  const overlayState = runtime?.overlay?.state ?? "unknown";
  // Status axis 4: Proxy listener health
  const proxyState = runtime?.proxy?.state ?? "unknown";

  const cpuDisplay = runtime?.cpuPercent == null ? "—" : `${runtime.cpuPercent.toFixed(1)}%`;

  const memoryDisplay = useMemo(() => {
    if (!runtime) return { available: "—", total: "—", percent: null };
    const avail = runtime.memoryAvailableBytes;
    const total = runtime.memoryTotalBytes ?? device?.memoryTotalBytes ?? null;
    if (avail == null && total == null) return { available: "—", total: "—", percent: null };
    const availStr = avail != null ? formatBytes(avail) : "—";
    const totalStr = total != null ? formatBytes(total) : "—";
    const pct =
      total != null && total > 0 && avail != null
        ? Math.max(0, Math.min(100, Math.round(((total - avail) / total) * 100)))
        : null;
    return { available: availStr, total: totalStr, percent: pct };
  }, [runtime, device]);

  return (
    <Card className="border-border/60 bg-card/60 shadow-none overflow-hidden">
      <CardHeader className="border-b border-border/40 pb-3 bg-muted/10">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="size-4 text-primary" />
              Runtime & Observability
              {isStale && (
                <Badge
                  variant="outline"
                  className="border-amber-500/40 bg-amber-500/10 text-amber-300 gap-1 text-[11px] font-normal"
                >
                  <AlertTriangle className="size-3" />
                  Stale telemetry (
                  {runtimeReceivedAt ? formatRelativeTime(runtimeReceivedAt) : ">60s"})
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs">
              Measured host metrics and separate lifecycle status axes.
            </CardDescription>
          </div>
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={loading}
              className="h-8 gap-1.5 text-xs self-start sm:self-auto"
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-4 space-y-5">
        {/* Four Status Axes */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {/* Axis 1: Agent Liveness */}
          <div className="rounded-md border border-border/50 bg-background/50 p-2.5 space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Radio className="size-3" /> Agent Liveness
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`size-2 rounded-full ${
                  agentStatus === "online"
                    ? "bg-emerald-400 ring-2 ring-emerald-500/20"
                    : agentStatus === "degraded"
                      ? "bg-amber-400 ring-2 ring-amber-500/20"
                      : "bg-rose-400 ring-2 ring-rose-500/20"
                }`}
              />
              <span className="text-xs font-semibold capitalize text-foreground">
                {agentStatus}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              Heartbeat: {formatRelativeTime(node.last_heartbeat_at ?? 0)}
            </div>
          </div>

          {/* Axis 2: Configuration Convergence */}
          <div className="rounded-md border border-border/50 bg-background/50 p-2.5 space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Layers className="size-3" /> Config Convergence
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`size-2 rounded-full ${
                  config?.status === "applied"
                    ? "bg-emerald-400 ring-2 ring-emerald-500/20"
                    : config?.status === "pending"
                      ? "bg-amber-400 ring-2 ring-amber-500/20"
                      : config?.status === "failed"
                        ? "bg-rose-400 ring-2 ring-rose-500/20"
                        : "bg-muted-foreground"
                }`}
              />
              <span className="text-xs font-semibold capitalize text-foreground">
                {config?.status ?? "unknown"}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground truncate font-mono">
              Rev {config?.appliedRevision ?? node.applied_revision ?? "—"}/
              {config?.desiredRevision ?? node.desired_revision}
            </div>
          </div>

          {/* Axis 3: Tunnel Overlay */}
          <div className="rounded-md border border-border/50 bg-background/50 p-2.5 space-y-1">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
              <Shield className="size-3" /> Overlay Tunnel
            </div>
            <div className="flex items-center gap-1.5">
              <span
                className={`size-2 rounded-full ${
                  overlayState === "healthy"
                    ? "bg-emerald-400 ring-2 ring-emerald-500/20"
                    : overlayState === "unhealthy"
                      ? "bg-rose-400 ring-2 ring-rose-500/20"
                      : "bg-muted-foreground"
                }`}
              />
              <span className="text-xs font-semibold capitalize text-foreground">
                {overlayState}
              </span>
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {runtime?.overlay?.lastHandshakeAt
                ? `Handshake ${formatRelativeTime(runtime.overlay.lastHandshakeAt)}`
                : "No handshake recorded"}
            </div>
          </div>

          {/* Axis 4: Proxy Service */}
          {(() => {
            if (!runtime) {
              return (
                <div className="rounded-md border border-border/50 bg-background/50 p-2.5 space-y-1">
                  <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                    <Server className="size-3" /> Proxy Service
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-muted-foreground" />
                    <span className="text-xs font-semibold capitalize text-foreground">
                      Unknown
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground truncate font-mono">
                    Listeners: Unknown
                  </div>
                </div>
              );
            }

            const listening = runtime.proxy.listeningEndpoints;
            const enabled = runtime.proxy.enabledEndpoints;
            const isMismatch =
              proxyState === "running" &&
              listening != null &&
              (listening < enabled || (enabled > 0 && listening === 0));

            const dotClass =
              proxyState === "stopped"
                ? "bg-rose-400 ring-2 ring-rose-500/20"
                : isMismatch
                  ? "bg-amber-400 ring-2 ring-amber-500/20"
                  : proxyState === "running"
                    ? "bg-emerald-400 ring-2 ring-emerald-500/20"
                    : "bg-muted-foreground";

            const statusLabel =
              proxyState === "running" && isMismatch ? "Running (Degraded)" : proxyState;

            return (
              <div className="rounded-md border border-border/50 bg-background/50 p-2.5 space-y-1">
                <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                  <Server className="size-3" /> Proxy Service
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`size-2 rounded-full ${dotClass}`} />
                  <span className="text-xs font-semibold capitalize text-foreground">
                    {statusLabel}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground truncate font-mono">
                  Listeners: {listening ?? "—"}/{enabled}
                  {isMismatch && <span className="text-amber-400 ml-1">(! mismatch)</span>}
                </div>
              </div>
            );
          })()}
        </div>

        {/* Telemetry Metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {/* CPU */}
          <div className="rounded-md border border-border/40 p-3 bg-muted/5 space-y-1">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Cpu className="size-3.5 text-primary" /> CPU Utilization
            </div>
            <div className="text-lg font-semibold font-mono tracking-tight text-foreground">
              {cpuDisplay}
            </div>
            <div className="text-[10px] text-muted-foreground truncate font-mono">
              {runtime?.loadAverage1m != null
                ? `1m load: ${runtime.loadAverage1m.toFixed(2)}`
                : "No load avg"}
            </div>
          </div>

          {/* Memory */}
          <div className="rounded-md border border-border/40 p-3 bg-muted/5 space-y-1">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <HardDrive className="size-3.5 text-primary" /> Memory Usage
            </div>
            <div className="text-lg font-semibold font-mono tracking-tight text-foreground">
              {memoryDisplay.percent != null ? `${memoryDisplay.percent}%` : "—"}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {memoryDisplay.available} avail / {memoryDisplay.total}
            </div>
          </div>

          {/* Network Throughput */}
          <div className="rounded-md border border-border/40 p-3 bg-muted/5 space-y-1">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Network className="size-3.5 text-primary" /> Network Rates
            </div>
            <div className="text-xs font-mono font-medium text-foreground">
              ↓ {formatRate(runtime?.network?.rxBytesPerSecond)}
            </div>
            <div className="text-xs font-mono font-medium text-foreground">
              ↑ {formatRate(runtime?.network?.txBytesPerSecond)}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              {runtime?.network?.interfaceName ?? "interface"}{" "}
              {runtime?.network?.scope ? `(${runtime.network.scope})` : ""}
            </div>
          </div>

          {/* Uptime & Connections */}
          <div className="rounded-md border border-border/40 p-3 bg-muted/5 space-y-1">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Clock className="size-3.5 text-primary" /> Uptime & Conns
            </div>
            <div className="text-xs font-mono font-semibold text-foreground">
              {formatUptimeDuration(runtime?.uptimeSeconds)}
            </div>
            <div className="text-[11px] font-mono text-muted-foreground">
              Conns: {runtime?.proxy?.activeConnections ?? "—"}
            </div>
            <div className="text-[10px] text-muted-foreground truncate">
              Cap:{" "}
              {capacity?.maxConnections ? `${capacity.maxConnections} maxconn` : "engine default"}
            </div>
          </div>
        </div>

        {/* Current Activity Banner */}
        {runtime?.activity && runtime.activity.kind !== "idle" && (
          <div className="rounded-md border border-border/60 bg-muted/20 p-2.5 flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="capitalize text-[11px]">
                {runtime.activity.kind}
              </Badge>
              <span className="text-muted-foreground">
                Started {formatRelativeTime(runtime.activity.startedAt)}
                {runtime.activity.revision ? ` (rev ${runtime.activity.revision})` : ""}
              </span>
            </div>
            {runtime.activity.error && (
              <span className="text-rose-400 font-mono text-[11px] truncate max-w-[280px]">
                {runtime.activity.error}
              </span>
            )}
          </div>
        )}

        {/* Device Information Section */}
        <div className="rounded-md border border-border/50 bg-background/40 p-3 space-y-2">
          <div className="text-xs font-semibold text-foreground flex items-center gap-1.5 border-b border-border/30 pb-1.5">
            <Server className="size-3.5 text-muted-foreground" />
            Host & Hardware Identity
          </div>

          {device ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              <div>
                <span className="text-muted-foreground">Hostname: </span>
                <span className="font-mono text-foreground">{device.hostname || "—"}</span>
              </div>
              <div>
                <span className="text-muted-foreground">OS / Kernel: </span>
                <span className="text-foreground">
                  {device.osFamily} {device.osVersion || ""} ({device.kernel || "kernel —"})
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Architecture: </span>
                <span className="text-foreground font-mono">
                  OS: {device.osArch || "—"} / Agent: {device.agentArch}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Hardware: </span>
                <span className="text-foreground">
                  {device.vendor ? `${device.vendor} ` : ""}
                  {device.model || "Unknown model"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">CPU Model: </span>
                <span className="text-foreground truncate" title={device.cpuModel ?? ""}>
                  {device.cpuModel || "—"}{" "}
                  {device.logicalCpus ? `(${device.logicalCpus} cores)` : ""}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Virtualization: </span>
                <span className="text-foreground capitalize">
                  {device.virtualization || "unknown"}
                </span>
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted-foreground italic py-1">
              Unknown device (no device report received from node agent yet).
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
