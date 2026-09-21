"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "./sparkline";

interface MetricCardProps {
  label: string;
  value: string | number;
  sub: string;
  delta?: string;
  sparkData?: number[];
  sparkColor?: string;
}

export function MetricCard({ label, value, sub, delta, sparkData = [], sparkColor }: MetricCardProps) {
  return (
    <Card className="metric-card">
      <CardContent className="p-0">
        <span className="metric-card-label">{label}</span>
        <div className="metric-card-value">{value}</div>
        <span className="metric-card-sub">{sub}</span>
        {delta && <span className="metric-card-delta">{delta}</span>}
        {sparkData.length > 0 && <Sparkline data={sparkData} color={sparkColor} />}
      </CardContent>
    </Card>
  );
}
