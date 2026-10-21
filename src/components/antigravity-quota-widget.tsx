"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Gauge, RotateCw, Clock, Cpu } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "./auth-provider";
import { Button } from "@/components/ui/button";
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
      text: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
      bar: "bg-amber-500",
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
  const [snapshot, setSnapshot] = useState<AntigravityRotatorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelId = React.useId();
  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!password && !authenticated) return;
      if (signal?.aborted) return;
      setLoading(true);
      try {
        const data = await fetchAntigravityStatus(password, signal);
        if (signal?.aborted) return;
        if (data) {
          setSnapshot(data);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) return;
        setUnavailable(true);
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [password, authenticated]
  );
  const handleMouseEnter = () => {
    clearTimeout(hoverTimerRef.current ?? undefined);
    hoverTimerRef.current = null;
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    clearTimeout(hoverTimerRef.current ?? undefined);
    hoverTimerRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimerRef.current ?? undefined);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest("[data-quota-widget]")) {
        setIsOpen(false);
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
    };
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
    try {
      const res = await refreshAntigravityQuota(password);
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

  const activeAccounts = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.accounts.filter((a) => a.isActive);
  }, [snapshot]);

  const totalQuota = snapshot?.totalSessionQuotaPercentage;
  const maxQuota = snapshot?.maxPossiblePercentage || (snapshot?.totalAccounts ? snapshot.totalAccounts * 100 : 0);
  const overallRatio = totalQuota !== undefined && maxQuota > 0 ? Math.min(100, Math.max(0, (totalQuota / maxQuota) * 100)) : null;
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
      className="relative w-full"
      data-quota-widget
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Drop-up Panel (Pops UP above the footer) */}
      <div
        id={panelId}
        hidden={!isOpen}
        className="absolute bottom-full left-0 mb-2 z-50 w-[min(22rem,calc(100vw-1.5rem))] max-h-[min(28rem,calc(100dvh-2rem))] overflow-y-auto rounded-xl border border-border/80 bg-sidebar shadow-2xl p-3.5 space-y-3 origin-bottom"
        role="region"
        aria-label="Antigravity active accounts detail"
        aria-hidden={!isOpen}
        inert={!isOpen}
      >
        {/* Panel Header */}
        <div className="flex items-center justify-between pb-2 border-b border-border/60">
          <div className="flex items-center gap-2">
            <div className="flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Cpu className="size-3" />
            </div>
            <span className="text-xs font-semibold text-sidebar-foreground">Active Accounts</span>
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-surface-raised border border-border text-muted-foreground">
              {activeAccounts.length} / {snapshot?.totalAccounts ?? 0}
            </span>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing || (!password && !authenticated)}
            className="min-h-11 h-auto text-[11px] font-medium text-muted-foreground hover:text-sidebar-foreground hover:bg-surface-raised border-border/60"
            title="Refresh quotas now"
          >
            <RotateCw className={cn("size-3", refreshing && "animate-spin text-primary")} />
            <span>{refreshing ? "Checking…" : "Refresh"}</span>
          </Button>
        </div>

        {/* Active Accounts List */}
        <div className="space-y-2 max-h-60 overflow-y-auto pr-0.5">
          {!snapshot ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              {loading ? "Loading active accounts…" : "Accounts data unavailable."}
            </div>
          ) : activeAccounts.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">
              No active accounts running.
            </div>
          ) : (
            activeAccounts.map((acc) => {
              const sessionColors = quotaColor(acc.sessionPercentage);
              const weeklyColors = quotaColor(acc.weeklyPercentage);

              return (
                <div
                  key={acc.id}
                  className="p-2.5 rounded-lg border border-border/60 bg-surface/50 hover:bg-surface transition-colors space-y-2"
                >
                  <div className="flex items-center justify-between gap-1.5 min-w-0">
                    <span className="truncate text-xs font-medium text-sidebar-foreground font-mono" title={acc.email}>
                      {acc.email}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground flex items-center gap-1 font-mono">
                      <Clock className="size-2.5" />
                      {formatCountdown(acc.resetAt)}
                    </span>
                  </div>

                  {/* Quotas & Proxy row */}
                  <div className="flex items-center justify-between gap-1 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded font-mono font-semibold text-[10px] border",
                          sessionColors.bg,
                          sessionColors.text,
                          sessionColors.border
                        )}
                        title="Gemini Session Quota (5h)"
                      >
                        S: {Number.isFinite(acc.sessionPercentage) ? `${acc.sessionPercentage.toFixed(0)}%` : "Unknown"}
                      </span>

                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded font-mono text-[10px] border border-border/60 bg-surface-raised text-muted-foreground",
                          weeklyColors.text
                        )}
                        title="Gemini Weekly Quota"
                      >
                        W: {Number.isFinite(acc.weeklyPercentage) ? `${acc.weeklyPercentage.toFixed(0)}%` : "Unknown"}
                      </span>
                    </div>

                    {/* Proxy Badge */}
                    <div
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-raised border border-border/60 text-[10px] font-mono text-muted-foreground truncate max-w-[110px]"
                      title={acc.proxyName ? `Proxy: ${acc.proxyName}` : "No proxy assigned"}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full shrink-0",
                          acc.proxyHealthy ? "bg-emerald-500 shadow-[0_0_4px_var(--success)]" : "bg-rose-500"
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

        {/* Panel Footer note */}
        <div className="pt-2 border-t border-border/40 text-[10px] text-muted-foreground/80">
          Automatic rotation uses Gemini session quota only: deactivate at or below the configured threshold; activate reserves above it, earliest reset first. Weekly quota is informational only.
        </div>
      </div>

      {/* Collapsed Bar in SidebarFooter */}
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "min-h-11 h-auto w-full p-2 flex flex-col items-stretch text-left justify-start rounded-lg border border-border/60 transition-colors cursor-pointer group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring whitespace-normal",
          isOpen ? "bg-surface-raised border-primary/40" : "bg-surface/40 hover:bg-surface-raised hover:border-border"
        )}
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label={`Antigravity session quota: ${quotaLabel}. ${snapshot ? `${activeAccounts.length} active accounts` : "Quota details unavailable"}`}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <Gauge className={cn("size-3.5 shrink-0 transition-colors", overallRatio === null ? "text-muted-foreground" : overallColors.text)} />
            <span className="text-[11px] font-semibold text-sidebar-foreground truncate tracking-tight">
              Antigravity quota
            </span>
          </div>
          <span className="text-[11px] font-mono font-bold text-ink shrink-0">
            {quotaLabel} {snapshot && <span className="text-[10px] text-muted-foreground font-normal">/ {maxQuota}%</span>}
          </span>
        </div>

        {/* Micro Progress Bar */}
        <div className="w-full h-1.5 rounded-full bg-surface-raised overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", overallRatio === null ? "bg-muted-foreground/40" : overallColors.bar)}
            style={{ width: `${overallRatio ?? 0}%` }}
          />
        </div>

        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
          <span>
            {snapshot
              ? unavailable
                ? `${snapshot.totalAccounts} accounts (stale)`
                : `${snapshot.totalAccounts} accounts`
              : unavailable
              ? "Status unavailable"
              : loading
              ? "Loading quota"
              : "Status unknown"}
          </span>
          <span className="text-emerald-400 font-medium">{snapshot ? `${activeAccounts.length} active` : "—"}</span>
        </div>
      </Button>
    </div>
  );
}
