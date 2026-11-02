"use client";

import React, { useState } from "react";
import Link from "next/link";
import { BarChart3, Globe, Shuffle, RefreshCw, Zap } from "lucide-react";
import { TokenUsageCard, TOKEN_USAGE_PERIODS } from "@/components/token-usage-card";
import { AccountProxyStatusCard } from "@/components/account-proxy-status-card";
import { Button } from "@/components/ui/button";

export default function DashboardPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [period, setPeriod] = useState("today");
  const handleRefreshAll = () => {
    setRefreshKey((prev) => prev + 1);
  };

  return (
    <div className="space-y-6 w-full max-w-none 4xl:max-w-[3600px] mx-auto pb-12">
      {/* Top Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#23232C] pb-5">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-zinc-100 flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-[#FF5B22]/15 text-[#FF5B22] border border-[#FF5B22]/30 shadow-[0_0_16px_rgba(255,91,34,0.25)]">
              <BarChart3 className="size-5" />
            </span>
            Dashboard
          </h1>
          <p className="text-xs sm:text-sm text-zinc-400 mt-1">
            Real-time daily token &amp; cost analytics, Antigravity session quotas, and proxy
            binding telemetry.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <div
            role="group"
            aria-label="Token usage period"
            className="flex items-center bg-[#131318] border border-[#23232C] rounded-xl p-0.5 gap-0.5"
          >
            {TOKEN_USAGE_PERIODS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={period === option.id}
                onClick={() => setPeriod(option.id)}
                className={
                  period === option.id
                    ? "h-8 px-2.5 text-xs font-semibold rounded-lg bg-[#FF5B22]/15 text-white"
                    : "h-8 px-2.5 text-xs font-semibold rounded-lg text-zinc-400 hover:text-white"
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-300 hover:text-white hover:border-[#FF5B22]/40 gap-1.5 text-xs font-semibold rounded-xl transition-colors"
          >
            <Link href="/proxies">
              <Globe className="size-3.5 text-[#FF5B22]" />
              <span>Proxies</span>
            </Link>
          </Button>

          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-300 hover:text-white hover:border-[#FF5B22]/40 gap-1.5 text-xs font-semibold rounded-xl transition-colors"
          >
            <Link href="/bindings">
              <Shuffle className="size-3.5 text-[#FF5B22]" />
              <span>Bindings</span>
            </Link>
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleRefreshAll}
            className="h-9 border-[#23232C] bg-[#131318] text-zinc-100 hover:text-white hover:border-[#FF5B22]/40 gap-1.5 text-xs font-semibold rounded-xl transition-colors cursor-pointer disabled:opacity-90 disabled:text-zinc-200"
          >
            <RefreshCw className="size-3.5" />
            <span>Refresh All</span>
          </Button>
        </div>
      </div>

      {/* KHU VỰC 1: Token & Cost Telemetry Analysis */}
      <section aria-label="Token & Cost Analytics" key={`token-${refreshKey}`}>
        <TokenUsageCard period={period} />
      </section>

      {/* KHU VỰC 2: Antigravity Accounts & Proxy Binding Status */}
      <section aria-label="Account & Proxy Status" key={`status-${refreshKey}`}>
        <AccountProxyStatusCard />
      </section>
    </div>
  );
}
