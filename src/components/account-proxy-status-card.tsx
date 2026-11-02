"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import {
  ShieldCheck,
  Shuffle,
  RefreshCw,
  Clock,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  ArrowUpRight,
  Server,
  Layers,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import {
  fetchAntigravityStatus,
  fetchSettings,
  fetchPools,
  refreshAntigravityQuota,
} from "@/lib/api";
import type { AntigravityAccountState, AntigravityRotatorSnapshot, PoolRecord } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { LatencyIndicator } from "@/components/proxies/latency-indicator";
import { cn, formatProxyAddress } from "@/lib/utils";

function formatCountdown(resetAt: string | null): string {
  if (!resetAt) return "No reset info";
  const diffMs = new Date(resetAt).getTime() - Date.now();
  if (diffMs <= 0) return "Resetting soon";
  const mins = Math.floor(diffMs / 60_000);
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours > 0) {
    return `Reset in ${hours}h ${remMins}m`;
  }
  return `Reset in ${remMins}m`;
}

function quotaColor(percentage: number): { text: string; bg: string; border: string; bar: string } {
  if (percentage > 50) {
    return {
      text: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
      bar: "bg-emerald-500",
    };
  }
  if (percentage > 20) {
    return {
      text: "text-[#FF5B22]",
      bg: "bg-[#FF5B22]/10",
      border: "border-[#FF5B22]/25",
      bar: "bg-[#FF5B22]",
    };
  }
  return {
    text: "text-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/20",
    bar: "bg-rose-500",
  };
}

interface AccountProxyStatusCardProps {
  className?: string;
}

