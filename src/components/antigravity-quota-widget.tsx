"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gauge, RotateCw, Clock, Cpu, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { useAuth } from "./auth-provider";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { fetchAntigravityStatus, refreshAntigravityQuota } from "@/lib/api";
import type { AntigravityRotatorSnapshot, AntigravityAccountState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isAbortError } from "@/lib/request-lifecycle";

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

export function AntigravityQuotaWidget() {
  const { password, authenticated } = useAuth();
  const { state: sidebarState, setOpen: setSidebarOpen } = useSidebar();
  const [snapshot, setSnapshot] = useState<AntigravityRotatorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const lastManualRefreshAtRef = useRef<number>(0);
  const panelId = React.useId();
  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!password && !authenticated) return;
      if (signal?.aborted) return;
      const startedAt = Date.now();
      setLoading(true);
      try {
        const data = await fetchAntigravityStatus(password, signal);
        if (signal?.aborted) return;
        if (startedAt < lastManualRefreshAtRef.current) return;
        if (data) {
          setSnapshot(data);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        if (startedAt < lastManualRefreshAtRef.current) return;
        setUnavailable(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [password, authenticated],
  );
  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isOpen]);

  // Live countdown ticker to prevent stale countdown display when panel stays open
  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 10_000);
    return () => clearInterval(interval);
  }, [isOpen]);
  useEffect(() => {
    if (!password && !authenticated) return;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;

    void loadStatus(controller.signal);

    const interval = setInterval(() => {
      if (!controller.signal.aborted) {
        void loadStatus(controller.signal);
      }
    }, 30_000);

    return () => {
      clearInterval(interval);
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [loadStatus, password, authenticated]);

  const handleRefresh = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    lastManualRefreshAtRef.current = Date.now();
    try {
      const res = await refreshAntigravityQuota(password);
      lastManualRefreshAtRef.current = Date.now();
      if (res.snapshot) {
        setSnapshot(res.snapshot);
        setUnavailable(false);
      } else {
        await loadStatus();
      }
      toast.success("Antigravity quotas refreshed");
    } catch (err) {
      setUnavailable(true);
      toast.error((err as Error).message || "Failed to refresh quotas");
    } finally {
      setRefreshing(false);
    }
  };

  const handleToggle = () => {
    if (sidebarState === "collapsed") {
      setSidebarOpen(true);
      setIsOpen(true);
    } else {
      setIsOpen((prev) => !prev);
    }
  };

  const handleMouseEnter = () => {
    if (sidebarState === "collapsed") return;
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setIsOpen(true);
    }, 180);
  };

  const handleMouseLeave = () => {
    clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
    }, 220);
  };

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const activeAccounts = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.accounts.filter((a) => a.isActive);
  }, [snapshot]);

  const totalQuota = snapshot?.totalSessionQuotaPercentage;
  const maxQuota =
    snapshot?.maxPossiblePercentage || (snapshot?.totalAccounts ? snapshot.totalAccounts * 100 : 0);
  const overallRatio =
    totalQuota !== undefined && maxQuota > 0
      ? Math.min(100, Math.max(0, (totalQuota / maxQuota) * 100))
      : null;
  const overallColors = quotaColor(overallRatio ?? 50);
  const quotaLabel = snapshot
    ? unavailable
      ? `${totalQuota}% (stale)`
      : `${totalQuota}%`
    : loading
      ? "Loading"
      : unavailable
        ? "Unavailable"
        : "Unknown";

  return (
    <div
      ref={containerRef}
      className="relative w-full rounded-xl border border-[#23232C] bg-[#131318]/90 group-data-[collapsible=icon]:w-auto group-data-[collapsible=icon]:border-none group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
      data-quota-widget
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Trigger Header */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            onClick={handleToggle}
            className={cn(
              "min-h-11 h-auto w-full p-2 flex flex-col items-stretch text-left justify-start transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5B22] focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar whitespace-normal rounded-xl",
              "group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:min-h-9! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:flex-row",
              isOpen && sidebarState !== "collapsed" ? "bg-[#181820]" : "hover:bg-[#181820]/70",
            )}
            aria-expanded={isOpen}
            aria-controls={panelId}
          >
            <div className="flex items-center justify-between mb-1.5 w-full group-data-[collapsible=icon]:mb-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:w-auto">
              <div className="flex items-center gap-1.5 min-w-0">
                <Gauge
                  className={cn(
                    "size-3.5 group-data-[collapsible=icon]:size-4 shrink-0 transition-colors",
                    overallRatio === null ? "text-muted-foreground" : overallColors.text,
                  )}
                />
                <span className="text-[11px] font-semibold text-sidebar-foreground truncate tracking-tight group-data-[collapsible=icon]:hidden">
                  Antigravity quota
                </span>
              </div>
              <div className="flex items-center gap-1 shrink-0 group-data-[collapsible=icon]:hidden">
                <span className="text-[11px] font-mono font-bold text-ink">
                  {quotaLabel}{" "}
                  {snapshot && (
                    <span className="text-[10px] text-muted-foreground font-normal">
                      / {maxQuota}%
                    </span>
                  )}
                </span>
                {isOpen ? (
                  <ChevronUp className="size-3 text-muted-foreground group-hover:text-ink transition-colors ml-0.5" />
                ) : (
                  <ChevronDown className="size-3 text-muted-foreground group-hover:text-ink transition-colors ml-0.5" />
                )}
              </div>
            </div>

            {/* Micro Progress Bar with Accessible Semantics */}
            <div
              role="progressbar"
              aria-valuenow={overallRatio !== null ? Math.round(overallRatio) : 0}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Antigravity quota capacity: ${overallRatio !== null ? Math.round(overallRatio) : 0}%`}
              className="w-full h-1.5 rounded-full bg-surface-raised overflow-hidden group-data-[collapsible=icon]:hidden"
            >
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  overallRatio === null ? "bg-muted-foreground/40" : overallColors.bar,
                )}
                style={{ width: `${overallRatio ?? 0}%` }}
              />
            </div>

            <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground font-mono w-full group-data-[collapsible=icon]:hidden">
              <span>
                {snapshot
                  ? unavailable
                    ? `${snapshot.totalAccounts} accounts (stale)`
                    : `${snapshot.totalAccounts} accounts`
                  : unavailable
                    ? "Unavailable"
                    : loading
                      ? "Loading quota"
                      : "Unknown"}
              </span>
              <span className="text-emerald-400 font-medium">
                {snapshot ? `${activeAccounts.length} active` : "—"}
              </span>
            </div>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" hidden={sidebarState !== "collapsed"}>
          <div className="font-semibold text-xs">Antigravity Quota</div>
          <div className="text-[10px] text-muted-foreground">
            {quotaLabel} / {maxQuota}% · {activeAccounts.length} active
          </div>
        </TooltipContent>
      </Tooltip>

      {/* Upward Drop-up Accounts Section (strictly bounded inside sidebar width) */}
      <AnimatePresence>
        {isOpen && sidebarState !== "collapsed" && (
          <motion.div
            id={panelId}
            initial={{ opacity: 0, y: 8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 350, damping: 28 }}
            className="absolute bottom-full left-0 right-0 mb-2 w-full z-50 rounded-xl border border-[#23232C] bg-[#131318]/98 backdrop-blur-md p-2.5 shadow-2xl space-y-2 text-xs"
            role="region"
            aria-label="Antigravity active accounts detail"
          >
            <div className="flex items-center justify-between pb-1 border-b border-[#23232C]">
              <div className="flex items-center gap-1.5 text-[11px] text-sidebar-foreground font-medium">
                <Cpu className="size-3 text-[#FF5B22]" />
                <span>
                  Active ({activeAccounts.length}/{snapshot?.totalAccounts ?? 0})
                </span>
                {unavailable && snapshot && (
                  <span className="text-[9px] text-[#FF5B22] font-mono px-1 py-0.2 rounded bg-[#FF5B22]/10 border border-[#FF5B22]/20">
                    cached
                  </span>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleRefresh}
                disabled={refreshing || (!password && !authenticated)}
                aria-busy={refreshing}
                aria-label={refreshing ? "Refreshing quotas" : "Refresh quotas now"}
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                title="Refresh quotas now"
              >
                <RotateCw
                  className={cn("size-2.5 mr-1", refreshing && "animate-spin text-[#FF5B22]")}
                />
                <span>{refreshing ? "Checking…" : "Refresh"}</span>
              </Button>
            </div>

            <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5 scrollbar-thin">
              {!snapshot ? (
                <div className="py-2 text-center text-[11px] text-muted-foreground">
                  {loading ? "Loading active accounts…" : "Data unavailable."}
                </div>
              ) : activeAccounts.length === 0 ? (
                <div className="py-2 text-center text-[11px] text-muted-foreground">
                  No active accounts running.
                </div>
              ) : (
                activeAccounts.map((acc) => {
                  const sessionColors = quotaColor(acc.sessionPercentage);
                  const emailPrefix = acc.email.split("@")[0] || acc.email;

                  return (
                    <div
                      key={acc.id}
                      className="p-1.5 rounded-md border border-[#23232C] bg-[#09090C]/60 hover:bg-[#09090C] transition-colors space-y-1"
                    >
                      <div className="flex items-center justify-between gap-1 min-w-0">
                        <span
                          className="truncate text-[11px] font-medium text-sidebar-foreground font-mono"
                          title={acc.email}
                        >
                          {emailPrefix}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground/80 flex items-center gap-0.5 font-mono">
                          <Clock className="size-2.5" />
                          {formatCountdown(acc.resetAt)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-1 text-[10px]">
                        <div className="flex items-center gap-1 font-mono">
                          <span
                            className={cn(
                              "px-1 py-0.5 leading-none rounded font-semibold border",
                              sessionColors.bg,
                              sessionColors.text,
                              sessionColors.border,
                            )}
                            title="Session Quota"
                          >
                            {Number.isFinite(acc.sessionPercentage)
                              ? `${acc.sessionPercentage.toFixed(0)}%`
                              : "—"}
                          </span>
                          <span
                            className="text-muted-foreground text-[9px]"
                            title="Weekly Quota (informational)"
                          >
                            W:
                            {Number.isFinite(acc.weeklyPercentage)
                              ? `${acc.weeklyPercentage.toFixed(0)}%`
                              : "—"}
                          </span>
                        </div>

                        <div
                          className="flex items-center gap-1 px-1 py-0.5 leading-none rounded bg-surface-raised border border-border/50 text-[9px] font-mono text-muted-foreground truncate max-w-[90px]"
                          title={acc.proxyName ? `Proxy: ${acc.proxyName}` : "Direct connection"}
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full shrink-0",
                              acc.proxyHealthy ? "bg-emerald-500" : "bg-rose-500",
                            )}
                          />
                          <span className="truncate">{acc.proxyName || "Direct"}</span>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
