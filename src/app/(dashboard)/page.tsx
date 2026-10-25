"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
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
import { TokenUsageCard } from "@/components/token-usage-card";
import { Sparkline } from "@/components/sparkline";
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

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  },
};

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
      {/* Executive Command Hero with Obsidian Flame Glow */}
      <div className="relative overflow-hidden rounded-2xl border border-[#23232C] bg-[#131318]/90 p-6 sm:p-7 backdrop-blur-xl shadow-lg">
        <Spotlight className="-top-32 left-10 md:left-48" fill="rgba(255, 91, 34, 0.18)" />
        <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-5">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 mb-1">
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
                    ? "Checking sync status"
                    : !status
                      ? "Status unavailable"
                      : !status.configured
                        ? "9Router not configured"
                        : status.lastError
                          ? "Sync degraded"
                          : status.running
                            ? "Syncing"
                            : "Sync healthy"}
                </StatusLabel>
              </Status>
              <Badge
                variant="outline"
                className="font-mono text-[10px] text-[#FF5B22] border-[#FF5B22]/30 bg-[#FF5B22]/10 hidden sm:inline-flex"
              >
                Active limit: {status?.activeLimit ?? 50}
              </Badge>
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white">
              Overview
            </h1>
            <p className="text-xs sm:text-sm text-zinc-400 max-w-2xl leading-relaxed">
              Proxy health, router sync and token usage across configured nodes.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRead || refreshing}
              onClick={handleRefresh}
              className="h-9 px-3 gap-1.5 font-medium border-[#23232C] bg-[#181820] hover:bg-[#23232C] text-white"
            >
              <RotateCw className={cn("size-3.5", refreshing && "animate-spin")} />
              <span>Refresh</span>
            </Button>

            <Button
              type="button"
              size="sm"
              disabled={!canRead || status?.running}
              onClick={handleSync}
              className="h-9 px-4 gap-1.5 font-semibold text-xs text-white bg-gradient-to-r from-[#FF5B22] to-[#FF3D00] hover:from-[#FF6B35] hover:to-[#FF4D14] shadow-[0_0_20px_rgba(255,91,34,0.35)] border-0 transition-all duration-200"
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
            <div key={i} className="rounded-2xl border border-[#23232C] bg-[#131318] p-5 space-y-3">
              <Skeleton className="h-4 w-28 bg-[#23232C]" />
              <Skeleton className="h-10 w-24 bg-[#23232C]" />
              <Skeleton className="h-3 w-36 bg-[#23232C]" />
            </div>
          ))}
        </div>
      ) : (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-1 sm:grid-cols-3 gap-4"
        >
          {/* Card 1: Radiant Flame Orange Hero Card */}
          <motion.div
            variants={itemVariants}
            whileHover={{ y: -2 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="h-full"
          >
            <div className="bg-gradient-to-br from-[#FF5B22] via-[#FF3D00] to-[#D82600] text-white rounded-2xl shadow-[0_8px_32px_-6px_rgba(255,91,34,0.4)] p-6 relative overflow-hidden flex flex-col justify-between h-full min-h-[175px]">
              <div
                className="absolute -right-8 -top-8 size-40 rounded-full bg-white/10 blur-2xl pointer-events-none"
                aria-hidden="true"
              />
              <div
                className="absolute -right-4 -bottom-10 size-32 rounded-full bg-black/10 blur-xl pointer-events-none"
                aria-hidden="true"
              />

              <div className="relative z-10 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-lg bg-white/15 border border-white/20 backdrop-blur-xs text-white">
                    <Server className="size-4" />
                  </div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-white/90">
                    Active Proxies
                  </span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border border-white/30 bg-white/10 text-white text-[11px] font-mono font-medium backdrop-blur-xs shadow-2xs">
                  <span className="size-1.5 rounded-full bg-white animate-pulse" />
                  <span>Top {status?.activeLimit ?? 50}</span>
                </div>
              </div>

              <div className="relative z-10 my-3 flex items-baseline justify-between gap-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-4xl sm:text-5xl font-extrabold tracking-tight font-mono text-white drop-shadow-sm">
                    {status?.stats.active ?? (loading ? "—" : 0)}
                  </span>
                  {sparkActive.length >= 2 && (
                    <span className="text-xs font-mono font-semibold px-2 py-0.5 rounded-md bg-white/20 border border-white/30 text-white">
                      {sparkActive.at(-1)! - sparkActive.at(-2)! >= 0 ? "+" : ""}
                      {sparkActive.at(-1)! - sparkActive.at(-2)!}
                    </span>
                  )}
                </div>
                {sparkActive.length >= 2 && (
                  <div className="shrink-0 opacity-90">
                    <Sparkline
                      data={sparkActive}
                      color="#FFFFFF"
                      width={96}
                      height={40}
                      label="Active proxies trend"
                    />
                  </div>
                )}
              </div>

              <div className="relative z-10 flex items-center justify-between pt-2 border-t border-white/20 text-xs text-white/85">
                <span className="truncate max-w-[180px] sm:max-w-none">
                  {status ? `Prioritized on 9Router core` : "Active routing target"}
                </span>
                <Link
                  href="/proxies"
                  className="inline-flex items-center gap-1 font-semibold text-white hover:text-white/80 transition-colors group shrink-0"
                >
                  <span>View all proxies</span>
                  <ArrowUpRight className="size-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </Link>
              </div>
            </div>
          </motion.div>

          {/* Card 2: Reserve Proxies */}
          <motion.div variants={itemVariants} className="h-full">
            <MetricCard
              label="Reserve Proxies"
              value={status?.stats.reserve ?? (loading ? "—" : 0)}
              sub="Healthy fallback, slower latency"
              sparkData={sparkReserve}
              sparkColor="#FF8A50"
              icon={<Activity className="size-4 text-[#FF8A50]" />}
              badgeVariant="outline"
              className="h-full"
            />
          </motion.div>

          {/* Card 3: Dead Proxies */}
          <motion.div variants={itemVariants} className="h-full">
            <MetricCard
              label="Dead Proxies"
              value={status?.stats.dead ?? (loading ? "—" : 0)}
              sub="Excluded from active cluster routing"
              sparkData={sparkDead}
              sparkColor="#EF4444"
              icon={<AlertCircle className="size-4 text-red-500" />}
              badgeVariant="destructive"
              className="h-full"
            />
          </motion.div>
        </motion.div>
      )}

      {/* Token Usage & Telemetry Section */}
      <TokenUsageCard />

      {/* 4K / Ultra-wide Control Room Layout: Traffic Analytics on Left, Fleet Operations on Right */}
      <div className="grid grid-cols-1 3xl:grid-cols-12 gap-6 items-start">
        <div className="3xl:col-span-5 5xl:col-span-5 flex flex-col gap-6">
          {/* Traffic & Capacity Chart */}
          <TrafficChart snapshots={metrics} hours={hours} onHoursChange={setHours} />

          {/* Operational Policy & Sync Engine Cards (Placed on telemetry column on 4K) */}
          {/* Operational Policy & Sync Engine Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Pool Routing Policy */}
            <Card className="rounded-2xl border-[#23232C] bg-[#131318] text-white shadow-sm backdrop-blur-md flex flex-col justify-between">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-[#23232C] bg-[#1C1C24] text-[#FF5B22]">
                    <Gauge className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-white">
                    Fleet Routing Policy
                  </CardTitle>
                </div>
                <CardDescription className="text-xs text-zinc-400">
                  Automated multi-tier traffic distribution and failover rules.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2 text-xs text-zinc-300">
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-[#FF5B22] mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-white">Active Tier:</strong> Handles production
                      traffic, dynamically prioritized by low latency.
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-[#FF8A50] mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-white">Reserve Tier:</strong> Verified online
                      endpoints held for the next sync when active routes degrade.
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <span className="size-1.5 rounded-full bg-red-500 mt-1.5 shrink-0" />
                    <span>
                      <strong className="text-white">Dead Isolation:</strong> Unresponsive or
                      high-error proxies quarantined from router rotation.
                    </span>
                  </div>
                </div>
                <div className="pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    asChild
                    className="text-xs h-8 border-[#23232C] bg-[#181820] hover:bg-[#23232C] text-zinc-300 hover:text-white"
                  >
                    <Link href="/proxies">
                      <span>View all proxies</span>
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Sync Engine Status */}
            <Card className="rounded-2xl border-[#23232C] bg-[#131318] text-white shadow-sm backdrop-blur-md flex flex-col justify-between overflow-hidden relative">
              {status?.running && (
                <BorderBeam size={80} duration={3} colorFrom="#FF5B22" colorTo="#FF8A50" />
              )}
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-[#23232C] bg-[#1C1C24] text-[#FF5B22]">
                    <Clock className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-white">
                    Synchronization Engine
                  </CardTitle>
                </div>
                <CardDescription className="text-xs text-zinc-400">
                  Interval ranker and 9Router daemon state synchronization.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-3 rounded-lg bg-[#181820] border border-[#23232C] flex items-center justify-between font-mono text-xs">
                  <span className="text-zinc-400">Last sync</span>
                  <span className="text-white font-semibold">
                    {formatTime(status?.lastSyncAt ?? null)}
                    {status?.running && " (Syncing…)"}
                  </span>
                </div>

                {status?.lastError && (
                  <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-xs font-mono">
                    {status.lastError}
                  </div>
                )}

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-zinc-400 font-mono">
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
                    className="text-xs h-8 px-3 gap-1.5 font-semibold bg-[#FF5B22] hover:bg-[#FF3D00] text-zinc-950 border-0"
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
          <Card className="rounded-2xl border-[#23232C] bg-[#131318] text-white shadow-sm backdrop-blur-xs overflow-hidden">
            <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-[#23232C] pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="flex size-7 items-center justify-center rounded-md border border-[#23232C] bg-[#1C1C24] text-[#FF5B22]">
                    <ShieldCheck className="size-4" />
                  </div>
                  <CardTitle className="text-base font-semibold text-white">
                    Active Proxy Fleet
                  </CardTitle>
                  <Badge
                    variant="outline"
                    className="font-mono text-xs border-[#23232C] text-zinc-400"
                  >
                    Showing {Math.min(pools.length, 8)} of {pools.length} active proxies
                  </Badge>
                </div>
                <CardDescription className="text-xs text-zinc-400 mt-1">
                  Select any route to inspect endpoint verification, measured latency, and egress
                  IP.
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                asChild
                className="h-8 gap-1 text-xs self-start sm:self-auto border-[#23232C] bg-[#181820] hover:bg-[#23232C] text-zinc-300 hover:text-white"
              >
                <Link href="/proxies">
                  <span>View all proxies</span>
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
                <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-[#23232C]">
                  {/* Table list */}
                  <div className="lg:col-span-2 overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-[#181820]/80">
                        <TableRow className="border-[#23232C] hover:bg-transparent">
                          <TableHead className="text-xs font-mono w-12">#</TableHead>
                          <TableHead className="text-xs">Proxy</TableHead>
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
                                "cursor-pointer border-[#23232C]/60 transition-colors",
                                isSelected
                                  ? "bg-[#FF5B22]/15 hover:bg-[#FF5B22]/20 font-medium"
                                  : "hover:bg-[#181820]",
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
                  <div className="p-5 lg:col-span-1 bg-[#181820]/30 flex flex-col justify-between space-y-4">
                    {selectedPool ? (
                      <div className="space-y-4">
                        <div className="flex items-center justify-between pb-2 border-b border-[#23232C]">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-[#FF5B22] font-semibold">
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
                          <div className="p-2.5 rounded-lg bg-[#181820] border border-[#23232C]">
                            <span className="text-[10px] text-zinc-400 block uppercase">
                              Exit IP
                            </span>
                            <span className="text-xs font-semibold text-zinc-200 mt-0.5 block truncate">
                              {selectedPool.exit_ip || "Unavailable"}
                            </span>
                          </div>
                          <div className="p-2.5 rounded-lg bg-[#181820] border border-[#23232C] col-span-2">
                            <span className="text-[10px] text-zinc-400 block uppercase">
                              Check Results
                            </span>
                            <span className="text-xs font-semibold text-white mt-0.5 block">
                              {selectedPool.successes} passed · {selectedPool.failures} failed
                            </span>
                          </div>
                        </div>

                        {selectedPool.last_error && (
                          <div className="p-2.5 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-xs font-mono">
                            <span className="font-semibold block mb-0.5">
                              Most Recent Recorded Error:
                            </span>
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

                    <div className="pt-3 border-t border-[#23232C]">
                      <Button
                        variant="outline"
                        size="sm"
                        asChild
                        className="w-full text-xs h-8 border-[#23232C] bg-[#181820] hover:bg-[#23232C] text-zinc-300 hover:text-white"
                      >
                        <Link href="/proxies">
                          <span>View all proxies</span>
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
