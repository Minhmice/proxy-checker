"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  Layers,
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
  }
);

export default function OverviewPage() {
  const { password, authenticated } = useAuth();
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

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!password && !authenticated) {
        setLoading(false);
        return;
      }
      try {
        const [statusData, metricsData, poolsData] = await Promise.all([
          fetchStatus(password, signal),
          fetchMetrics(password, hours, signal),
          fetchPools(password, "active", signal),
        ]);
        setStatus(statusData);
        setMetrics(metricsData);
        setPools(poolsData);
        setSelectedPoolId((current) =>
          poolsData.some((pool) => pool.localId === current)
            ? current
            : poolsData[0]?.localId ?? null
        );
        setError("");
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [password, authenticated, hours]
  );

  useEffect(() => {
    if (!password && !authenticated) return;
    const controller = new AbortController();
    void load(controller.signal).catch(() => {});
    const timer = setInterval(() => {
      void load(controller.signal).catch(() => {});
    }, 15000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [password, authenticated, load]);

  async function handleRefresh() {
    setRefreshing(true);
    await load();
  }

  async function handleSync() {
    if (!password && !authenticated) return;
    setNotice("");
    try {
      await syncPools(password);
      setNotice("Pool sync triggered. Ranking fastest routes and synchronizing 9Router...");
      window.setTimeout(() => load(), 1500);
    } catch (err) {
      setNotice((err as Error).message);
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
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Executive Console Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-border/60">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              Workspace / Control Room
            </span>
            <span className="text-muted-foreground/40">•</span>
            <div className="flex items-center gap-1.5">
              <span className="relative flex size-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full size-2 bg-emerald-500" />
              </span>
              <span className="font-mono text-xs text-emerald-400 font-medium">9Router Core Live</span>
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">
            Proxy Fleet Dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Monitor real-time latency ranking, active route allocation, and automated health synchronization.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!password || refreshing}
            onClick={handleRefresh}
            className="h-9 px-3 gap-1.5 font-medium border-border-subtle bg-surface/50 hover:bg-surface-raised"
          >
            <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
            <span>Refresh</span>
          </Button>

          <Button
            type="button"
            size="sm"
            disabled={!password || status?.running}
            onClick={handleSync}
            className="h-9 px-4 gap-1.5 font-semibold bg-gradient-to-r from-primary to-accent-violet hover:opacity-95 shadow-xs"
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

      {/* System Banners */}
      {error && (
        <Alert variant="destructive" className="border-destructive/40 bg-destructive/10 text-destructive-foreground">
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

      {!status?.configured && password && (
        <Alert className="border-warning/40 bg-warning/10 text-ink">
          <AlertTriangle className="size-4 text-warning" />
          <AlertDescription className="text-xs sm:text-sm">
            Set <code className="font-mono bg-surface-raised px-1 py-0.5 rounded text-xs">NINEROUTER_PASSWORD</code> in <code className="font-mono text-xs">.env</code> (9Router dashboard login password) to sync live pools.
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
            value={status?.stats.active ?? 0}
            sub={`Prioritized top ${status?.activeLimit ?? 50} on 9Router`}
            delta={
              sparkActive.length > 1
                ? `${sparkActive.at(-1)! - sparkActive.at(-2)! >= 0 ? "+" : ""}${sparkActive.at(-1)! - sparkActive.at(-2)!}`
                : undefined
            }
            sparkData={sparkActive}
            sparkColor="oklch(0.62 0.19 255)"
            icon={<Server className="size-4 text-primary" />}
            badgeVariant="outline"
          />
          <MetricCard
            label="Reserve Proxies"
            value={status?.stats.reserve ?? 0}
            sub="Healthy fallback, slower latency"
            sparkData={sparkReserve}
            sparkColor="oklch(0.58 0.22 295)"
            icon={<Activity className="size-4 text-accent-violet" />}
            badgeVariant="outline"
          />
          <MetricCard
            label="Dead Proxies"
            value={status?.stats.dead ?? 0}
            sub="Excluded from active cluster routing"
            sparkData={sparkDead}
            sparkColor="oklch(0.72 0.14 195)"
            icon={<AlertCircle className="size-4 text-accent-teal" />}
            badgeVariant="destructive"
          />
        </div>
      )}

      {/* Traffic & Capacity Chart */}
      <TrafficChart snapshots={metrics} hours={hours} onHoursChange={setHours} />

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
              <Badge variant="outline" className="font-mono text-xs border-border-subtle text-muted-foreground">
                Top {pools.length} Routes
              </Badge>
            </div>
            <CardDescription className="text-xs text-muted-foreground mt-1">
              Select any route to inspect endpoint verification, measured latency, and egress IP.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild className="h-8 gap-1 text-xs self-start sm:self-auto border-border-subtle hover:bg-surface-raised">
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
                              : "hover:bg-surface-raised/50"
                          )}
                        >
                          <TableCell className="font-mono text-xs text-muted-foreground font-semibold">
                            #{idx + 1}
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-col gap-0.5">
                              <span className="text-sm text-ink font-medium leading-tight truncate max-w-[200px] sm:max-w-xs">
                                {pool.name}
                              </span>
                              <span className="font-mono text-[11px] text-muted-foreground/80 truncate max-w-[200px] sm:max-w-xs">
                                {pool.proxyUrl}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {pool.latency_ms == null ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <span
                                className={cn(
                                  "font-semibold",
                                  pool.latency_ms < 100
                                    ? "text-emerald-400"
                                    : pool.latency_ms < 300
                                    ? "text-primary"
                                    : "text-amber-400"
                                )}
                              >
                                {pool.latency_ms} ms
                              </span>
                            )}
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
                        <span className="text-[10px] text-muted-foreground block uppercase">Measured Latency</span>
                        <span className="text-sm font-bold text-ink mt-0.5 block">
                          {selectedPool.latency_ms == null ? "Not measured" : `${selectedPool.latency_ms} ms`}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-lg bg-surface-raised/40 border border-border-subtle/50">
                        <span className="text-[10px] text-muted-foreground block uppercase">Exit IP</span>
                        <span className="text-xs font-semibold text-slate-200 mt-0.5 block truncate">
                          {selectedPool.exit_ip || "Unavailable"}
                        </span>
                      </div>
                      <div className="p-2.5 rounded-lg bg-surface-raised/40 border border-border-subtle/50 col-span-2">
                        <span className="text-[10px] text-muted-foreground block uppercase">Check Ratio</span>
                        <span className="text-xs font-semibold text-ink mt-0.5 block">
                          {selectedPool.successes} passed · {selectedPool.failures} failed
                        </span>
                      </div>
                    </div>

                    {selectedPool.last_error && (
                      <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-xs font-mono">
                        <span className="font-semibold block mb-0.5">Last Check Error:</span>
                        <span className="break-words opacity-90">{selectedPool.last_error}</span>
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
                  <Button variant="outline" size="sm" asChild className="w-full text-xs h-8 border-border-subtle">
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

      {/* Operational Policy & Sync Engine Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pool Routing Policy */}
        <Card className="border-border bg-card/90 shadow-sm backdrop-blur-xs flex flex-col justify-between">
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
                <span><strong className="text-ink">Active Tier:</strong> Handles production traffic, dynamically prioritized by low latency.</span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="size-1.5 rounded-full bg-accent-violet mt-1.5 shrink-0" />
                <span><strong className="text-ink">Reserve Tier:</strong> Verified online endpoints held for instant failover when active routes degrade.</span>
              </div>
              <div className="flex items-start gap-2.5">
                <span className="size-1.5 rounded-full bg-destructive mt-1.5 shrink-0" />
                <span><strong className="text-ink">Dead Isolation:</strong> Unresponsive or high-error proxies quarantined from router rotation.</span>
              </div>
            </div>
            <div className="pt-2">
              <Button variant="outline" size="sm" asChild className="text-xs h-8 border-border-subtle hover:bg-surface-raised">
                <Link href="/proxies">
                  <span>Review Fleet Allocation</span>
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Sync Engine Status */}
        <Card className="border-border bg-card/90 shadow-sm backdrop-blur-xs flex flex-col justify-between">
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
                Interval: {status?.autoSync === false ? "paused" : `every ${status?.syncIntervalMinutes ?? 360}m`}
              </span>
              <Button
                type="button"
                size="sm"
                disabled={!password || status?.running}
                onClick={handleSync}
                className="text-xs h-8 px-3 gap-1.5 font-medium bg-primary hover:bg-primary-hover text-white"
              >
                <RefreshCw className={cn("size-3", status?.running && "animate-spin")} />
                <span>Run Sync Now</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
