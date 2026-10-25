"use client";

import * as React from "react";
import { motion } from "motion/react";
import { HaloCard, type HaloThemeVariant } from "@/components/ui/halo-card";
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
  sparkColor = "#FF5B22",
  icon,
  badgeVariant = "outline",
  className,
}: MetricCardProps) {
  const haloVariant: HaloThemeVariant =
    badgeVariant === "destructive" || sparkColor === "#EF4444"
      ? "rose"
      : badgeVariant === "outline" || sparkColor === "#FF8A50"
        ? "amber"
        : "flame";

  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="h-full"
    >
      <HaloCard variant={haloVariant} padding="none" className={cn("h-full text-white", className)}>
        <div className="p-5 flex flex-col justify-between h-full relative">
          <div
            className="absolute top-0 inset-x-0 h-[2px] opacity-80 rounded-t-2xl"
            style={{ background: sparkColor }}
          />
          <div className="flex flex-row items-center justify-between pb-2 space-y-0">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {label}
            </span>
            {icon && (
              <div className="flex size-7 items-center justify-center rounded-md border border-border/80 bg-surface-raised/80 text-foreground shadow-2xs">
                {icon}
              </div>
            )}
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <span
                  className="relative flex size-2 shrink-0 items-center justify-center"
                  aria-hidden="true"
                >
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden"
                    style={{ backgroundColor: sparkColor }}
                  />
                  <span
                    className="relative inline-flex size-1.5 rounded-full"
                    style={{ backgroundColor: sparkColor }}
                  />
                </span>
                <span className="text-3xl font-bold tracking-tight text-ink font-mono tabular-nums">
                  {value == null || value === "" ? "—" : value}
                </span>
              </div>
              {sparkData && sparkData.length >= 2 && (
                <div className="shrink-0 opacity-90 transition-opacity hover:opacity-100">
                  <Sparkline
                    data={sparkData}
                    color={sparkColor}
                    width={92}
                    height={38}
                    label={`${label} trend`}
                  />
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 pt-1 border-t border-border-subtle/60 text-xs text-muted-foreground">
              <span className="truncate">{sub}</span>
              {delta && (
                <Badge
                  variant={badgeVariant}
                  className="font-mono text-[10px] px-1.5 py-0 h-4 shrink-0 font-medium"
                >
                  <span className="sr-only">Trend: </span>
                  {delta}
                </Badge>
              )}
            </div>
          </div>
        </div>
      </HaloCard>
    </motion.div>
  );
}