export function AccountProxyStatusCard({ className }: AccountProxyStatusCardProps) {
  const { password, authenticated } = useAuth();
  const canRead = authenticated || Boolean(password);

  const [snapshot, setSnapshot] = useState<AntigravityRotatorSnapshot | null>(null);
  const [pools, setPools] = useState<PoolRecord[]>([]);
  const [activeLimit, setActiveLimit] = useState<number | null>(null);
  const [sessionThreshold, setSessionThreshold] = useState(20);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterView, setFilterView] = useState<"active" | "all">("active");

  const inFlightRef = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);

  const loadData = useCallback(
    async (isManual = false) => {
      if (!canRead) {
        setLoading(false);
        return;
      }

      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
      const controller = new AbortController();
      inFlightRef.current = controller;

      if (isManual) {
        setRefreshing(true);
      } else if (!hasLoadedRef.current) {
        setLoading(true);
      }
      setError(null);

      try {
        const [snapRes, settingsRes, poolsRes] = await Promise.all([
          fetchAntigravityStatus(password || undefined, controller.signal).catch(() => null),
          fetchSettings(password || undefined, controller.signal).catch(() => null),
          fetchPools(password || undefined, undefined, controller.signal).catch(() => []),
        ]);

        if (controller.signal.aborted) return;

        if (snapRes) {
          setSnapshot(snapRes);
        }
        hasLoadedRef.current = true;
        const settings = settingsRes?.settings;
        if (settings) {
          if (typeof settings.antigravityActiveLimit === "number") {
            setActiveLimit(settings.antigravityActiveLimit);
          } else if (snapRes?.activeCount) {
            setActiveLimit(snapRes.activeCount);
          }
          if (typeof settings.antigravitySessionThreshold === "number") {
            setSessionThreshold(settings.antigravitySessionThreshold);
          }
        } else if (snapRes?.activeCount) {
          setActiveLimit(snapRes.activeCount);
        }
        if (Array.isArray(poolsRes)) {
          setPools(poolsRes);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load account and proxy status");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [canRead, password],
  );

  useEffect(() => {
    void loadData();
    const timer = setInterval(() => {
      void loadData();
    }, 15_000);
    return () => {
      clearInterval(timer);
      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
    };
  }, [loadData]);

  const handleManualRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshAntigravityQuota(password || undefined).catch(() => null);
      await loadData(true);
      toast.success("Account quotas & proxy telemetry refreshed");
    } catch (err) {
      toast.error((err as Error).message);
      setRefreshing(false);
    }
  };

  const poolMap = useMemo(() => {
    const map = new Map<string, PoolRecord>();
    for (const pool of pools) {
      if (pool.localId) map.set(pool.localId, pool);
      if (pool.remoteId) map.set(pool.remoteId, pool);
      if (pool.name) map.set(pool.name, pool);
    }
    return map;
  }, [pools]);

  const accounts = useMemo(() => {
    const list = snapshot?.accounts ?? [];
    if (filterView === "active") {
      return list.filter((a) => a.isActive);
    }
    // "all": active accounts first, then reserve accounts
    return [...list].sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return b.sessionPercentage - a.sessionPercentage;
    });
  }, [snapshot, filterView]);

  const activeAccountsCount = useMemo(
    () => (snapshot?.accounts ?? []).filter((a) => a.isActive).length,
    [snapshot],
  );

  return (
    <Card
      className={cn(
        "rounded-2xl border border-[#23232C] bg-[#131318] shadow-sm overflow-hidden",
        className,
      )}
    >
      <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-[#23232C] p-5 pb-4 bg-[#0F0F13]">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30">
              <Shuffle className="size-3.5" />
            </span>
            <CardTitle className="text-base font-bold text-zinc-100">
              Account &amp; Proxy Status
            </CardTitle>
            <Badge
              variant="outline"
              className="font-mono text-xs border-[#23232C] bg-[#181820] text-zinc-300"
            >
              Active:{" "}
              <strong className="text-emerald-400 font-bold ml-1">{activeAccountsCount}</strong> /{" "}
              {activeLimit ?? activeAccountsCount}
            </Badge>
            <Badge
              variant="outline"
              className="font-mono text-[11px] border-[#FF5B22]/40 bg-[#FF5B22]/15 text-orange-200 font-semibold hidden sm:inline-flex"
            >
              Rotate threshold: &le; {sessionThreshold}%
            </Badge>
          </div>
          <CardDescription className="text-xs text-zinc-400">
            Active Antigravity accounts running under activeLimit with linked proxy latency and
            auto-rotation states.
          </CardDescription>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto flex-wrap">
          {/* Toggle Active / All filter */}
          <div className="flex items-center bg-[#181820] border border-[#23232C] rounded-lg p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFilterView("active")}
              className={cn(
                "px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer",
                filterView === "active"
                  ? "bg-[#FF5B22] text-black font-extrabold shadow-xs"
                  : "text-zinc-300 hover:text-zinc-100",
              )}
            >
              Active ({activeAccountsCount})
            </button>
            <button
              type="button"
              onClick={() => setFilterView("all")}
              className={cn(
                "px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer",
                filterView === "all"
                  ? "bg-[#FF5B22] text-black font-extrabold shadow-xs"
                  : "text-zinc-300 hover:text-zinc-100",
              )}
            >
              All ({snapshot?.totalAccounts ?? snapshot?.accounts?.length ?? 0})
            </button>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleManualRefresh}
            disabled={loading || refreshing}
            className="h-8 border-[#23232C] bg-[#181820] hover:bg-[#23232C] text-zinc-100 hover:text-white text-xs gap-1.5 disabled:opacity-90 disabled:text-zinc-200"
          >
            <RefreshCw className={cn("size-3", refreshing && "animate-spin text-[#FF5B22]")} />
            <span>Refresh</span>
          </Button>

          <Button
            asChild
            size="sm"
            className="h-8 bg-gradient-to-r from-[#FF5B22] to-[#FF3D00] hover:brightness-110 text-white text-xs font-semibold shadow-xs shadow-[#FF5B22]/20 border-0 gap-1"
          >
            <Link href="/bindings">
              <span>Manage Bindings</span>
              <ArrowUpRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {loading && !snapshot ? (
          <div className="p-6 space-y-3">
            <Skeleton className="h-10 w-full bg-[#181820]" />
            <Skeleton className="h-10 w-full bg-[#181820]" />
            <Skeleton className="h-10 w-full bg-[#181820]" />
          </div>
        ) : error && accounts.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <AlertCircle className="size-8 text-rose-400 mx-auto opacity-80" />
            <p className="text-sm font-semibold text-zinc-200">{error}</p>
            <p className="text-xs text-zinc-400 max-w-sm mx-auto">
              Please check 9Router connection in Settings or trigger a manual refresh.
            </p>
          </div>
        ) : accounts.length === 0 ? (
          <div className="py-12 text-center text-zinc-400 space-y-2">
            <Layers className="size-8 mx-auto opacity-40 text-[#FF5B22]" />
            <p className="text-sm font-semibold text-zinc-200">
              {filterView === "active" ? "No active Antigravity accounts" : "No accounts found"}
            </p>
            <p className="text-xs text-zinc-400 max-w-md mx-auto">
              Go to Bindings to connect Antigravity OAuth accounts and map them to proxy pools.
            </p>
            <div className="pt-2">
              <Button
                asChild
                size="sm"
                variant="outline"
                className="h-8 text-xs border-[#23232C] bg-[#181820]"
              >
                <Link href="/bindings">Configure in Bindings</Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-[#0F0F13]/90">
                <TableRow className="border-[#23232C] hover:bg-transparent">
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3 pl-5">
                    Identity / Account
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3">
                    Gemini Session Quota
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3">
                    Assigned Proxy
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3">
                    Latency
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3">
                    Proxy Health
                  </TableHead>
                  <TableHead className="text-xs font-semibold text-zinc-400 py-3 pr-5 text-right">
                    Rotation Status
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((acc) => {
                  const colors = quotaColor(acc.sessionPercentage);
                  const isScheduledRotate =
                    acc.isActive && acc.sessionPercentage <= sessionThreshold;
                  const pool = acc.proxyPoolId ? poolMap.get(acc.proxyPoolId) : null;
                  const latency = pool?.latency_ms ?? null;
                  const proxyDisplay = pool?.proxyUrl
                    ? formatProxyAddress(pool.proxyUrl)
                    : acc.proxyName || (acc.proxyPoolId ? `Pool #${acc.proxyPoolId}` : "None");

                  return (
                    <TableRow
                      key={acc.id}
                      className={cn(
                        "border-[#23232C]/70 transition-colors",
                        acc.isActive
                          ? "hover:bg-[#181820]"
                          : "opacity-70 hover:opacity-100 hover:bg-[#181820]/50",
                      )}
                    >
                      {/* Identity */}
                      <TableCell className="py-3 pl-5">
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5 truncate max-w-[220px]">
                            {acc.name || acc.email || acc.id}
                          </span>
                          <span className="text-[11px] font-mono text-zinc-400 truncate max-w-[220px]">
                            {acc.email || acc.id}
                          </span>
                        </div>
                      </TableCell>

                      {/* Quota Progress */}
                      <TableCell className="py-3 min-w-[180px]">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs font-mono">
                            <span className={cn("font-bold text-xs", colors.text)}>
                              {acc.sessionPercentage}%
                            </span>
                            <span className="text-[10px] text-zinc-400 flex items-center gap-1">
                              <Clock className="size-2.5 text-zinc-500" />
                              {formatCountdown(acc.resetAt)}
                            </span>
                          </div>
                          <div
                            role="progressbar"
                            aria-valuenow={acc.sessionPercentage}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`Gemini session quota: ${acc.sessionPercentage}% remaining`}
                            className="h-1.5 w-full bg-[#181820] rounded-full overflow-hidden border border-[#23232C]"
                          >
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-300",
                                colors.bar,
                              )}
                              style={{
                                width: `${Math.min(100, Math.max(0, acc.sessionPercentage))}%`,
                              }}
                            />
                          </div>
                        </div>
                      </TableCell>

                      {/* Assigned Proxy */}
                      <TableCell className="py-3">
                        {acc.proxyPoolId ? (
                          <div className="flex flex-col gap-0.5">
                            <span className="text-xs font-mono text-zinc-200 font-medium truncate max-w-[160px]">
                              {proxyDisplay}
                            </span>
                            {pool?.exit_ip && (
                              <span className="text-[10px] font-mono text-zinc-400 truncate">
                                Exit: {pool.exit_ip}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-zinc-500 italic">No proxy bound</span>
                        )}
                      </TableCell>

                      {/* Latency */}
                      <TableCell className="py-3">
                        {latency != null ? (
                          <LatencyIndicator latencyMs={latency} showBar={false} />
                        ) : pool ? (
                          <span className="text-xs font-mono text-zinc-400">Measured soon</span>
                        ) : (
                          <span className="text-xs font-mono text-zinc-600">—</span>
                        )}
                      </TableCell>

                      {/* Proxy Health */}
                      <TableCell className="py-3">
                        {acc.proxyPoolId ? (
                          acc.proxyHealthy ? (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400 text-[10px] font-mono gap-1 py-0 px-1.5"
                            >
                              <span className="size-1 rounded-full bg-emerald-400" />
                              Working
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-rose-500/30 bg-rose-500/10 text-rose-400 text-[10px] font-mono gap-1 py-0 px-1.5"
                            >
                              <span className="size-1 rounded-full bg-rose-500" />
                              Dead
                            </Badge>
                          )
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-amber-500/30 bg-amber-500/10 text-amber-400 text-[10px] font-mono py-0 px-1.5"
                          >
                            Unbound
                          </Badge>
                        )}
                      </TableCell>

                      {/* Rotation Status */}
                      <TableCell className="py-3 pr-5 text-right">
                        {acc.isActive ? (
                          isScheduledRotate ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  className="inline-flex cursor-help rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5B22] p-0 bg-transparent border-0"
                                  aria-label={`Scheduled Rotate: Quota is ${acc.sessionPercentage}%, at or below ${sessionThreshold}% threshold`}
                                >
                                  <Badge
                                    variant="outline"
                                    className="border-amber-500/40 bg-amber-500/15 text-amber-300 text-[10px] font-semibold gap-1 py-0.5 px-2"
                                  >
                                    <AlertTriangle className="size-2.5 text-amber-400" />
                                    Scheduled Rotate
                                  </Badge>
                                </button>
                              </TooltipTrigger>
                              <TooltipContent className="bg-[#1C1C24] text-xs text-zinc-200 border-[#23232C]">
                                Quota &le; {sessionThreshold}%. Will be rotated out to reserve on
                                next maintenance cycle.
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/40 bg-emerald-500/15 text-emerald-300 text-[10px] font-semibold gap-1.5 py-0.5 px-2"
                            >
                              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                              Active
                            </Badge>
                          )
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-zinc-700 bg-zinc-800/60 text-zinc-400 text-[10px] font-medium py-0.5 px-2"
                          >
                            Reserve
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
