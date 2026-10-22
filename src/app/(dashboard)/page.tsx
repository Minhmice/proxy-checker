"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Gauge,
  Globe2,
  Layers,
  Loader2,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { ProxyHealthBadge } from "@/components/proxy-health-badge";
import { useAuth } from "@/components/auth-provider";
import { fetchMetrics, fetchPools, fetchStatus, formatTime, syncPools } from "@/lib/api";
import { isAbortError } from "@/lib/request-lifecycle";
import type { MetricsSnapshot, PoolRecord, PoolStatus } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { BorderBeam } from "@/components/ui/border-beam";
import { Spotlight } from "@/components/ui/spotlight";
import { Status, StatusIndicator, StatusLabel } from "@/components/ui/status";
import { LatencyIndicator } from "@/components/proxies/latency-indicator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const TrafficChart = dynamic(
  () => import("@/components/traffic-chart").then((module) => module.TrafficChart),
  {
    ssr: false,
    loading: () => (
      <Card className="p-6">
        <Skeleton className="h-6 w-48 mb-4" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </Card>
    ),
  },
);

const CobeGlobe = dynamic(() => import("@/components/ui/cobe-globe").then((m) => m.CobeGlobe), {
  ssr: false,
  loading: () => (
    <div className="h-[200px] w-full flex items-center justify-center text-xs text-muted-foreground font-mono">
      <Loader2 className="size-4 animate-spin mr-2" />
      Initializing WebGL Telemetry...
    </div>
  ),
});

