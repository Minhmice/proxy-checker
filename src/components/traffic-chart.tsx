"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricsSnapshot } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const chartConfig = {
  active: { label: "Active pools", color: "var(--primary)" },
} satisfies ChartConfig;

interface TrafficChartProps {
  snapshots: MetricsSnapshot[];
  hours: number;
  onHoursChange: (hours: number) => void;
}

export function TrafficChart({ snapshots, hours, onHoursChange }: TrafficChartProps) {
  const [activePoint, setActivePoint] = useState<number | null>(null);
  const data = useMemo(
    () =>
      snapshots.map((s) => ({
        time: new Date(s.timestamp).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
        }),
        active: s.active,
        reserve: s.reserve,
        latency: s.avgLatencyMs ?? 0,
      })),
    [snapshots]
  );

  return (
    <Card className={`chart-card chart-card--bold ${activePoint !== null ? "chart-card--focused" : ""}`}>
      <div className="chart-signal" aria-hidden="true"><span /><span /><span /></div>
      <CardHeader className="chart-card-header">
        <CardTitle>Pool Traffic Overview</CardTitle>
        <ToggleGroup type="single" value={String(hours)} onValueChange={(value) => value && onHoursChange(Number(value))} aria-label="Metrics time range">
          <ToggleGroupItem value="24">24 Hours</ToggleGroupItem>
          <ToggleGroupItem value="168">7 Days</ToggleGroupItem>
          <ToggleGroupItem value="720">30 Days</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent>
        {data.length < 2 ? (
          <p className="table-empty">Sync pools to start recording metrics history.</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-70 w-full">
            <AreaChart accessibilityLayer data={data} onMouseMove={(state) => setActivePoint(typeof state.activeTooltipIndex === "number" ? state.activeTooltipIndex : null)} onMouseLeave={() => setActivePoint(null)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="activeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-active)" stopOpacity={0.4} />
                <stop offset="100%" stopColor="var(--color-active)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} />
              <YAxis tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area type="monotone" dataKey="active" stroke="var(--color-active)" strokeWidth={2} fill="url(#activeGrad)" name="Active pools" />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
