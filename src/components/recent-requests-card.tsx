"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/components/auth-provider";
import { DitherCard } from "@/components/dithercn/dither-card";
import { formatTokens } from "@/components/ninerouter/mini-usage-card";
import { CardContent, CardHeader } from "@/components/ui/card";
import { DitherScroll } from "@/components/ui/dither-scroll";
import { Skeleton } from "@/components/ui/skeleton";
import { Status, StatusIndicator } from "@/components/ui/status";
import { fetchRecentRequests } from "@/lib/api";
import {
  LARGE_INPUT_TOKENS,
  formatAgo,
  isLargeRequest,
  keyRequests,
  type KeyedRequest,
} from "@/lib/recent-requests";
import { cn } from "@/lib/utils";

const POLL_MS = 2_000;
const COLUMNS = "grid grid-cols-[0.5rem_minmax(0,1fr)_auto_4.75rem] items-center gap-x-3 px-3";

type Row = KeyedRequest & { fresh: boolean };

export function RecentRequestsCard() {
  const { password } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    let request: AbortController | undefined;
    async function load() {
      if (document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      try {
        const { requests } = await fetchRecentRequests(password || undefined, controller.signal);
        if (controller.signal.aborted) return;
        const keyed = keyRequests(requests);
        const previous = seen.current;
        const next = new Set(keyed.map((item) => item.key));
        seen.current = next;
        setError(null);
        // The first load only seeds history: opening the dashboard never replays old alerts.
        if (!previous) return setRows(keyed.map((item) => ({ ...item, fresh: false })));
        const arrived = keyed.filter((item) => !previous.has(item.key));
        if (!arrived.length) return;
        for (const item of arrived) {
          if (!isLargeRequest(item)) continue;
          toast.warning(`Large request: ${item.promptTokens.toLocaleString()} input tokens`, {
            id: item.key,
            description: `${item.model} exceeded ${LARGE_INPUT_TOKENS.toLocaleString()} tokens`,
            duration: 12_000,
          });
        }
        const fresh = new Set(arrived.map((item) => item.key));
        setNow(Date.now());
        setRows(keyed.map((item) => ({ ...item, fresh: fresh.has(item.key) })));
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : "Recent requests failed.");
        }
      } finally {
        request = undefined;
      }
    }
    const initial = window.setTimeout(load, 0);
    const poll = window.setInterval(load, POLL_MS);
    const clock = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(poll);
      window.clearInterval(clock);
      document.removeEventListener("visibilitychange", load);
      request?.abort();
    };
  }, [password]);

  const live = !error;

  return (
    <DitherCard
      glow="bottom-left"
      color="--primary"
      reach={240}
      interactive
      radius={16}
      className="min-w-0"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Recent requests</h2>
        <Status variant={live ? "success" : "warning"} aria-live="off">
          <StatusIndicator pulse={live} />
          {live ? "Live" : "Reconnecting"}
        </Status>
      </CardHeader>
      <CardContent className="min-w-0">
        {error && (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {rows ? "Showing last known requests. " : "Requests unavailable. "}
            {error}
          </p>
        )}
        <div
          aria-hidden="true"
          className={cn(
            COLUMNS,
            "h-9 border-b border-border text-xs font-semibold uppercase tracking-wider text-muted-foreground",
          )}
        >
          <span />
          <span>Model</span>
          <span className="text-right">In / Out</span>
          <span className="text-right">When</span>
        </div>
        <DitherScroll label="Recent requests" className="max-h-[min(36vh,22rem)] pb-4">
          {rows === null ? (
            <div aria-hidden="true" className="grid gap-3 px-3 py-3">
              {[0, 1, 2, 3, 4].map((index) => (
                <Skeleton key={index} className="h-4 w-full" />
              ))}
            </div>
          ) : rows.length ? (
            <ul aria-label="Recent requests" className="divide-y divide-border/50">
              {rows.map((row, index) => {
                const large = isLargeRequest(row);
                const ok = row.status === "ok" || row.status === "success";
                return (
                  <li
                    key={row.key}
                    data-large={large}
                    style={
                      {
                        "--row-order": row.fresh ? 0 : Math.min(index, 8),
                        animationDelay: row.fresh ? "0ms" : undefined,
                      } as React.CSSProperties
                    }
                    className={cn(
                      COLUMNS,
                      "row-enter py-2.5 text-xs transition-colors duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] hover:bg-white/[0.025]",
                      row.fresh && "request-flash",
                      large && "bg-warning/10",
                    )}
                  >
                    <span className={cn("size-1.5 rounded-full", ok ? "bg-success" : "bg-error")}>
                      <span className="sr-only">{ok ? "Succeeded" : "Failed"}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-zinc-200" title={row.model}>
                        {row.model}
                      </span>
                      {large && (
                        <Status variant="warning" className="px-1.5 py-0 text-[0.625rem]">
                          Large
                        </Status>
                      )}
                    </span>
                    <span
                      className="flex items-center justify-end gap-2 whitespace-nowrap tabular-nums"
                      title={`${row.promptTokens.toLocaleString()} in, ${row.completionTokens.toLocaleString()} out`}
                    >
                      <span
                        className={cn(
                          "inline-flex items-center",
                          large ? "font-semibold text-warning" : "text-primary",
                        )}
                      >
                        {row.promptTokens >= 100_000
                          ? formatTokens(row.promptTokens)
                          : row.promptTokens.toLocaleString()}
                        <ArrowUp aria-label="input" className="size-3" strokeWidth={1.5} />
                      </span>
                      <span className="inline-flex items-center text-success">
                        {row.completionTokens.toLocaleString()}
                        <ArrowDown aria-label="output" className="size-3" strokeWidth={1.5} />
                      </span>
                    </span>
                    <span className="text-right whitespace-nowrap tabular-nums text-muted-foreground">
                      {formatAgo(row.timestamp, now)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-6 text-sm text-muted-foreground">
              {error
                ? "Recent requests unavailable."
                : "No requests yet. New requests appear here as they arrive."}
            </p>
          )}
        </DitherScroll>
      </CardContent>
    </DitherCard>
  );
}
