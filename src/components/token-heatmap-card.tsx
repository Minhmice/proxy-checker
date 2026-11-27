"use client";

import { useEffect, useState } from "react";
import { Heatmap } from "@/components/dithercn/heatmap";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatTokens } from "@/components/ninerouter/mini-usage-card";

interface UsageDay {
  date: string;
  value: number;
}

export function TokenHeatmapCard() {
  const [days, setDays] = useState<UsageDay[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/ninerouter/chart", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Usage chart unavailable");
        const rows: unknown = await response.json();
        if (!Array.isArray(rows) || rows.length !== 60) throw new Error("Invalid usage chart");
        const now = new Date();
        const data = rows.map((row: { label?: unknown; tokens?: unknown }) => {
          if (
            typeof row?.label !== "string" ||
            typeof row.tokens !== "number" ||
            !Number.isFinite(row.tokens) ||
            row.tokens < 0
          )
            throw new Error("Invalid usage chart entry");
          let date = new Date(`${row.label}, ${now.getUTCFullYear()} 00:00:00 UTC`);
          if (Number.isNaN(date.getTime())) throw new Error("Invalid usage chart date");
          if (date.getTime() > now.getTime() + 2 * 86400000)
            date = new Date(`${row.label}, ${now.getUTCFullYear() - 1} 00:00:00 UTC`);
          return { date: date.toISOString().slice(0, 10), value: row.tokens };
        });
        setDays(data);
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void load();
    const timer = window.setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);

  const latest = days?.at(-1)?.date;
  const month = latest?.slice(0, 7);
  const monthly = days?.filter((day) => day.date.startsWith(`${month}-`)) ?? [];
  const total = monthly.reduce((sum, day) => sum + day.value, 0);
  const monthLabel = latest
    ? new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
        new Date(`${latest}T00:00:00Z`),
      )
    : "";

  return (
    <Card>
      <CardHeader className="gap-1">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Token activity</h2>
          <span className="text-xs text-muted-foreground">{monthLabel} · 9Router</span>
        </div>
        {days && (
          <p className="text-sm text-muted-foreground">
            <span className="font-semibold tabular-nums text-foreground">
              {formatTokens(total)}
            </span>{" "}
            tokens this month · {formatTokens(total / Math.max(monthly.length, 1))} per day on
            average
          </p>
        )}
      </CardHeader>
      <CardContent>
        {error && (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            Unable to refresh 9Router usage{days ? "; showing previous data." : "."}
          </p>
        )}
        {days ? (
          <Heatmap
            data={days}
            weeks={6}
            weekStart={1}
            color="--primary"
            unit="tokens"
            cell={4}
            animate={false}
          />
        ) : (
          !error && <p className="text-sm text-muted-foreground">Loading token activity…</p>
        )}
      </CardContent>
    </Card>
  );
}
