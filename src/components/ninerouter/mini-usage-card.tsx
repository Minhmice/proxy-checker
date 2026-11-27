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
import { DitherBar, DitherDivider } from "@/components/ui/dither";

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
    <Card className="flex flex-col justify-between gap-0 rounded-2xl border-border bg-card p-5 shadow-sm transition-colors hover:border-primary/40">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-0 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <Server className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-bold text-foreground">
              <span className="min-w-0 break-all">{nodeName}</span>
              <Badge
                variant="outline"
                title={nodeUrl}
                className="max-w-full shrink border-border bg-background font-mono text-[10px] text-muted-foreground tabular-nums"
              >
                <span className="truncate">{nodeUrl.replace(/https?:\/\//, "")}</span>
              </Badge>
            </CardTitle>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={fetchStats}
          disabled={loading}
          aria-label={`Refresh ${nodeName} usage`}
          className="size-9 shrink-0 p-0 text-muted-foreground hover:text-primary"
        >
          <RefreshCw
            className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
          />
        </Button>
      </CardHeader>
      <DitherDivider edge="top" length={6} className="h-1.5" />

      <CardContent className="p-0 pt-4 space-y-4">
        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>Connection error: {error}</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
              <div className="rounded-xl border border-border bg-muted/50 p-2.5">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Requests
                </span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-foreground">
                  {requests.toLocaleString()}
                </span>
              </div>

              <div className="rounded-xl border border-border bg-muted/50 p-2.5">
                <span className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-dither-red">
                  <Zap className="size-2.5" /> In Tokens
                </span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-dither-red">
                  {formatTokens(inputTokens)}
                </span>
              </div>

              <div className="rounded-xl border border-border bg-muted/50 p-2.5">
                <span className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-chart-2">
                  <Database className="size-2.5" /> Cached
                </span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-chart-2">
                  {formatTokens(cachedTokens)}
                </span>
              </div>

              <div className="rounded-xl border border-border bg-muted/50 p-2.5">
                <span className="flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-success">
                  <ArrowUpRight className="size-2.5" /> Out Tokens
                </span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-success">
                  {formatTokens(outputTokens)}
                </span>
              </div>

              <div className="col-span-2 rounded-xl border border-border bg-muted/50 p-2.5 sm:col-span-1">
                <span className="flex items-center justify-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  <DollarSign className="size-2.5" /> Est. Cost
                </span>
                <span className="mt-0.5 block font-mono text-base font-bold tabular-nums text-primary">
                  ~${cost.toFixed(2)}
                </span>
              </div>
            </div>

            <div className="space-y-1.5 pt-1">
              <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Top Active Models
              </span>
              {topModels.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Bar width compares total tokens with the largest listed model.
                </p>
              )}
              <div className="space-y-1.5">
                {topModels.length === 0 ? (
                  <span className="block py-1 text-xs italic text-muted-foreground">
                    No request data in this period
                  </span>
                ) : (
                  topModels.map(([modelName, m]) => {
                    const modelTokens = (m.promptTokens || 0) + (m.completionTokens || 0);
                    const pct = Math.min(
                      100,
                      Math.max(0, Math.round((modelTokens / maxModelTokens) * 100)),
                    );
                    return (
                      <div
                        key={modelName}
                        className="rounded-xl border border-border bg-muted/40 p-2 transition-colors hover:border-primary/40"
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <Cpu className="size-3 shrink-0 text-primary" />
                            <span className="truncate font-medium text-foreground">
                              {modelName.split(" ")[0]}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 font-mono text-[11px] shrink-0 tabular-nums">
                            <span className="text-dither-red">{formatTokens(m.promptTokens)}↑</span>
                            <span className="text-success">
                              {formatTokens(m.completionTokens)}↓
                            </span>
                            <span className="text-muted-foreground">({m.requests} req)</span>
                          </div>
                        </div>
                        <div
                          role="progressbar"
                          aria-label={`${modelName} tokens relative to the largest listed model`}
                          aria-valuenow={pct}
                          aria-valuetext={`${formatTokens(modelTokens)} tokens, ${pct}% of the largest listed model`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="relative h-1.5 w-full overflow-hidden rounded-sm mt-1.5"
                        >
                          <DitherBar percent={pct} />
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
