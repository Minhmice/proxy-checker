"use client";

import { CheckCircle2, AlertTriangle, XCircle, Globe } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ProxySummaryFacets {
  all: number;
  working: number;
  regressed: number;
  dead: number;
}

export interface ProxySummaryProps {
  facets: ProxySummaryFacets;
  activeHealth: "all" | "working" | "regressed" | "dead";
  onHealthChange: (health: "all" | "working" | "regressed" | "dead") => void;
}

export function ProxySummary({ facets, activeHealth, onHealthChange }: ProxySummaryProps) {
  const pills = [
    {
      id: "all" as const,
      label: "All",
      icon: Globe,
      count: facets.all,
      activeClass:
        "bg-primary text-primary-foreground border-primary shadow-[0_0_16px_rgba(255,91,34,0.35)] font-semibold",
      inactiveClass:
        "bg-surface hover:bg-surface-raised text-muted-foreground border-border/70 hover:border-primary/40",
    },
    {
      id: "working" as const,
      label: "Healthy",
      icon: CheckCircle2,
      count: facets.working,
      activeClass:
        "bg-emerald-500/20 text-emerald-400 border-emerald-500/60 shadow-[0_0_15px_oklch(0.82_0.22_145/0.35)] font-semibold",
      inactiveClass:
        "bg-surface hover:bg-surface-raised text-emerald-400/80 border-border/70 hover:border-emerald-500/40",
    },
    {
      id: "regressed" as const,
      label: "Regressed",
      icon: AlertTriangle,
      count: facets.regressed,
      activeClass:
        "bg-amber-500/20 text-amber-400 border-amber-500/60 shadow-[0_0_15px_oklch(0.80_0.18_80/0.35)] font-semibold",
      inactiveClass:
        "bg-surface hover:bg-surface-raised text-amber-400/80 border-border/70 hover:border-amber-500/40",
    },
    {
      id: "dead" as const,
      label: "Dead",
      icon: XCircle,
      count: facets.dead,
      activeClass:
        "bg-rose-500/20 text-rose-400 border-rose-500/60 shadow-[0_0_15px_oklch(0.68_0.24_25/0.35)] font-semibold",
      inactiveClass:
        "bg-surface hover:bg-surface-raised text-rose-400/80 border-border/70 hover:border-rose-500/40",
    },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {pills.map((pill) => {
        const Icon = pill.icon;
        const isActive = activeHealth === pill.id;

        return (
          <button
            key={pill.id}
            type="button"
            onClick={() => onHealthChange(pill.id)}
            className={cn(
              "flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-medium transition-all duration-150 cursor-pointer min-h-[36px]",
              isActive ? pill.activeClass : pill.inactiveClass,
            )}
            aria-pressed={isActive}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{pill.label}</span>
            <span
              className={cn(
                "font-mono text-[11px] px-1.5 py-0.2 rounded-full",
                isActive ? "bg-black/25 text-inherit" : "bg-muted/40 text-muted-foreground",
              )}
            >
              {pill.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}
