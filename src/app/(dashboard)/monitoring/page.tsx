"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { Activity, Server, Cpu, HardDrive, RefreshCw, AlertCircle, Clock, Shield, Network } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { authHeaders } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatFleetNodeStatus, formatFleetNodeRole, formatRelativeTime, formatBytes } from "@/lib/fleet-ui-utils";
import type { FleetNodeRecord, FleetNodeStatus } from "@/proxyfleet/types";
import type { FleetRuntimeSnapshot, FleetDeviceInfo } from "@/proxyfleet/runtime";

export default function MonitoringPage() {
  const { password } = useAuth();
  const [nodes, setNodes] = useState<FleetNodeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const loadData = useCallback(async (isManual = false) => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    if (isManual) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const res = await fetch("/api/fleet/nodes", {
        headers: authHeaders(password),
        credentials: "same-origin",
        signal: controller.signal,
      });

      if (!res.ok) {
        let errMessage = `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
        try {
          const errData = await res.json();
          if (errData && typeof errData === "object") {
            const msg = "error" in errData && typeof errData.error === "string"
              ? errData.error
              : "message" in errData && typeof errData.message === "string"
              ? errData.message
              : null;
            if (msg && msg.trim()) {
              errMessage = `HTTP ${res.status}: ${msg.trim().slice(0, 160)}`;
            }
          }
        } catch {
          // Non-JSON failure (HTML or stream drop); preserve concise HTTP status
        }
        if (controller.signal.aborted) return;
        throw new Error(errMessage);
      }

      const data = await res.json();
      if (controller.signal.aborted) return;
      setNodes(Array.isArray(data.nodes) ? data.nodes : []);
      setLastUpdated(new Date());
    } catch (err: unknown) {
      if (controller.signal.aborted || isAbortError(err)) {
        return;
      }
      setError(err instanceof Error ? err.message : "An unexpected network error occurred while loading telemetry.");
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [password]);

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      if (!abortRef.current?.signal.aborted) {
        void loadData();
      }
    }, 15000);
    return () => {
      clearInterval(interval);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [loadData]);

  const onlineCount = nodes.filter((n) => n.status === "online").length;
  const degradedCount = nodes.filter((n) => n.status === "degraded").length;
  const offlineCount = nodes.filter((n) => n.status === "offline").length;

  const now = Date.now();
  const freshNodes = nodes.filter(n => n.runtime != null && n.runtimeReceivedAt != null && now - n.runtimeReceivedAt <= 60_000);
  const connectionSamples = freshNodes.filter(n => n.runtime?.proxy.activeConnections != null);
  const listenerSamples = freshNodes.filter(n => n.runtime?.proxy.listeningEndpoints != null);
  const overlaySamples = freshNodes.filter(n => n.runtime?.overlay.state !== "unknown");
  const freshActiveConns = connectionSamples.length ? connectionSamples.reduce((sum, n) => sum + n.runtime!.proxy.activeConnections!, 0) : null;
  const freshListeningEps = listenerSamples.length ? listenerSamples.reduce((sum, n) => sum + n.runtime!.proxy.listeningEndpoints!, 0) : null;
  const freshOverlayHealthy = overlaySamples.length ? overlaySamples.filter(n => n.runtime!.overlay.state === "healthy").length : null;
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Activity className="size-6 text-primary" />
            Infrastructure Monitoring
          </h1>
          <p className="text-sm text-muted-foreground">
            Hardware health and operating telemetry across ProxyFleet nodes.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground" title={lastUpdated.toISOString()}>
              <Clock className="size-3.5" />
              <span>Updated {lastUpdated.toLocaleTimeString()}</span>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            disabled={loading || refreshing}
            aria-label="Refresh telemetry data"
          >
            <RefreshCw className={`size-4 mr-2 ${loading || refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Refreshing..." : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Error alert with retry */}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="size-4" />
          <AlertTitle>Telemetry Fetch Failed</AlertTitle>
          <AlertDescription className="mt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <span className="text-xs break-all">{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadData(true)}
              className="shrink-0 text-xs h-7 px-3"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Total Managed Nodes</span>
            <Server className="size-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold">
            {loading && nodes.length === 0 ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              nodes.length
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {loading && nodes.length === 0
              ? "Loading nodes..."
              : `${onlineCount} online / ${degradedCount} degraded / ${offlineCount} offline`}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Active Proxy Connections</span>
            <Activity className="size-4 text-emerald-400" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono">
            {loading && nodes.length === 0 ? (
              <Skeleton className="h-8 w-16" />
            ) : freshActiveConns !== null ? (
              `${freshActiveConns}`
            ) : (
              <span className="text-muted-foreground text-lg font-normal">No fresh data</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {connectionSamples.length > 0
              ? `${freshListeningEps ?? "Unknown"} listeners measured; connections from ${connectionSamples.length}/${nodes.length} nodes (≤60s)`
              : "No measured connection count in last 60s"}
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground font-medium">Overlay Mesh Health</span>
            <Shield className="size-4 text-primary" />
          </div>
          <div className="mt-2 text-2xl font-bold font-mono">
            {loading && nodes.length === 0 ? (
              <Skeleton className="h-8 w-16" />
            ) : freshOverlayHealthy !== null ? (
              `${freshOverlayHealthy}/${overlaySamples.length}`
            ) : (
              <span className="text-muted-foreground text-lg font-normal">No fresh data</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1">
            {overlaySamples.length > 0
              ? `Healthy tunnels across ${overlaySamples.length} measured nodes (≤60s)`
              : "No measured overlay observations available"}
          </div>
        </Card>
      </div>
      {/* Nodes Health Table */}
      <Card className="overflow-hidden">
        <CardHeader className="p-4 border-b">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">
                Node Telemetry ({loading && nodes.length === 0 ? "..." : nodes.length})
              </CardTitle>
              <CardDescription>
                Reported health and operating system telemetry across registered nodes.
              </CardDescription>
            </div>
            {error && nodes.length > 0 && (
              <Badge variant="outline" className="text-amber-500 border-amber-500/30 text-xs">
                Stale snapshot
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[120px]">Node</TableHead>
                  <TableHead className="min-w-[100px]">Liveness</TableHead>
                  <TableHead className="min-w-[110px]">Tunnel</TableHead>
                  <TableHead className="min-w-[100px]">CPU</TableHead>
                  <TableHead className="min-w-[110px]">Memory</TableHead>
                  <TableHead className="min-w-[110px]">Listeners</TableHead>
                  <TableHead className="min-w-[120px]">WireGuard IP</TableHead>
                  <TableHead className="min-w-[120px]">Last Sample</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && nodes.length === 0 ? (
                  Array.from({ length: 3 }).map((_, idx) => (
                    <TableRow key={`skeleton-${idx}`}>
                      <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-20" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                      <TableCell><Skeleton className="h-4 w-16" /></TableCell>
                    </TableRow>
                  ))
                ) : nodes.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                       {error ? (
                         <div className="space-y-2">
                           <p className="text-destructive font-medium text-sm">Failed to load nodes</p>
                           <p className="text-xs text-muted-foreground">Unable to fetch node list from server.</p>
                         </div>
                       ) : (
                         <div className="space-y-1">
                           <p className="text-sm font-medium text-foreground">No worker nodes registered</p>
                           <p className="text-xs text-muted-foreground">Enroll worker nodes to monitor hardware telemetry.</p>
                         </div>
                       )}
                     </TableCell>
                   </TableRow>
                 ) : (
                   nodes.map((node) => {
                     const statusInfo = formatFleetNodeStatus(node.status as FleetNodeStatus);
                     const roleInfo = formatFleetNodeRole(node.role);
                     const badgeVariant =
                       statusInfo.variant === "destructive"
                         ? "destructive"
                         : statusInfo.variant === "warning"
                         ? "outline"
                         : statusInfo.variant === "success"
                         ? "default"
                         : "secondary";
                    const overlayState = node.runtime?.overlay?.state ?? "unknown";
                    const receiptTimestamp = node.runtimeReceivedAt ?? node.runtime?.sampledAt ?? null;
                    const isStale = receiptTimestamp ? (Date.now() - receiptTimestamp > 60000) : false;
                    const cpuText = node.runtime?.cpuPercent != null ? `${node.runtime.cpuPercent.toFixed(1)}%` : "—";
                    const memAvail = node.runtime?.memoryAvailableBytes != null ? formatBytes(node.runtime.memoryAvailableBytes) : "—";

                    return (
                      <TableRow key={node.id}>
                        <TableCell className="font-semibold text-sm">
                          <Link href={`/nodes/${node.id}`} className="hover:underline text-primary inline-block py-1">
                            {node.name}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant={badgeVariant}>
                            {statusInfo.label}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={`text-[10px] capitalize ${
                              overlayState === "healthy"
                                ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10"
                                : overlayState === "unhealthy"
                                ? "text-rose-400 border-rose-500/30 bg-rose-500/10"
                                : "text-muted-foreground"
                            }`}
                          >
                            {overlayState}
                          </Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{cpuText}</TableCell>
                        <TableCell className="font-mono text-xs">{memAvail} avail</TableCell>
                        <TableCell className="font-mono text-xs">
                          {node.runtime?.proxy?.listeningEndpoints ?? "—"}/{node.runtime?.proxy?.enabledEndpoints ?? 0}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{node.wireguard_ip || "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {receiptTimestamp ? (
                            <span className={isStale ? "text-amber-400" : ""}>
                              {formatRelativeTime(receiptTimestamp)}
                              {isStale ? " (stale)" : ""}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                   })
                 )}
               </TableBody>
            </Table>
        </CardContent>
       </Card>
     </div>
   );
 }
