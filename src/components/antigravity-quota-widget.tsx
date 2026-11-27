"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCw, Clock, Cpu, ChevronDown, ChevronUp } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { RotationFlame } from "@/components/rotation-flame";
import { useAuth } from "./auth-provider";
import { Button } from "@/components/ui/button";
import { Gauge as DitherGauge } from "@/components/dithercn/gauge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSidebar } from "@/components/ui/sidebar";
import { fetchAntigravityStatus, refreshAntigravityQuota } from "@/lib/api";
import { PROVIDER_LABEL, type AntigravityRotatorSnapshot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { isAbortError } from "@/lib/request-lifecycle";
import { formatCountdown } from "@/lib/countdown";

function quotaColor(percentage: number): {
  text: string;
  bg: string;
  border: string;
  dither: "green" | "--primary" | "red";
} {
  if (percentage > 50) {
    return {
      text: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
      dither: "green",
    };
  }
  if (percentage > 20) {
    return {
      text: "text-[#FF5B22]",
      bg: "bg-[#FF5B22]/10",
      border: "border-[#FF5B22]/25",
      dither: "--primary",
    };
  }
  return {
    text: "text-rose-400",
    bg: "bg-rose-500/10",
    border: "border-rose-500/20",
    dither: "red",
  };
}

interface AccountQuota {
  snapshot: AntigravityRotatorSnapshot | null;
  loading: boolean;
  unavailable: boolean;
  error: string | null;
  refreshing: boolean;
  canRefresh: boolean;
  refresh: () => Promise<void>;
  acceptAccountSnapshot: (snapshot: AntigravityRotatorSnapshot) => void;
}

const QUOTA_UNAVAILABLE_ERROR = "Unable to load a fresh account quota snapshot.";
const AccountQuotaContext = React.createContext<AccountQuota | null>(null);

function useAccountQuotaState(): AccountQuota {
  const { password, authenticated } = useAuth();
  const canRead = Boolean(password || authenticated);
  const [snapshot, setSnapshot] = useState<AntigravityRotatorSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const snapshotRef = useRef<AntigravityRotatorSnapshot | null>(null);
  const refreshFailureRunAtRef = useRef<number | null | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);
  const requestSequenceRef = useRef(0);
  const refreshingRef = useRef(false);
  const seenRotationAt = useRef<number | undefined>(undefined);

  const loadStatus = useCallback(
    async (mode: "poll" | "manual" = "poll"): Promise<AntigravityRotatorSnapshot | null> => {
      if (!canRead || (mode === "poll" && refreshingRef.current)) return null;
      if (mode === "poll" && document.visibilityState !== "visible") return null;

      const sequence = ++requestSequenceRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);

      try {
        const data = await fetchAntigravityStatus(password, controller.signal);
        if (controller.signal.aborted || sequence !== requestSequenceRef.current) return null;
        if (!data) {
          setUnavailable(true);
          setError(QUOTA_UNAVAILABLE_ERROR);
          return null;
        }
        if (mode === "manual") return data;
        snapshotRef.current = data;
        setSnapshot(data);
        const failedRunAt = refreshFailureRunAtRef.current;
        if (
          failedRunAt === undefined ||
          (data.lastRunAt !== null && data.lastRunAt > (failedRunAt ?? 0))
        ) {
          refreshFailureRunAtRef.current = undefined;
          setUnavailable(false);
          setError(null);
        }
        return data;
      } catch (err) {
        if (
          controller.signal.aborted ||
          sequence !== requestSequenceRef.current ||
          isAbortError(err)
        ) {
          return null;
        }
        setUnavailable(true);
        setError(err instanceof Error ? err.message : QUOTA_UNAVAILABLE_ERROR);
        return null;
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setLoading(false);
        }
      }
    },
    [canRead, password],
  );

  useEffect(() => {
    if (!canRead) {
      requestSequenceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
      seenRotationAt.current = undefined;
      snapshotRef.current = null;
      refreshFailureRunAtRef.current = undefined;
      setSnapshot(null);
      setUnavailable(false);
      setError(null);
      setLoading(false);
      return;
    }

    const poll = () => {
      if (document.visibilityState === "visible") void loadStatus("poll");
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") poll();
    };
    const initialPoll = window.setTimeout(poll, 0);
    const interval = window.setInterval(poll, 30_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearTimeout(initialPoll);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      requestSequenceRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [canRead, loadStatus]);

  useEffect(() => {
    if (!snapshot) return;

    const rotationAt = snapshot.lastRotationAt ?? 0;
    const previous = seenRotationAt.current;
    if (previous !== undefined && rotationAt <= previous) return;
    seenRotationAt.current = rotationAt;
    if (previous === undefined) return;

    toast.success("Account rotation complete", {
      className: "overflow-hidden",
      style: { paddingBottom: 24 },
      description: <RotationFlame />,
    });
  }, [snapshot]);

  const refresh = useCallback(async () => {
    if (!canRead || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    let sequence = requestSequenceRef.current;

    const previousRotationAt = seenRotationAt.current;
    const previousRunAt = snapshotRef.current?.lastRunAt;
    try {
      const response = await refreshAntigravityQuota(password);
      if (sequence !== requestSequenceRef.current) return;
      if (!response.started) {
        throw new Error("Antigravity quota refresh did not start.");
      }

      let nextSnapshot = response.snapshot;
      if (!nextSnapshot) {
        sequence += 1;
        nextSnapshot = (await loadStatus("manual")) ?? undefined;
        if (sequence !== requestSequenceRef.current) return;
      }
      if (
        !nextSnapshot ||
        nextSnapshot.lastRunAt === null ||
        (previousRunAt != null && nextSnapshot.lastRunAt <= previousRunAt)
      ) {
        throw new Error(QUOTA_UNAVAILABLE_ERROR);
      }
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      refreshFailureRunAtRef.current = undefined;
      setUnavailable(false);
      setError(null);

      const rotated =
        previousRotationAt !== undefined && (nextSnapshot.lastRotationAt ?? 0) > previousRotationAt;
      if (nextSnapshot.degraded) {
        toast.warning("Account quota refresh incomplete", {
          description: nextSnapshot.error ?? undefined,
        });
      } else if (!rotated) {
        toast.success("Account quotas refreshed");
      }
    } catch (err) {
      if (sequence !== requestSequenceRef.current) return;
      refreshFailureRunAtRef.current = snapshotRef.current?.lastRunAt ?? null;
      const message = err instanceof Error ? err.message : QUOTA_UNAVAILABLE_ERROR;
      setUnavailable(true);
      setError(message);
      toast.error(message);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [canRead, loadStatus, password]);

  const acceptAccountSnapshot = useCallback((next: AntigravityRotatorSnapshot) => {
    requestSequenceRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    snapshotRef.current = next;
    setSnapshot(next);
    setLoading(false);
  }, []);

  return {
    snapshot,
    loading,
    unavailable,
    error,
    refreshing,
    canRefresh: canRead,
    refresh,
    acceptAccountSnapshot,
  };
}

export function AccountQuotaProvider({ children }: { children: React.ReactNode }) {
  const quota = useAccountQuotaState();
  return <AccountQuotaContext.Provider value={quota}>{children}</AccountQuotaContext.Provider>;
}

export function useAccountQuota(): AccountQuota {
  const quota = React.useContext(AccountQuotaContext);
  if (!quota) throw new Error("useAccountQuota must be used within AccountQuotaProvider.");
  return quota;
}

export function AntigravityQuotaWidget({
  snapshot,
  loading,
  unavailable,
  refreshing,
  canRefresh,
  refresh,
}: AccountQuota) {
  const { state: sidebarState, setOpen: setSidebarOpen } = useSidebar();

  const [isOpen, setIsOpen] = useState(false);
  const [, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const panelId = React.useId();
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

  useEffect(() => {
    if (!isOpen) return;
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 10_000);
    return () => clearInterval(interval);
  }, [isOpen]);
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
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="plain"
            onClick={handleToggle}
            className={cn(
              "min-h-11 h-auto w-full p-2 flex flex-col items-stretch text-left justify-start transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#FF5B22] focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar whitespace-normal rounded-xl",
              "group-data-[collapsible=icon]:size-9! group-data-[collapsible=icon]:min-h-9! group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:flex-row",
              isOpen && sidebarState !== "collapsed" ? "bg-[#181820]" : "hover:bg-[#181820]/70",
            )}
            aria-expanded={isOpen}
            aria-controls={panelId}
            aria-label={`Account quota ${quotaLabel} / ${maxQuota}% · ${snapshot?.totalAccounts ?? 0} accounts · ${activeAccounts.length} active`}
          >
            <div className="flex w-full items-center gap-3 group-data-[collapsible=icon]:w-auto group-data-[collapsible=icon]:justify-center">
              <DitherGauge
                value={totalQuota ?? 0}
                min={0}
                max={maxQuota}
                label="Account quota"
                unit="%"
                variant="half"
                size={sidebarState === "collapsed" ? 32 : 64}
                segments={16}
                showRange={false}
                color={overallRatio === null ? "grey" : overallColors.dither}
                fill="dotted"
                animate={false}
                aria-hidden="true"
                className="shrink-0 [&_span]:hidden [&_svg]:!h-auto [&_svg]:!w-full"
              />
              <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-semibold text-sidebar-foreground truncate tracking-tight">
                    Account quota
                  </span>
                  {isOpen ? (
                    <ChevronUp className="size-3 text-muted-foreground group-hover:text-ink transition-colors shrink-0" />
                  ) : (
                    <ChevronDown className="size-3 text-muted-foreground group-hover:text-ink transition-colors shrink-0" />
                  )}
                </div>
                <div className="text-[10px] font-mono font-bold text-ink tabular-nums">
                  {quotaLabel}{" "}
                  {snapshot && (
                    <span className="text-muted-foreground font-normal">/ {maxQuota}%</span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
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
              </div>
            </div>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="right" align="center" hidden={sidebarState !== "collapsed"}>
          <div className="font-semibold text-xs">Account Quota</div>
          <div className="text-[10px] text-muted-foreground">
            {quotaLabel} / {maxQuota}% · {activeAccounts.length} active
          </div>
        </TooltipContent>
      </Tooltip>

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
            aria-label="Active accounts detail by provider"
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
                onClick={(event) => {
                  event.stopPropagation();
                  void refresh();
                }}
                disabled={refreshing || !canRefresh}
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
                          <span className="text-[9px] text-muted-foreground mr-1">
                            {PROVIDER_LABEL[acc.provider ?? "antigravity"]}
                          </span>
                          {emailPrefix}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground/80 flex items-center gap-0.5 font-mono">
                          <Clock className="size-2.5" />
                          {formatCountdown(acc.resetAt, Date.now(), "Reset in ")}
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
                            {acc.quotaAvailable !== false && Number.isFinite(acc.sessionPercentage)
                              ? `${acc.sessionPercentage.toFixed(0)}%`
                              : "—"}
                          </span>
                          {acc.provider !== "codex" && (
                            <span
                              className="text-muted-foreground text-[9px]"
                              title="Weekly Quota (informational)"
                            >
                              W:
                              {Number.isFinite(acc.weeklyPercentage)
                                ? `${acc.weeklyPercentage.toFixed(0)}%`
                                : "—"}
                            </span>
                          )}
                        </div>

                        <div
                          className="flex items-center gap-1 px-1 py-0.5 leading-none rounded bg-surface-raised border border-border/50 text-[9px] font-mono text-muted-foreground truncate"
                          title={
                            acc.thresholdPercentage != null
                              ? `Threshold: ${acc.thresholdPercentage}%`
                              : "Active account"
                          }
                        >
                          <span className="size-1.5 rounded-full shrink-0 bg-emerald-500" />
                          <span className="truncate">
                            {acc.thresholdPercentage != null
                              ? `T: ${acc.thresholdPercentage}%`
                              : "Active"}
                          </span>
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
