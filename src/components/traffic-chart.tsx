"use client";

import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Activity, BarChart3 } from "lucide-react";
import type { MetricsSnapshot } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Badge } from "@/components/ui/badge";

const chartConfig = {
  active: { label: "Active routes", color: "#FF5B22" },
  reserve: { label: "Reserve pool", color: "#FF8A50" },
} satisfies ChartConfig;

interface FlameTooltipProps {
  active?: boolean;
  payload?: Array<{
    value: number | string;
    name: string;
    color?: string;
    payload?: {
      time: string;
      active: number;
      reserve?: number;
      latency?: number;
    };
  }>;
  label?: string;
}

function FlameTooltip({ active, payload, label }: FlameTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const entry = payload[0];
  return (
    <div className="bg-[#1C1C24] border border-[#2A2A36] rounded-xl shadow-xl p-3 text-white min-w-[150px] space-y-1.5 backdrop-blur-md">
      <p className="text-[11px] font-mono text-zinc-400 uppercase tracking-wider">{label}</p>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-1.5 text-zinc-300">
          <span className="size-2 rounded-full bg-[#FF5B22]" />
          Active Routes
        </span>
        <span className="font-mono font-bold text-white tabular-nums">{entry.value}</span>
      </div>
      {entry.payload?.latency != null && (
        <div className="flex items-center justify-between gap-3 text-[11px] text-zinc-400 border-t border-[#2A2A36] pt-1">
          <span>Avg Latency</span>
          <span className="font-mono text-zinc-300">{entry.payload.latency} ms</span>
        </div>
      )}
    </div>
  );
}

interface TrafficChartProps {
  snapshots: MetricsSnapshot[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

export function TrafficChart({ snapshots, hours, onHoursChange }: TrafficChartProps) {
  // ponytail: filter invalid dates/snapshots inline; add streaming windowing if multi-day data grows heavy
  const data = useMemo(
    () =>
      (snapshots || [])
        .filter(
          (s) =>
            s && typeof s.active === "number" && !Number.isNaN(new Date(s.timestamp).getTime()),
        )
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
    [snapshots],
  );

  const latestActive = data.length > 0 ? data[data.length - 1].active : null;
  return (
    <Card className="rounded-2xl border-[#23232C] bg-[#131318] text-white shadow-sm backdrop-blur-xs transition-all duration-200">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between pb-4 border-b border-[#23232C]">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md border border-[#23232C] bg-[#1C1C24] text-[#FF5B22]">
              <Activity className="size-4" />
            </div>
            <CardTitle className="text-base font-semibold text-white">
              Active Proxy History
            </CardTitle>
            {latestActive != null && data.length >= 2 && (
              <Badge
                variant="outline"
                className="font-mono text-xs border-[#FF5B22]/40 text-[#FF5B22] bg-[#FF5B22]/10"
              >
                {latestActive} active (latest snapshot)
              </Badge>
            )}
          </div>
          <CardDescription className="text-xs text-zinc-400 mt-1">
            Historical active proxy count recorded at each sync across time windows.
          </CardDescription>
        </div>

        <ToggleGroup
          type="single"
          value={String(hours)}
          onValueChange={(val) => val && onHoursChange(Number(val))}
          className="bg-[#181820] p-0.5 rounded-lg border border-[#23232C] self-start sm:self-auto"
          aria-label="Metrics time range"
        >
          <ToggleGroupItem
            value="24"
            className="text-xs px-2.5 py-1 h-7 text-zinc-400 hover:text-white data-[state=on]:bg-[#FF5B22] data-[state=on]:text-zinc-950 data-[state=on]:font-semibold data-[state=on]:shadow-md data-[state=on]:shadow-[#FF5B22]/30"
          >
            24 Hours
          </ToggleGroupItem>
          <ToggleGroupItem
            value="168"
            className="text-xs px-2.5 py-1 h-7 text-zinc-400 hover:text-white data-[state=on]:bg-[#FF5B22] data-[state=on]:text-zinc-950 data-[state=on]:font-semibold data-[state=on]:shadow-md data-[state=on]:shadow-[#FF5B22]/30"
          >
            7 Days
          </ToggleGroupItem>
          <ToggleGroupItem
            value="720"
            className="text-xs px-2.5 py-1 h-7 text-zinc-400 hover:text-white data-[state=on]:bg-[#FF5B22] data-[state=on]:text-zinc-950 data-[state=on]:font-semibold data-[state=on]:shadow-md data-[state=on]:shadow-[#FF5B22]/30"
          >
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
          <ChartContainer config={chartConfig} className="h-68 3xl:h-[400px] 5xl:h-[460px] w-full">
            <AreaChart
              accessibilityLayer
              data={data}
              margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
            >
              <defs>
                <linearGradient id="flameGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FF5B22" stopOpacity={0.5} />
                  <stop offset="65%" stopColor="#FF3D00" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#D82600" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#23232C" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: "#71717A", fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: "#23232C" }}
              />
              <YAxis
                tick={{ fill: "#71717A", fontSize: 11 }}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <ChartTooltip content={<FlameTooltip />} />
              <Area
                type="monotone"
                dataKey="active"
                stroke="#FF5B22"
                strokeWidth={2.5}
                fill="url(#flameGrad)"
                name="Active proxies"
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