export default function OverviewPage() {
  const { password, authenticated } = useAuth();
  const canRead = authenticated || Boolean(password);
  const inFlightRef = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<PoolStatus | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot[]>([]);
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    const controller = new AbortController();
    inFlightRef.current = controller;
    const signal = controller.signal;

    try {
      const [statusData, metricsData, poolsData] = await Promise.all([
        fetchStatus(password || undefined, signal),
        fetchMetrics(password || undefined, hours, signal),
        fetchPools(password || undefined, "active", signal),
      ]);
      if (signal.aborted) return;
      setStatus(statusData);
      setMetrics(metricsData);
      setPools(poolsData);
      setSelectedPoolId((current) =>
        poolsData.some((pool) => pool.localId === current)
          ? current
          : (poolsData[0]?.localId ?? null),
      );
      setError("");
    } catch (err) {
      if (signal.aborted || isAbortError(err)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [password, canRead, hours]);

  useEffect(() => {
    if (!canRead) return;
    void load();
    const timer = setInterval(() => {
      void load();
    }, 15000);
    return () => {
      clearInterval(timer);
      if (inFlightRef.current) {
        inFlightRef.current.abort();
        inFlightRef.current = null;
      }
    };
  }, [canRead, load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
  }

  async function handleSync() {
    if (!canRead || status?.running) return;
    setNotice("");
    setError("");
    try {
      await syncPools(password || undefined);
      setNotice("Pool sync triggered. Ranking fastest routes and synchronizing 9Router...");
      window.setTimeout(() => load(), 1500);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleCopyUrl(url: string) {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  const sparkActive = useMemo(() => metrics.map((m) => m.active), [metrics]);
  const sparkReserve = useMemo(() => metrics.map((m) => m.reserve), [metrics]);
  const sparkDead = useMemo(() => metrics.map((m) => m.dead), [metrics]);
  const selectedPool = pools.find((pool) => pool.localId === selectedPoolId) ?? null;

  return (
    <div className="space-y-6 w-full max-w-none 4xl:max-w-[3600px] mx-auto pb-12">
      {/* Executive Command Hero with Tokyo Midnight Glow */}
      <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-card/75 p-6 sm:p-7 backdrop-blur-xl shadow-lg">
        <Spotlight className="-top-32 left-10 md:left-48" fill="oklch(0.78 0.17 205 / 0.18)" />
        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-5">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground font-semibold">
                NOC Console
              </span>
              <span className="text-muted-foreground/40">•</span>
              <Status
                variant={
                  loading
                    ? "default"
                    : !status || !status.configured
                      ? "warning"
                      : status.lastError
                        ? "error"
                        : "success"
                }
                className="py-0.5 px-2.5"
              >
                <StatusIndicator
                  pulse={Boolean(status?.running || (!status?.lastError && status?.configured))}
                />
                <StatusLabel className="text-[11px] font-semibold uppercase tracking-wider">
                  {loading
                    ? "Checking 9Router"
                    : !status
                      ? "9Router Unknown"
                      : !status.configured
                        ? "9Router Unconfigured"
                        : status.lastError
                          ? "9Router Degraded"
                          : status.running
                            ? "9Router Syncing"
                            : "9Router Core Live"}
                </StatusLabel>
              </Status>
              <Badge
                variant="outline"
                className="font-mono text-[10px] text-primary border-primary/30 bg-primary/5 hidden sm:inline-flex"
              >
                Active Top {status?.activeLimit ?? 50}
              </Badge>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-ink">
              Fleet Operations Command
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl leading-relaxed">
              Real-time latency telemetry, autonomous account rotation, and active proxy cluster
              orchestration.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRead || refreshing}
              onClick={handleRefresh}
              className="h-9 px-3 gap-1.5 font-medium border-border/80 bg-surface/60 hover:bg-surface-raised"
            >
              <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
              <span>Refresh</span>
            </Button>

            <Button
              type="button"
              size="sm"
              variant="halo"
              disabled={!canRead || status?.running}
              onClick={handleSync}
              className="h-9 px-4 gap-1.5 font-semibold text-xs text-primary-foreground shadow-[0_0_16px_oklch(0.78_0.17_205/0.4)]"
            >
              {status?.running ? (
                <>
                  <RefreshCw className="size-3.5 animate-spin" />
                  <span>Syncing Fleet...</span>
                </>
              ) : (
                <>
                  <Zap className="size-3.5" />
                  <span>Sync & Rank Top {status?.activeLimit ?? 50}</span>
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* System Banners */}
      {error && (
        <Alert
          variant="destructive"
          className="border-destructive/40 bg-destructive/10 text-destructive-foreground"
        >
          <AlertCircle className="size-4" />
          <AlertDescription className="font-medium text-xs sm:text-sm">{error}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert className="border-primary/40 bg-primary/10 text-ink">
          <CheckCircle2 className="size-4 text-primary" />
          <AlertDescription className="font-medium text-xs sm:text-sm">{notice}</AlertDescription>
        </Alert>
      )}

      {status && !status.configured && (
        <Alert className="border-warning/40 bg-warning/10 text-ink">
          <AlertTriangle className="size-4 text-warning" />
          <AlertDescription className="text-xs sm:text-sm">
            Set{" "}
            <code className="font-mono bg-surface-raised px-1 py-0.5 rounded text-xs">
              NINEROUTER_PASSWORD
            </code>{" "}
            in <code className="font-mono text-xs">.env</code> (9Router dashboard login password) to
            sync live pools.
          </AlertDescription>
        </Alert>
      )}

      {/* Metric Cards Grid */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="p-4 space-y-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-36" />
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricCard
            label="Active Proxies"
            value={status?.stats.active ?? (loading ? "—" : 0)}
            sub={
              status ? `Prioritized top ${status.activeLimit} on 9Router` : "Active routing target"
            }
            delta={
              sparkActive.length >= 2
                ? `${sparkActive.at(-1)! - sparkActive.at(-2)! >= 0 ? "+" : ""}${sparkActive.at(-1)! - sparkActive.at(-2)!}`
                : undefined
            }
            sparkData={sparkActive}
            sparkColor="oklch(0.78 0.17 205)"
            icon={<Server className="size-4 text-primary" />}
            badgeVariant="outline"
          />
          <MetricCard
            label="Reserve Proxies"
            value={status?.stats.reserve ?? (loading ? "—" : 0)}
            sub="Healthy fallback, slower latency"
            sparkData={sparkReserve}
            sparkColor="oklch(0.68 0.25 315)"
            icon={<Activity className="size-4 text-accent-violet" />}
            badgeVariant="outline"
          />
          <MetricCard
            label="Dead Proxies"
            value={status?.stats.dead ?? (loading ? "—" : 0)}
            sub="Excluded from active cluster routing"
            sparkData={sparkDead}
            sparkColor="oklch(0.68 0.24 25)"
            icon={<AlertCircle className="size-4 text-destructive" />}
            badgeVariant="destructive"
          />
        </div>
      )}

      {/* 4K / Ultra-wide Control Room Layout: Traffic Analytics on Left, Fleet Operations on Right */}
      <div className="grid grid-cols-1 3xl:grid-cols-12 gap-6 items-start">
        <div className="3xl:col-span-5 5xl:col-span-5 flex flex-col gap-6">
          {/* Traffic & Capacity Chart */}
          <TrafficChart snapshots={metrics} hours={hours} onHoursChange={setHours} />

          {/* Operational Policy & Sync Engine Cards (Placed on telemetry column on 4K) */}
          <div className="grid grid-cols-1 md:grid-cols-2 3xl:grid-cols-1 5xl:grid-cols-2 gap-4">
            {/* Global Egress Telemetry with CobeGlobe */}
            <Card className="cyber-card relative overflow-hidden border-border/80 bg-card/90 shadow-sm backdrop-blur-md md:col-span-2 3xl:col-span-1 5xl:col-span-2 flex flex-col justify-between">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="flex size-7 items-center justify-center rounded-md border border-primary/40 bg-primary/10 text-primary">
                      <Globe2 className="size-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-semibold text-ink">
                        Global Egress Telemetry
                      </CardTitle>
                      <CardDescription className="text-xs text-muted-foreground">
                        Live WebGL egress visualization & coordinate mesh
                      </CardDescription>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] text-primary border-primary/30 bg-primary/5"
                  >
                    WebGL Live
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-1 pb-3 flex flex-col items-center">
                <CobeGlobe size={210} markers={[]} />
                <div className="w-full flex items-center justify-between pt-2 border-t border-border-subtle/70 text-[11px] font-mono text-muted-foreground">
                  <span>
                    Active pool egress nodes
                    {status?.stats ? `: ${status.stats.active}` : ""}
                  </span>
                  <span className="text-emerald-400 font-semibold flex items-center gap-1">
                    <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" /> Egress
                    Active
                  </span>
                </div>
              </CardContent>
            </Card>

            {/* Pool Routing Policy */}
            <Card className="cyber-card border-border/80 bg-card/90 shadow-sm backdrop-blur-md flex flex-col justify-between">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-border-subtle bg-surface-raised/70 text-primary">
                    <Gauge className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-ink">
                    Fleet Routing Policy
                  </CardTitle>
                </div>
                <CardDescription className="text-xs text-muted-foreground">
                  Automated multi-tier traffic distribution and failover rules.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-emerald-400 mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-ink">Active Tier:</strong> Handles production traffic,
                      dynamically prioritized by low latency.
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-accent-violet mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-ink">Reserve Tier:</strong> Verified online endpoints
                      held for instant failover when active routes degrade.
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-destructive mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-ink">Dead Isolation:</strong> Unresponsive or
                      high-error proxies quarantined from router rotation.
                    </span>
                  </div>
                </div>
                <div className="pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="text-xs h-8 border-border-subtle hover:bg-surface-raised"
                  >
                    <Link href="/proxies">
                      <span>Review Fleet Allocation</span>
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Sync Engine Status */}
            <Card className="cyber-card relative overflow-hidden border-border/80 bg-card/90 shadow-sm backdrop-blur-md flex flex-col justify-between">
              {status?.running && (
                <BorderBeam
                  size={80}
                  duration={3}
                  colorFrom="oklch(0.78 0.17 205)"
                  colorTo="oklch(0.68 0.25 315)"
                />
              )}
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-border-subtle bg-surface-raised/70 text-primary">
                    <Clock className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-ink">
                    Synchronization Engine
                  </CardTitle>
                </div>
                <CardDescription className="text-xs text-muted-foreground">
                  Interval ranker and 9Router daemon state synchronization.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-surface-raised/50 border border-border-subtle flex items-center justify-between font-mono text-xs">
                  <span className="text-muted-foreground">Last Successful Sync</span>
                  <span className="text-ink font-semibold">
                    {status?.running ? "In progress..." : formatTime(status?.lastSyncAt ?? null)}
                  </span>
                </div>

                {status?.lastError && (
                  <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-xs font-mono">
                    {status.lastError}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground font-mono">
                    Interval:{" "}
                    {status?.autoSync === false
                      ? "paused"
                      : `every ${status?.syncIntervalMinutes ?? 360}m`}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canRead || status?.running}
                    onClick={handleSync}
                    className="text-xs h-8 px-3 gap-1.5 font-medium bg-primary hover:bg-primary-hover text-primary-foreground"
                  >
                    <RefreshCw className={cn("size-3", status?.running && "animate-spin")} />
                    <span>Run Sync Now</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <div className="3xl:col-span-7 5xl:col-span-7 flex flex-col gap-6">
          {/* Active Proxies Inspector Section */}
          <Card className="border-border bg-card/90 shadow-sm backdrop-blur-xs overflow-hidden">
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-border-subtle/60 pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-border-subtle bg-surface-raised/70 text-primary">
                    <ShieldCheck className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-ink">
                    Active Proxy Fleet
                  </CardTitle>
                  <Badge
                    variant="outline"
                    className="font-mono text-xs border-border-subtle text-muted-foreground"
                  >
                    Top {pools.length} Routes
                  </Badge>
                </div>
                <CardDescription className="text-xs text-muted-foreground mt-1">
                  Select any route to inspect endpoint verification, measured latency, and egress
                  IP.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 gap-1 text-xs self-start sm:self-auto border-border-subtle hover:bg-surface-raised"
              >
                <Link href="/proxies">
                  <span>Full Proxy Inventory</span>
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </Button>
            </CardHeader>

            <CardContent className="p-0">
              {loading && pools.length === 0 ? (
                <div className="p-8 space-y-3">
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : pools.length === 0 ? (
                <div className="py-14 text-center">
                  <p className="text-sm font-medium text-ink">No active proxies available</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                    Trigger a fleet sync above to rank endpoints and build an active routing pool.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-border-subtle/70">
                  {/* Table list */}
                  <div className="lg:col-span-2 overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-surface-raised/40">
                        <TableRow className="border-border-subtle hover:bg-transparent">
                          <TableHead className="w-12 text-xs font-mono">Rank</TableHead>
                          <TableHead className="text-xs">Endpoint Name</TableHead>
                          <TableHead className="text-xs">Latency</TableHead>
                          <TableHead className="text-xs font-mono">Exit IP</TableHead>
                          <TableHead className="text-xs text-right">Health</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pools.slice(0, 8).map((pool, idx) => {
                          const isSelected = pool.localId === selectedPool?.localId;
                          return (
                            <TableRow
                              key={pool.localId}
                              onClick={() => setSelectedPoolId(pool.localId)}
                              className={cn(
                                "cursor-pointer border-border-subtle/60 transition-colors",
                                isSelected
                                  ? "bg-primary/10 hover:bg-primary/15 font-medium"
                                  : "hover:bg-surface-raised/50",
                              )}
                            >
                              <TableCell className="font-mono text-xs text-muted-foreground font-semibold">
                                #{idx + 1}
                              </TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-sm text-ink font-medium leading-tight truncate max-w-[200px] sm:max-w-xs 3xl:max-w-md 4xl:max-w-xl">
                                    {pool.name}
                                  </span>
                                  <span className="font-mono text-[11px] text-muted-foreground/80 truncate max-w-[200px] sm:max-w-xs 3xl:max-w-md 4xl:max-w-xl">
                                    {pool.proxyUrl}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell>
                                <LatencyIndicator latencyMs={pool.latency_ms} showBar={true} />
                              </TableCell>
                              <TableCell className="font-mono text-xs text-slate-300">
                                {pool.exit_ip || "—"}
                              </TableCell>
                              <TableCell className="text-right">
                                <ProxyHealthBadge pool={pool} />
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Selected Route Inspector Drawer */}
                  <div className="p-5 lg:col-span-1 bg-surface/30 flex flex-col justify-between space-y-4">
                    {selectedPool ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between pb-2 border-b border-border-subtle/70">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-primary font-semibold">
                            Route Inspector
                          </span>
                          <ProxyHealthBadge pool={selectedPool} />
                        </div>

                        <div>
                          <h4 className="text-sm font-semibold text-ink break-words">
                            {selectedPool.name}
                          </h4>
                          <div className="flex items-center gap-1.5 mt-1.5 p-2 rounded-md bg-surface-raised/80 border border-border-subtle font-mono text-[11px] text-slate-300">
                            <span className="truncate flex-1">{selectedPool.proxyUrl}</span>
                            <button
                              type="button"
                              onClick={() => handleCopyUrl(selectedPool.proxyUrl)}
                              className="shrink-0 text-muted-foreground hover:text-ink transition-colors p-1"
                              title="Copy proxy URL"
                              aria-label="Copy route URL to clipboard"
                            >
                              {copied ? (
                                <Check className="size-3.5 text-emerald-400" />
                              ) : (
                                <Copy className="size-3.5" />
                              )}
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                          <div className="p-2.5 rounded-lg bg-surface-raised/40 border border-border-subtle/50">
                            <span className="text-[10px] text-muted-foreground block uppercase">
                              Measured Latency
                            </span>
                            <span className="text-sm font-bold text-ink mt-0.5 block">
                              {selectedPool.latency_ms == null
                                ? "Not measured"
                                : `${selectedPool.latency_ms} ms`}
                            </span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-surface-raised/40 border border-border-subtle/50">
                            <span className="text-[10px] text-muted-foreground block uppercase">
                              Exit IP
                            </span>
                            <span className="text-xs font-semibold text-slate-200 mt-0.5 block truncate">
                              {selectedPool.exit_ip || "Unavailable"}
                            </span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-surface-raised/40 border border-border-subtle/50 col-span-2">
                            <span className="text-[10px] text-muted-foreground block uppercase">
                              Check Ratio
                            </span>
                            <span className="text-xs font-semibold text-ink mt-0.5 block">
                              {selectedPool.successes} passed · {selectedPool.failures} failed
                            </span>
                          </div>
                        </div>

                        {selectedPool.last_error && (
                          <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-xs font-mono">
                            <span className="font-semibold block mb-0.5">Last Check Error:</span>
                            <span className="break-words opacity-90">
                              {selectedPool.last_error}
                            </span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                        <Layers className="size-8 opacity-40 mb-2" />
                        <p className="text-xs">Select a proxy row to inspect diagnostic metrics</p>
                      </div>
                    )}

                    <div className="pt-3 border-t border-border-subtle/70">
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        className="w-full text-xs h-8 border-border-subtle"
                      >
                        <Link href="/proxies">
                          <span>Manage All Proxy Routes</span>
                        </Link>
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
