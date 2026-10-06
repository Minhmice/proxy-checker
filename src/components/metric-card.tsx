"use client";

import * as React from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "./sparkline";
import { cn } from "@/lib/utils";

interface MetricCardProps {
  label: string;
  value: string | number;
  sub: string;
  delta?: string;
  sparkData?: number[];
  sparkColor?: string;
  icon?: React.ReactNode;
  badgeVariant?: "default" | "secondary" | "outline" | "destructive";
  className?: string;
}

export function MetricCard({
  label,
  value,
  sub,
  delta,
  sparkData = [],
  sparkColor = "oklch(0.62 0.19 255)",
  icon,
  badgeVariant = "outline",
  className,
}: MetricCardProps) {
  return (
    <Card className={cn("relative overflow-hidden border-border bg-card/90 shadow-sm backdrop-blur-xs transition-all duration-200 hover:border-primary/40 hover:shadow-md", className)}>
      <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {icon && (
          <div className="flex size-7 items-center justify-center rounded-md border border-border-subtle bg-surface-raised/70 text-muted-foreground shadow-2xs">
            {icon}
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-0">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-3xl font-bold tracking-tight text-ink font-mono">
            {value}
          </div>
          {sparkData.length > 0 && (
            <div className="shrink-0 opacity-90 transition-opacity hover:opacity-100">
              <Sparkline data={sparkData} color={sparkColor} width={92} height={38} />
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 pt-1 border-t border-border-subtle/60 text-xs text-muted-foreground">
          <span className="truncate">{sub}</span>
          {delta && (
            <Badge variant={badgeVariant} className="font-mono text-[10px] px-1.5 py-0 h-4 shrink-0 font-medium">
              {delta}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
