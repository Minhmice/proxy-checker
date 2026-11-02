"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertCircle, RefreshCw, ArrowUpRight, ArrowDownRight, ArrowLeftRight } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { fetchTokenUsage } from "@/lib/api";
import { formatTokens } from "@/components/ninerouter/mini-usage-card";
import type { AggregatedTokenUsage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// --- 5x7 DOT-MATRIX GLYPH SPECIFICATION ---
// 1 = illuminated dot (pure white #FFFFFF with soft luminous aura)
// 0 = continuous background inactive dot (muted purple #6974B8 at ~22% opacity)
const MATRIX_FONT: Record<string, number[][]> = {
  $: [
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 1],
    [1, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 1, 0, 1],
    [1, 1, 1, 1, 0],
    [0, 0, 1, 0, 0],
  ],
  "0": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "1": [
    [0, 0, 1, 0, 0],
    [0, 1, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
  ],
  "2": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0],
    [0, 1, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ],
  "3": [
    [1, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
  ],
  "4": [
    [0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0],
    [0, 1, 0, 1, 0],
    [1, 0, 0, 1, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 1, 0],
  ],
  "5": [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "6": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "7": [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 1, 0],
    [0, 0, 1, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
  ],
  "8": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "9": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 1],
    [0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  ".": [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [1, 1],
    [1, 1],
  ],
  ",": [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 1],
    [1, 0],
  ],
  "+": [
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
  ],
  "-": [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ],
  M: [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  K: [
    [1, 0, 0, 0, 1],
    [1, 0, 0, 1, 0],
    [1, 0, 1, 0, 0],
    [1, 1, 0, 0, 0],
    [1, 0, 1, 0, 0],
    [1, 0, 0, 1, 0],
    [1, 0, 0, 0, 1],
  ],
  B: [
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
  ],
  T: [
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
  ],
  "—": [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ],
};

// Aliases for case insensitivity
MATRIX_FONT.m = MATRIX_FONT.M;
MATRIX_FONT.k = MATRIX_FONT.K;
MATRIX_FONT.b = MATRIX_FONT.B;
MATRIX_FONT.t = MATRIX_FONT.T;

// --- CONTINUOUS DOT MATRIX RENDERER ---
// Renders every active and inactive dot position to create a faint, continuous
// inactive background grid (#6974B8) behind illuminated white glyphs (#FFFFFF).
interface DotMatrixDisplayProps {
  text: string;
  className?: string;
}

function DotMatrixDisplay({ text, className }: DotMatrixDisplayProps) {
  const { columns, viewBoxWidth, viewBoxHeight } = useMemo(() => {
    const chars = text.split("");
    const cols: number[][] = [];

    // 1 leading inactive column for bezel balance
    cols.push([0, 0, 0, 0, 0, 0, 0]);

    chars.forEach((ch, idx) => {
      if (ch === " ") {
        cols.push([0, 0, 0, 0, 0, 0, 0]);
        cols.push([0, 0, 0, 0, 0, 0, 0]);
        return;
      }

      const glyph = MATRIX_FONT[ch] || MATRIX_FONT[ch.toUpperCase()] || MATRIX_FONT["0"];
      const glyphCols = glyph[0]?.length || 5;

      for (let c = 0; c < glyphCols; c++) {
        const colData: number[] = [];
        for (let r = 0; r < 7; r++) {
          colData.push(glyph[r]?.[c] ?? 0);
        }
        cols.push(colData);
      }

      // 1 inactive column separation between characters
      if (idx < chars.length - 1) {
        cols.push([0, 0, 0, 0, 0, 0, 0]);
      }
    });

    // 1 trailing inactive column for bezel balance
    cols.push([0, 0, 0, 0, 0, 0, 0]);

    const dotRadius = 2.8;
    const dotGap = 7.5;
    const pad = 3;
    const width = (cols.length - 1) * dotGap + 2 * dotRadius + pad * 2;
    const height = (7 - 1) * dotGap + 2 * dotRadius + pad * 2;

    return { columns: cols, viewBoxWidth: width, viewBoxHeight: height };
  }, [text]);

  const dotRadius = 2.8;
  const dotGap = 7.5;
  const pad = 3;

  return (
    <div className={cn("relative inline-block select-none", className)}>
      <svg
        viewBox={`0 0 ${viewBoxWidth.toFixed(1)} ${viewBoxHeight.toFixed(1)}`}
        className="h-14 sm:h-16 w-auto max-w-full overflow-visible"
        aria-hidden="true"
      >
        <defs>
          {/* Subtle luminous halo for active white dots */}
          <filter id="matrixDotGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow
              dx="0"
              dy="0"
              stdDeviation="1.5"
              floodColor="#FFFFFF"
              floodOpacity="0.85"
            />
            <feDropShadow
              dx="0"
              dy="0"
              stdDeviation="3.5"
              floodColor="#A899FB"
              floodOpacity="0.45"
            />
          </filter>
        </defs>

        {/* 1. Inactive background matrix dots (continuous field in #6974B8) */}
        {/* 1. Inactive background matrix dots (continuous field in #6974B8) */}
        <g className="inactive-dots">
          {columns.map((col, c) =>
            col.map((_, r) => {
              const cx = c * dotGap + dotRadius + pad;
              const cy = r * dotGap + dotRadius + pad;
              return (
                <circle
                  key={`in-${c}-${r}`}
                  cx={cx.toFixed(1)}
                  cy={cy.toFixed(1)}
                  r={dotRadius}
                  fill="#6974B8"
                  opacity={0.24}
                />
              );
            }),
          )}
        </g>

        {/* 2. Active illuminated dots (pure white #FFFFFF) */}
        <g className="active-dots">
          {columns.map((col, c) =>
            col.map((isLit, r) => {
              if (isLit !== 1) return null;
              const cx = c * dotGap + dotRadius + pad;
              const cy = r * dotGap + dotRadius + pad;
              return (
                <circle
                  key={`act-${c}-${r}`}
                  cx={cx.toFixed(1)}
                  cy={cy.toFixed(1)}
                  r={dotRadius}
                  fill="#FFFFFF"
                  filter="url(#matrixDotGlow)"
                  className="transition-opacity duration-150"
                />
              );
            }),
          )}
        </g>
      </svg>
    </div>
  );
}

// --- TELEMETRY PERIOD DEFINITIONS ---
export const TOKEN_USAGE_PERIODS = [
  { id: "today", label: "Today", fullLabel: "Today" },
  { id: "24h", label: "24h", fullLabel: "Last 24 hours" },
  { id: "7d", label: "7D", fullLabel: "Last 7 days" },
  { id: "30d", label: "30D", fullLabel: "Last 30 days" },
];

interface TokenUsageCardProps {
  className?: string;
  period: string;
}

export function TokenUsageCard({ className, period }: TokenUsageCardProps) {
  const { password } = useAuth();

  const [data, setData] = useState<AggregatedTokenUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Toggle between Token Count (e.g. 506.4M) and Dollar Cost ($177.98)
  const [displayMode, setDisplayMode] = useState<"tokens" | "cost">("tokens");
  const [isSwitching, setIsSwitching] = useState(false);

  // Keep track of latest fetched snapshot and active period across renders/fetches
  const latestDataRef = useRef<AggregatedTokenUsage | null>(null);
  const activePeriodRef = useRef(period);
  activePeriodRef.current = period;

  // Keep track of previous values for dynamic trend calculations across refreshes
  const prevTokensRef = useRef<number | null>(null);
  const prevCostRef = useRef<number | null>(null);

  const loadData = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) {
        setRefreshing(true);
      } else if (!latestDataRef.current || latestDataRef.current.period !== period) {
        setLoading(true);
      }
      setError(null);

      const controller = new AbortController();
      try {
        const result = await fetchTokenUsage(
          password || undefined,
          period,
          undefined,
          controller.signal,
        );

        // If user changed period while request was in-flight, discard stale result
        if (activePeriodRef.current !== period) {
          return;
        }

        // Only compare snapshots from the same period.
        const prevSnapshot = latestDataRef.current;
        if (prevSnapshot?.period === period) {
          if (prevSnapshot.totalTokens != null) prevTokensRef.current = prevSnapshot.totalTokens;
          if (prevSnapshot.totalCost != null) prevCostRef.current = prevSnapshot.totalCost;
        } else {
          prevTokensRef.current = null;
          prevCostRef.current = null;
        }

        latestDataRef.current = result;
        setData(result);
        setError(null);
      } catch (err) {
        if (activePeriodRef.current === period) {
          setError((err as Error).message || "Failed to load token usage statistics");
        }
      } finally {
        if (activePeriodRef.current === period) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [period, password],
  );

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      void loadData();
    }, 30_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const currentPeriod = useMemo(
    () => TOKEN_USAGE_PERIODS.find((p) => p.id === period) ?? TOKEN_USAGE_PERIODS[0],
    [period],
  );

  const totalTokens = data?.totalTokens;
  const promptTokens = data?.totalPromptTokens;
  const completionTokens = data?.totalCompletionTokens;
  const cachedTokens = data?.totalCachedTokens;
  const requests = data?.totalRequests ?? 0;
  const cost = data?.totalCost;

  const nodes = data?.nodes ?? [];
  const onlineNodes = nodes.filter((n) => n.online);
  const totalNodeCount = nodes.length;

  // Formatted string for the dot matrix display
  const dotMatrixDisplay = useMemo(() => {
    if (loading && !data) return "—";
    if (displayMode === "cost") {
      if (cost == null) return "—";
      const roundedCost = Math.round(cost * 100) / 100;
      return `$${roundedCost.toFixed(2)}`;
    }
    return totalTokens == null ? "—" : formatTokens(totalTokens);
  }, [displayMode, cost, totalTokens, loading, data]);

  // Restrained toggle transition (180–220ms opacity and slight translateY)
  const handleToggleMode = useCallback(() => {
    setIsSwitching(true);
    setDisplayMode((prev) => (prev === "tokens" ? "cost" : "tokens"));
    const timer = setTimeout(() => {
      setIsSwitching(false);
    }, 200);
    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleToggleMode();
      }
    },
    [handleToggleMode],
  );

  // Dynamic Trend & Comparison Calculations (truthful to real data semantics)
  const { trendDirection, trendPercent, supportingText } = useMemo(() => {
    if (displayMode === "tokens") {
      const prev = prevTokensRef.current;
      const deltaPercent =
        prev !== null &&
        prev > 0 &&
        totalTokens != null &&
        Number.isFinite(totalTokens) &&
        totalTokens !== prev
          ? ((totalTokens - prev) / prev) * 100
          : null;

      const direction: "up" | "down" | "neutral" =
        deltaPercent !== null && deltaPercent > 0.05
          ? "up"
          : deltaPercent !== null && deltaPercent < -0.05
            ? "down"
            : "neutral";

      const percentStr =
        deltaPercent !== null && deltaPercent !== 0 ? Math.abs(deltaPercent).toFixed(1) : null;

      const support =
        cachedTokens != null && cachedTokens > 0 && promptTokens != null
          ? `${formatTokens(promptTokens)} in • ${formatTokens(cachedTokens)} cached (${currentPeriod.label})`
          : `${requests.toLocaleString()} requests • ${currentPeriod.label}`;

      return {
        trendDirection: direction,
        trendPercent: percentStr,
        supportingText: support,
      };
    }
    const prevCost = prevCostRef.current;
    const costDeltaPercent =
      prevCost !== null &&
      prevCost > 0 &&
      cost != null &&
      Number.isFinite(cost) &&
      cost !== prevCost
        ? ((cost - prevCost) / prevCost) * 100
        : null;

    const direction: "up" | "down" | "neutral" =
      costDeltaPercent !== null && costDeltaPercent > 0.05
        ? "up"
        : costDeltaPercent !== null && costDeltaPercent < -0.05
          ? "down"
          : "neutral";

    const percentStr =
      costDeltaPercent !== null && costDeltaPercent !== 0
        ? Math.abs(costDeltaPercent).toFixed(1)
        : null;

    const avgPerMillion =
      cost != null && Number.isFinite(cost) && totalTokens != null && totalTokens > 0
        ? (cost / totalTokens) * 1_000_000
        : null;
    const support =
      avgPerMillion !== null
        ? `~$${avgPerMillion.toFixed(3)}/M tokens • ${requests.toLocaleString()} reqs`
        : `${requests.toLocaleString()} requests • ${currentPeriod.label}`;

    return {
      trendDirection: direction,
      trendPercent: percentStr,
      supportingText: support,
    };
  }, [displayMode, totalTokens, cachedTokens, promptTokens, cost, requests, currentPeriod]);
  const efficiency = (numerator: number | undefined, denominator: number | undefined) =>
    numerator != null &&
    denominator != null &&
    Number.isFinite(numerator) &&
    Number.isFinite(denominator) &&
    denominator > 0
      ? `${((numerator / denominator) * 100).toFixed(1)}%`
      : "Unavailable";
  const modelRows = Object.entries(data?.byModel ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const completionPromptRatio =
    data && promptTokens != null && promptTokens > 0 && completionTokens != null
      ? (completionTokens / promptTokens) * 100
      : null;
  const cacheSavingsRate =
    data && totalTokens != null && totalTokens > 0 && cachedTokens != null
      ? (cachedTokens / totalTokens) * 100
      : null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-[28px] sm:rounded-[32px] border border-[#867ACF]/25 text-white transition-all duration-300",
        "p-5 sm:p-8",
        className,
      )}
      style={{
        background:
          "radial-gradient(circle at 12% 18%, rgba(168, 153, 251, 0.42) 0%, transparent 45%), " +
          "radial-gradient(circle at 88% 22%, rgba(134, 122, 207, 0.32) 0%, transparent 50%), " +
          "radial-gradient(circle at 20% 88%, rgba(52, 66, 220, 0.38) 0%, transparent 55%), " +
          "linear-gradient(135deg, #1C1B3E 0%, #121332 45%, #090F42 100%)",
        boxShadow:
          "0 24px 60px -12px rgba(9, 15, 66, 0.75), 0 0 1px 1px rgba(168, 153, 251, 0.2) inset",
      }}
    >
      {/* 1. HEADER ROW: Title + Realtime Status Indicator + Period Selector */}
      {/* 1. HEADER ROW: Title + Realtime Status Indicator + Period Selector */}
      <div className="flex items-center justify-between flex-wrap gap-3 pb-4">
        <div className="flex items-center gap-3">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
            9Router Telemetry
          </h2>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          {/* Subtle Realtime Indicator */}
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono font-medium bg-[#3442DC]/20 border border-[#867ACF]/25 text-[#A2A8D0] shrink-0">
            <span
              className={cn(
                "size-1.5 rounded-full",
                onlineNodes.length === totalNodeCount && totalNodeCount > 0
                  ? "bg-emerald-400 animate-pulse"
                  : "bg-amber-400",
              )}
            />
            <span>
              {totalNodeCount > 0
                ? `${onlineNodes.length}/${totalNodeCount} Online`
                : "Telemetry Live"}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
              className="text-[#A2A8D0] hover:text-white transition-colors cursor-pointer p-2 rounded-lg hover:bg-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A899FB]"
              aria-label="Refresh telemetry"
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin text-[#A899FB]")} />
            </button>
          </div>
        </div>
      </div>

      {/* Non-blocking error notification if stale data is displayed */}
      {error && data && (
        <div className="mb-4 text-[11px] font-mono text-amber-300 bg-amber-400/10 border border-amber-400/20 px-3 py-1.5 rounded-lg">
          Last available data · Refresh failed: {error}
        </div>
      )}

      {/* Blocking error state if fetch failed without cached data */}
      {error && !data ? (
        <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
          <AlertCircle className="size-8 text-[#FF8B93]" />
          <h3 className="text-base font-semibold text-white">Unable to load token usage</h3>
          <p className="text-xs text-[#A2A8D0] max-w-md">{error}</p>
          <button
            type="button"
            onClick={() => void loadData(true)}
            className="mt-2 h-8 px-4 text-xs font-semibold rounded-lg bg-[#3442DC] text-white hover:bg-[#3442DC]/80 transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : (
        /* 2. PRIMARY METRIC ROW: Dot Matrix Number (Left) & Trend Block (Right) */
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6 pt-1">
          {/* Left: Large Dot Matrix Display with interactive Token ↔ Cost toggle */}
          <div
            role="button"
            tabIndex={0}
            onClick={handleToggleMode}
            onKeyDown={handleKeyDown}
            aria-label={`Current metric: ${displayMode === "tokens" ? (totalTokens == null ? "Unavailable tokens" : `${totalTokens.toLocaleString()} tokens`) : cost == null ? "Unavailable cost" : `$${cost.toFixed(2)} cost`}. Click or press Enter to toggle between tokens and cost.`}
            className="group/num relative inline-flex items-center gap-3 cursor-pointer select-none rounded-xl p-1 -m-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A899FB] focus-visible:ring-offset-2 focus-visible:ring-offset-[#090F42]"
            title={
              displayMode === "tokens"
                ? `${totalTokens == null ? "Unavailable" : totalTokens.toLocaleString()} tokens · Click to view Cost`
                : `${cost == null ? "Unavailable" : `$${cost.toFixed(4)} USD`} · Click to view Tokens`
            }
          >
            {/* Smooth 200ms opacity and translateY transition on toggle */}
            <div
              className="relative transition-all duration-200 ease-out"
              style={{
                opacity: isSwitching ? 0.3 : 1,
                transform: isSwitching ? "translateY(3px)" : "translateY(0px)",
              }}
            >
              <DotMatrixDisplay text={dotMatrixDisplay} />
            </div>

            {/* Subtle interactive swap hint */}
            <span
              className="flex items-center justify-center size-6 rounded-md bg-white/[0.06] text-[#A2A8D0] opacity-35 group-hover/num:opacity-90 group-hover/num:text-white group-hover/num:bg-white/[0.12] transition-all shrink-0"
              aria-hidden="true"
            >
              <ArrowLeftRight className="size-3" />
            </span>
          </div>

          {/* Right: Trend Block vertically aligned to number baseline / visual center */}
          <div className="flex flex-col items-start sm:items-end justify-center shrink-0">
            {/* Trend Indicator (Lime #DCFF39 for positive, Coral #FF8B93 for negative) */}
            <div className="flex items-center gap-1.5 font-mono text-base sm:text-lg font-bold tracking-tight">
              {trendDirection === "up" && trendPercent ? (
                <span className="inline-flex items-center gap-1 text-[#DCFF39]">
                  <ArrowUpRight className="size-4 stroke-[2.5]" />
                  <span>+{trendPercent}%</span>
                </span>
              ) : trendDirection === "down" && trendPercent ? (
                <span className="inline-flex items-center gap-1 text-[#FF8B93]">
                  <ArrowDownRight className="size-4 stroke-[2.5]" />
                  <span>-{trendPercent}%</span>
                </span>
              ) : (
                <span className="text-[#A2A8D0]">
                  <span>{trendPercent ? `${trendPercent}%` : "Unavailable"}</span>
                </span>
              )}
            </div>

            {/* Supporting Comparison Text */}
            <div className="text-xs sm:text-sm text-[#A2A8D0] font-medium tracking-tight mt-0.5">
              {supportingText}
            </div>
          </div>
        </div>
      )}
      <section aria-labelledby="token-efficiency-heading" className="mt-8 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 id="token-efficiency-heading" className="text-sm font-semibold text-white">
            Efficiency telemetry
          </h3>
          <span className="text-[11px] text-[#A2A8D0]">{currentPeriod.fullLabel}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
            <p className="text-xs text-[#A2A8D0]">Completion / prompt</p>
            <p className="mt-1 font-mono text-2xl font-bold tabular-nums">
              {completionPromptRatio == null
                ? "Unavailable"
                : `${completionPromptRatio.toFixed(1)}%`}
            </p>
            <p className="mt-1 text-[11px] text-[#A2A8D0]">
              {completionTokens == null || promptTokens == null
                ? "Unavailable"
                : `${formatTokens(completionTokens)} completion · ${formatTokens(promptTokens)} prompt`}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
            <p className="text-xs text-[#A2A8D0]">Cache savings rate</p>
            <p className="mt-1 font-mono text-2xl font-bold tabular-nums">
              {cacheSavingsRate == null ? "Unavailable" : `${cacheSavingsRate.toFixed(1)}%`}
            </p>
            <p className="mt-1 text-[11px] text-[#A2A8D0]">
              {cachedTokens == null || totalTokens == null
                ? "Unavailable"
                : `${formatTokens(cachedTokens)} cached · ${formatTokens(totalTokens)} total`}
            </p>
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-black/15 p-3">
          <h4 className="px-2 pb-2 text-xs font-semibold text-white">Usage by model</h4>
          <Table aria-label="Token usage by model">
            <TableHeader>
              <TableRow className="border-white/10 hover:bg-transparent">
                <TableHead className="text-[#A2A8D0]">Model</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Requests</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Prompt</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Completion</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Cached</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Total tokens</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Cost</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Comp / prompt</TableHead>
                <TableHead className="text-right text-[#A2A8D0]">Cache save</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {modelRows.length === 0 ? (
                <TableRow className="border-white/10 hover:bg-transparent">
                  <TableCell colSpan={9} className="h-20 text-center text-xs text-[#A2A8D0]">
                    Unavailable
                  </TableCell>
                </TableRow>
              ) : (
                modelRows.map(([model, stats]) => {
                  const modelTotal =
                    Number.isFinite(stats.promptTokens) &&
                    Number.isFinite(stats.completionTokens) &&
                    Number.isFinite(stats.cachedTokens)
                      ? stats.promptTokens + stats.completionTokens + stats.cachedTokens
                      : null;
                  return (
                    <TableRow key={model} className="border-white/10 hover:bg-white/[0.04]">
                      <TableCell className="max-w-[180px] truncate font-medium text-white">
                        {model}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {Number.isFinite(stats.requests)
                          ? stats.requests.toLocaleString()
                          : "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {Number.isFinite(stats.promptTokens)
                          ? formatTokens(stats.promptTokens)
                          : "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {Number.isFinite(stats.completionTokens)
                          ? formatTokens(stats.completionTokens)
                          : "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {Number.isFinite(stats.cachedTokens)
                          ? formatTokens(stats.cachedTokens)
                          : "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {modelTotal == null ? "Unavailable" : formatTokens(modelTotal)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {Number.isFinite(stats.cost) ? `$${stats.cost.toFixed(4)}` : "Unavailable"}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {efficiency(stats.completionTokens, stats.promptTokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {efficiency(stats.cachedTokens, modelTotal ?? undefined)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
