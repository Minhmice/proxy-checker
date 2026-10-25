"use client";

import React, { useEffect, useState, useCallback } from "react";
import {
  Server,
  Zap,
  Cpu,
  Database,
  ArrowUpRight,
  DollarSign,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface UsageStatsData {
  totalRequests?: number;
  totalPromptTokens?: number;
  totalCompletionTokens?: number;
  totalCachedTokens?: number;
  totalCost?: number;
  byModel?: Record<
    string,
    {
      requests: number;
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      cost: number;
      provider?: string;
    }
  >;
  error?: string;
}

interface MiniUsageCardProps {
  nodeId: string;
  nodeName: string;
  nodeUrl: string;
  period: string;
}

export function formatTokens(count: number | null | undefined): string {
  const val = Number(count) || 0;
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}K`;
  return val.toLocaleString();
}

export function MiniUsageCard({ nodeId, nodeName, nodeUrl, period }: MiniUsageCardProps) {
  const [data, setData] = useState<UsageStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/ninerouter/nodes/${encodeURIComponent(nodeId)}/stats?period=${encodeURIComponent(period)}`,
      );
      if (!res.ok) {
        throw new Error(`Node returned HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [nodeId, period]);

  useEffect(() => {
    void fetchStats();
    const interval = setInterval(fetchStats, 30_000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const requests = data?.totalRequests ?? 0;
  const inputTokens = data?.totalPromptTokens ?? 0;
  const cachedTokens = data?.totalCachedTokens ?? 0;
  const outputTokens = data?.totalCompletionTokens ?? 0;
  const cost = data?.totalCost ?? 0;

  const topModels = Object.entries(data?.byModel ?? {})
    .sort(([, a], [, b]) => b.promptTokens - a.promptTokens)
    .slice(0, 4);

  const maxModelTokens = Math.max(
    ...topModels.map(([, m]) => (m.promptTokens || 0) + (m.completionTokens || 0)),
    1,
  );

  return (
    <Card className="bg-[#131318] border border-[#23232C] rounded-2xl p-5 hover:border-white/15 transition-all shadow-lg flex flex-col justify-between">
      <CardHeader className="p-0 pb-3 border-b border-[#23232C] flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center gap-2.5">
          <div className="flex size-8 items-center justify-center rounded-xl bg-[#FF5B22]/10 text-[#FF5B22] border border-[#FF5B22]/25 shadow-[0_0_12px_rgba(255,91,34,0.15)]">
            <Server className="size-4" />
          </div>
          <div>
            <CardTitle className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              {nodeName}
              <Badge
                variant="outline"
                className="text-[10px] font-mono border-[#23232C] bg-[#0A0A0E] text-zinc-400 tabular-nums"
              >
                {nodeUrl.replace(/https?:\/\//, "")}
              </Badge>
            </CardTitle>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={fetchStats}
          disabled={loading}
          className="size-7 p-0 text-zinc-400 hover:text-[#FF5B22] hover:bg-[#FF5B22]/10 transition-colors"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </CardHeader>

      <CardContent className="p-0 pt-4 space-y-4">
        {error ? (
          <div className="flex items-center gap-2 p-3 text-xs rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400">
            <AlertCircle className="size-4 shrink-0" />
            <span>Connection error: {error}</span>
          </div>
        ) : (
          <>
            {/* 5 KPI Metric Tiles */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
              <div className="p-2.5 rounded-xl bg-[#181820]/80 border border-[#23232C]">
                <span className="text-[10px] uppercase font-semibold text-zinc-400 tracking-wider block">
                  Requests
                </span>
                <span className="text-base font-bold text-zinc-100 mt-0.5 block font-mono tabular-nums">
                  {requests.toLocaleString()}
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-[#181820]/80 border border-[#23232C]">
                <span className="text-[10px] uppercase font-semibold text-rose-400/90 tracking-wider block flex items-center justify-center gap-1">
                  <Zap className="size-2.5" /> In Tokens
                </span>
                <span className="text-base font-bold text-rose-400 mt-0.5 block font-mono tabular-nums">
                  {formatTokens(inputTokens)}
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-[#181820]/80 border border-[#23232C]">
                <span className="text-[10px] uppercase font-semibold text-[#FF8555]/90 tracking-wider block flex items-center justify-center gap-1">
                  <Database className="size-2.5" /> Cached
                </span>
                <span className="text-base font-bold text-[#FF8555] mt-0.5 block font-mono tabular-nums">
                  {formatTokens(cachedTokens)}
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-[#181820]/80 border border-[#23232C]">
                <span className="text-[10px] uppercase font-semibold text-emerald-400/90 tracking-wider block flex items-center justify-center gap-1">
                  <ArrowUpRight className="size-2.5" /> Out Tokens
                </span>
                <span className="text-base font-bold text-emerald-400 mt-0.5 block font-mono tabular-nums">
                  {formatTokens(outputTokens)}
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-[#181820]/80 border border-[#23232C] col-span-2 sm:col-span-1">
                <span className="text-[10px] uppercase font-semibold text-[#FF5B22] tracking-wider block flex items-center justify-center gap-0.5">
                  <DollarSign className="size-2.5" /> Est. Cost
                </span>
                <span className="text-base font-bold text-[#FF5B22] mt-0.5 block font-mono tabular-nums">
                  ~${cost.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Model Breakdown Mini List */}
            <div className="space-y-1.5 pt-1">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block">
                Top Active Models
              </span>
              <div className="space-y-1.5">
                {topModels.length === 0 ? (
                  <span className="text-xs text-zinc-500 italic block py-1">
                    No request data in this period
                  </span>
                ) : (
                  topModels.map(([modelName, m]) => {
                    const modelTokens = (m.promptTokens || 0) + (m.completionTokens || 0);
                    const pct = Math.min(
                      100,
                      Math.max(5, Math.round((modelTokens / maxModelTokens) * 100)),
                    );
                    return (
                      <div
                        key={modelName}
                        className="p-2 rounded-xl bg-[#181820]/60 border border-[#23232C] hover:border-[#23232C]/80 transition-colors"
                      >
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-1.5 truncate">
                            <Cpu className="size-3 text-[#FF5B22] shrink-0" />
                            <span className="truncate text-zinc-200 font-medium">
                              {modelName.split(" ")[0]}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[11px] shrink-0 tabular-nums">
                            <span className="text-rose-400">{formatTokens(m.promptTokens)}↑</span>
                            <span className="text-emerald-400">
                              {formatTokens(m.completionTokens)}↓
                            </span>
                            <span className="text-zinc-400">({m.requests} req)</span>
                          </div>
                        </div>
                        {/* Flame progress bar */}
                        <div className="h-1 w-full bg-[#23232C] rounded-full overflow-hidden mt-1.5">
                          <div
                            className="h-full bg-gradient-to-r from-[#FF6633] to-[#FF3D00] rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
