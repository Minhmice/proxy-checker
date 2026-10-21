"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, BarChart3 } from "lucide-react";
import type { MetricsSnapshot } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";

const chartConfig = {
  active: { label: "Active routes", color: "var(--primary)" },
  reserve: { label: "Reserve pool", color: "var(--accent-violet)" },
} satisfies ChartConfig;

interface TrafficChartProps {
  snapshots: MetricsSnapshot[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

export function TrafficChart({ snapshots, hours, onHoursChange }: TrafficChartProps) {
  const [, setActivePoint] = useState<number | null>(null);

  // ponytail: filter invalid dates/snapshots inline; add streaming windowing if multi-day data grows heavy
  const data = useMemo(
    () =>
      (snapshots || [])
        .filter((s) => s && typeof s.active === "number" && !Number.isNaN(new Date(s.timestamp).getTime()))
        .map((s) => ({
          time: new Date(s.timestamp).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }),
          active: s.active,
          reserve: s.reserve,
          latency: s.avgLatencyMs ?? 0,
        })),
    [snapshots]
  );

  const latestActive = data.length > 0 ? data[data.length - 1].active : null;
  return (
    <Card className="border-border bg-card/90 shadow-sm backdrop-blur-xs transition-all duration-200">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-border-subtle/60">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md border border-border-subtle bg-surface-raised/70 text-primary">
              <Activity className="size-4" />
            </div>
            <CardTitle className="text-base font-semibold text-ink">
              Pool Traffic & Capacity
            </CardTitle>
            {latestActive != null && data.length >= 2 && (
              <Badge variant="outline" className="font-mono text-xs border-primary/30 text-primary bg-primary/5">
                {latestActive} active (latest snapshot)
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs text-muted-foreground mt-1">
            Historical proxy allocation and fleet stability across time windows.
          </CardDescription>
        </div>

        <ToggleGroup
          type="single"
          value={String(hours)}
          onValueChange={(val) => val && onHoursChange(Number(val))}
          className="bg-surface-raised/80 p-0.5 rounded-lg border border-border-subtle self-start sm:self-auto"
          aria-label="Metrics time range"
        >
          <ToggleGroupItem value="24" className="text-xs px-2.5 py-1 h-7 data-[state=on]:bg-primary data-[state=on]:text-white data-[state=on]:font-medium">
            24 Hours
          </ToggleGroupItem>
          <ToggleGroupItem value="168" className="text-xs px-2.5 py-1 h-7 data-[state=on]:bg-primary data-[state=on]:text-white data-[state=on]:font-medium">
            7 Days
          </ToggleGroupItem>
          <ToggleGroupItem value="720" className="text-xs px-2.5 py-1 h-7 data-[state=on]:bg-primary data-[state=on]:text-white data-[state=on]:font-medium">
            30 Days
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>

      <CardContent className="pt-6">
        {data.length < 2 ? (
          <div className="flex flex-col items-center justify-center py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-surface-raised border border-border-subtle text-muted-foreground mb-3">
              <BarChart3 className="size-6 opacity-60" />
            </div>
            <p className="text-sm font-medium text-ink">
              {data.length === 1
                ? "Insufficient metrics history recorded yet"
                : "No metrics history recorded yet"}
            </p>
            <p className="text-xs text-muted-foreground mt-1 max-w-sm">
              {data.length === 1
                ? "At least two snapshots are required to chart route allocation and stability trends."
                : "Trigger a pool sync or wait for automated interval checks to start charting route health and density."}
            </p>
          </div>
        ) : (
          <ChartContainer config={chartConfig} className="h-68 w-full">
            <AreaChart
              accessibilityLayer
              data={data}
              onMouseMove={(state) => setActivePoint(typeof state.activeTooltipIndex === "number" ? state.activeTooltipIndex : null)}
              onMouseLeave={() => setActivePoint(null)}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <defs>
                <linearGradient id="activeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.45} />
                  <stop offset="90%" stopColor="var(--primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                type="monotone"
                dataKey="active"
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#activeGrad)"
                name="Active routes"
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
