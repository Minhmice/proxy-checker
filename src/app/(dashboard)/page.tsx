"use client";

import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { TokenUsageCard, TOKEN_USAGE_PERIODS } from "@/components/token-usage-card";
import { TokenHeatmapCard } from "@/components/token-heatmap-card";
import { AccountStatusCard } from "@/components/account-status-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AggregateQuotaCard } from "@/components/aggregate-quota-card";
import { Reveal } from "@/components/ui/reveal";

export default function DashboardPage() {
  const [period, setPeriod] = useState("today");
  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <Reveal order={0}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="max-w-6xl text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
            Usage overview
          </h1>
          <Button asChild variant="outline" className="min-h-11">
            <a href="https://9router.minhmice.com/dashboard/usage">
              9Router usage history <ArrowUpRight data-icon="inline-end" strokeWidth={1.5} />
            </a>
          </Button>
        </header>
      </Reveal>
      <Reveal order={1}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Usage period"
            className="flex flex-wrap rounded-md border border-border bg-card p-1"
          >
            {TOKEN_USAGE_PERIODS.map((option) => (
              <Button
                key={option.id}
                type="button"
                variant="plain"
                size="sm"
                aria-pressed={period === option.id}
                onClick={() => setPeriod(option.id)}
                className={cn(
                  "min-h-11 rounded-sm px-3 text-xs font-semibold transition-[background-color,color,scale] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-safe:active:scale-[0.96] motion-reduce:transition-none",
                  period === option.id && "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </Reveal>
      <TokenUsageCard
        period={period}
        accounts={
          <div className="grid gap-4">
            <AggregateQuotaCard />
            <AccountStatusCard />
          </div>
        }
      />
      <Reveal order={2}>
        <TokenHeatmapCard />
      </Reveal>
    </div>
  );
}
