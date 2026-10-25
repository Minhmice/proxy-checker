"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { AlertCircle, RefreshCw, ArrowUpRight, ArrowDownRight, ArrowLeftRight } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { fetchTokenUsage } from "@/lib/api";
import { formatTokens } from "@/components/ninerouter/mini-usage-card";
import type { AggregatedTokenUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

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
const PERIODS = [
  { id: "today", label: "Today", fullLabel: "Today" },
  { id: "24h", label: "24h", fullLabel: "Last 24 hours" },
  { id: "7d", label: "7D", fullLabel: "Last 7 days" },
  { id: "30d", label: "30D", fullLabel: "Last 30 days" },
  { id: "all", label: "All", fullLabel: "All time" },
];

interface TokenUsageCardProps {
  className?: string;
  defaultPeriod?: string;
  showNodeSelector?: boolean;
}

export function TokenUsageCard({ className, defaultPeriod = "today" }: TokenUsageCardProps) {
  const { password } = useAuth();
  const [period, setPeriod] = useState(defaultPeriod);
  const [data, setData] = useState<AggregatedTokenUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Toggle between Token Count (e.g. 506.4M) and Dollar Cost ($177.98)
  const [displayMode, setDisplayMode] = useState<"tokens" | "cost">("tokens");
  const [isSwitching, setIsSwitching] = useState(false);

  // Keep track of previous values for dynamic trend calculations across refreshes
  const prevTokensRef = useRef<number | null>(null);
  const prevCostRef = useRef<number | null>(null);

  const loadData = useCallback(
    async (isManualRefresh = false) => {
      if (isManualRefresh) {
        setRefreshing(true);
      } else if (!data) {
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

        // Store previous value before updating to compute dynamic delta
        if (data?.totalTokens != null) {
          prevTokensRef.current = data.totalTokens;
        }
        if (data?.totalCost != null) {
          prevCostRef.current = data.totalCost;
        }

        setData(result);
        setError(null);
      } catch (err) {
        setError((err as Error).message || "Failed to load token usage statistics");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [period, data, password],
  );

  useEffect(() => {
    void loadData();
    const interval = setInterval(() => {
      void loadData();
    }, 30_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const currentPeriod = useMemo(() => PERIODS.find((p) => p.id === period) ?? PERIODS[0], [period]);

  const totalTokens = data?.totalTokens ?? 0;
  const promptTokens = data?.totalPromptTokens ?? 0;
  const completionTokens = data?.totalCompletionTokens ?? 0;
  const cachedTokens = data?.totalCachedTokens ?? 0;
  const requests = data?.totalRequests ?? 0;
  const cost = data?.totalCost ?? 0;

  const nodes = data?.nodes ?? [];
  const onlineNodes = nodes.filter((n) => n.online);
  const totalNodeCount = nodes.length;

  // Formatted string for the dot matrix display
  const dotMatrixDisplay = useMemo(() => {
    if (loading && !data) return "—";
    if (displayMode === "cost") {
      const roundedCost = Math.round(cost * 100) / 100;
      return `$${roundedCost.toFixed(2)}`;
    }
    return formatTokens(totalTokens);
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
      // Prompt cache efficiency or delta comparison
      const cacheRate = totalTokens > 0 ? (cachedTokens / totalTokens) * 100 : 0;
      const prev = prevTokensRef.current;
      const hasDelta = prev !== null && prev > 0 && totalTokens !== prev;
      const deltaPercent = hasDelta ? ((totalTokens - prev) / prev) * 100 : cacheRate;

      const direction: "up" | "down" | "neutral" =
        deltaPercent > 0.05 ? "up" : deltaPercent < -0.05 ? "down" : "neutral";

      const percentStr =
        deltaPercent !== 0
          ? Math.abs(deltaPercent).toFixed(1)
          : cacheRate > 0
            ? cacheRate.toFixed(1)
            : null;

      const support =
        cachedTokens > 0
          ? `${formatTokens(promptTokens)} in • ${formatTokens(cachedTokens)} cached (${currentPeriod.label})`
          : `${requests.toLocaleString()} requests • ${currentPeriod.label}`;

      return {
        trendDirection: direction,
        trendPercent: percentStr,
        supportingText: support,
      };
    }

    // Cost mode: Cost savings from caching and cost per volume
    const cacheRate = totalTokens > 0 ? (cachedTokens / totalTokens) * 100 : 0;
    const prevCost = prevCostRef.current;
    const hasCostDelta = prevCost !== null && prevCost > 0 && cost !== prevCost;
    const costDeltaPercent = hasCostDelta ? ((cost - prevCost) / prevCost) * 100 : cacheRate;

    const direction: "up" | "down" | "neutral" =
      costDeltaPercent > 0.05 ? "up" : costDeltaPercent < -0.05 ? "down" : "neutral";

    const percentStr =
      costDeltaPercent !== 0
        ? Math.abs(costDeltaPercent).toFixed(1)
        : cacheRate > 0
          ? cacheRate.toFixed(1)
          : null;

    const avgPerMillion = totalTokens > 0 ? (cost / totalTokens) * 1_000_000 : 0;
    const support =
      cost > 0
        ? `~$${avgPerMillion.toFixed(3)}/M tokens • ${requests.toLocaleString()} reqs`
        : `${requests.toLocaleString()} requests • ${currentPeriod.label}`;

    return {
      trendDirection: direction,
      trendPercent: percentStr,
      supportingText: support,
    };
  }, [displayMode, totalTokens, cachedTokens, promptTokens, cost, requests, currentPeriod]);

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

          {/* Grouped Period Selector Pills + Refresh Action */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="flex items-center bg-[#090F42]/60 border border-[#867ACF]/20 rounded-xl p-0.5 gap-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setPeriod(p.id)}
                  className={cn(
                    "h-6 px-2 sm:px-2.5 text-[11px] font-semibold rounded-lg transition-all cursor-pointer",
                    period === p.id
                      ? "bg-[#3442DC]/60 text-white border border-[#A899FB]/30 shadow-xs"
                      : "text-[#A2A8D0] hover:text-white hover:bg-white/[0.06]",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Subtle Refresh Action */}
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
              className="text-[#A2A8D0] hover:text-white transition-colors cursor-pointer p-1 rounded-lg hover:bg-white/[0.06]"
              title="Refresh telemetry"
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
            aria-label={`Current metric: ${displayMode === "tokens" ? `${totalTokens.toLocaleString()} tokens` : `$${cost.toFixed(2)} cost`}. Click or press Enter to toggle between tokens and cost.`}
            className="group/num relative inline-flex items-center gap-3 cursor-pointer select-none rounded-xl p-1 -m-1 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A899FB] focus-visible:ring-offset-2 focus-visible:ring-offset-[#090F42]"
            title={
              displayMode === "tokens"
                ? `${totalTokens.toLocaleString()} tokens · Click to view Cost`
                : `$${cost.toFixed(4)} USD · Click to view Tokens`
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
                  <span>{trendPercent ? `${trendPercent}%` : "Live"}</span>
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
    </div>
  );
}
