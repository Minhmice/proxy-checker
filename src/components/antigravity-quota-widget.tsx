"use client";

import * as React from "react";
import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { Gauge, RotateCw, Server, Clock, Zap, ShieldAlert, Cpu } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "./auth-provider";
import { fetchAntigravityStatus, refreshAntigravityQuota } from "@/lib/api";
import type { AntigravityRotatorSnapshot, AntigravityAccountState } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  const [refreshing, setRefreshing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const closeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const loadStatus = useCallback(
    async (signal?: AbortSignal) => {
      if (!password && !authenticated) return;
      try {
        const data = await fetchAntigravityStatus(password, signal);
        if (data) setSnapshot(data);
      } catch (err) {
        // Silent fail on background poll
      }
    },
    [password, authenticated]
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);

    const interval = setInterval(() => {
      void loadStatus(controller.signal);
    }, 30_000);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [loadStatus]);

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (refreshing) return;
    setRefreshing(true);
    try {
      const res = await refreshAntigravityQuota(password);
      if (res.snapshot) {
        setSnapshot(res.snapshot);
      } else {
        await loadStatus();
      }
      toast.success("Antigravity quotas refreshed");
    } catch (err) {
      toast.error((err as Error).message || "Failed to refresh quotas");
    } finally {
      setRefreshing(false);
    }
  };

  const handleMouseEnter = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimerRef.current = setTimeout(() => {
      setIsOpen(false);
    }, 200);
  };

  const activeAccounts = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.accounts.filter((a) => a.isActive);
  }, [snapshot]);

  const totalQuota = snapshot?.totalSessionQuotaPercentage ?? 0;
  const maxQuota = snapshot?.maxPossiblePercentage || (snapshot?.totalAccounts ? snapshot.totalAccounts * 100 : 100);
  const overallRatio = maxQuota > 0 ? Math.min(100, Math.max(0, (totalQuota / maxQuota) * 100)) : 0;
  const overallColors = quotaColor(overallRatio);

  return (
    <div
      className="relative w-full"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={() => setIsOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) {
          setIsOpen(false);
        }
      }}
    >
      {/* Drop-up Panel (Pops UP above the footer) */}
      <div
        className={cn(
          "absolute bottom-full left-0 mb-2 w-84 z-50 transition-all duration-200 ease-out origin-bottom",
          "rounded-xl border border-border/80 bg-sidebar/95 backdrop-blur-md shadow-2xl p-3.5 space-y-3",
          isOpen ? "opacity-100 scale-100 pointer-events-auto" : "opacity-0 scale-95 pointer-events-none"
        )}
        role="region"
        aria-label="Antigravity Active Accounts Detail"
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

          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium text-muted-foreground hover:text-sidebar-foreground hover:bg-surface-raised border border-border/60 transition-colors disabled:opacity-50 cursor-pointer"
            title="Refresh quotas now"
          >
            <RotateCw className={cn("size-3", refreshing && "animate-spin text-primary")} />
            <span>{refreshing ? "Checking…" : "Refresh"}</span>
          </button>
        </div>

        {/* Active Accounts List */}
        <div className="space-y-2 max-h-60 overflow-y-auto pr-0.5">
          {activeAccounts.length === 0 ? (
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
                        S: {acc.sessionPercentage.toFixed(0)}%
                      </span>

                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded font-mono text-[10px] border border-border/60 bg-surface-raised text-muted-foreground",
                          weeklyColors.text
                        )}
                        title="Gemini Weekly Quota"
                      >
                        W: {acc.weeklyPercentage.toFixed(0)}%
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
        <div className="pt-2 border-t border-border/40 text-[10px] text-muted-foreground/80 flex items-center justify-between">
          <span>Auto-rotates when Session ≤ 20%</span>
          <span>Lowest reset prioritized</span>
        </div>
      </div>

      {/* Collapsed Bar in SidebarFooter */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "w-full text-left p-2 rounded-lg border border-border/60 transition-all cursor-pointer group",
          isOpen ? "bg-surface-raised border-primary/40" : "bg-surface/40 hover:bg-surface-raised hover:border-border"
        )}
        aria-expanded={isOpen}
      >
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <Gauge className={cn("size-3.5 shrink-0 transition-colors", overallColors.text)} />
            <span className="text-[11px] font-semibold text-sidebar-foreground truncate tracking-tight">
              Quota Antigravity
            </span>
          </div>
          <span className="text-[11px] font-mono font-bold text-ink shrink-0">
            {totalQuota}% <span className="text-[10px] text-muted-foreground font-normal">/ {maxQuota}%</span>
          </span>
        </div>

        {/* Micro Progress Bar */}
        <div className="w-full h-1.5 rounded-full bg-surface-raised overflow-hidden">
          <div
            className={cn("h-full rounded-full transition-all duration-500", overallColors.bar)}
            style={{ width: `${overallRatio}%` }}
          />
        </div>

        <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground font-mono">
          <span>{snapshot?.totalAccounts ?? 0} accs</span>
          <span className="text-emerald-400 font-medium">{activeAccounts.length} active</span>
        </div>
      </button>
    </div>
  );
}
