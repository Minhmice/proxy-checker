"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGSAP } from "@gsap/react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ArrowLeftRight, RefreshCw } from "lucide-react";
import { useAuth } from "@/components/auth-provider";
import { fetchTokenUsage } from "@/lib/api";
import { formatTokens } from "@/components/ninerouter/mini-usage-card";
import type { AggregatedTokenUsage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DitherCard } from "@/components/dithercn/dither-card";
import { Button } from "@/components/ui/button";
import { RecentRequestsCard } from "@/components/recent-requests-card";
import { CardContent, CardHeader } from "@/components/ui/card";
import { DitherFade } from "@/components/dithercn/dither-fade";
import { DitherScroll } from "@/components/ui/dither-scroll";
import { Reveal } from "@/components/ui/reveal";

gsap.registerPlugin(useGSAP, ScrollTrigger);

const MATRIX_FONT: Record<string, number[][]> = {
  $: [
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 1],
    [1, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 1, 0, 1],
    [1, 1, 1, 1, 0],
    [0, 0, 1, 0, 0],
  ],
  "0": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "1": [
    [0, 0, 1, 0, 0],
    [0, 1, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 1, 1, 1, 0],
  ],
  "2": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [0, 0, 1, 1, 0],
    [0, 1, 0, 0, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
  ],
  "3": [
    [1, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
  ],
  "4": [
    [0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0],
    [0, 1, 0, 1, 0],
    [1, 0, 0, 1, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 1, 0],
  ],
  "5": [
    [1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "6": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 0],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "7": [
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1],
    [0, 0, 0, 1, 0],
    [0, 0, 1, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
    [0, 1, 0, 0, 0],
  ],
  "8": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  "9": [
    [0, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 1],
    [0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 1, 1, 0],
  ],
  ".": [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [1, 1],
    [1, 1],
  ],
  ",": [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 1],
    [1, 0],
  ],
  "+": [
    [0, 0, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 0, 0],
  ],
  "-": [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [1, 1, 1, 1, 1],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ],
  M: [
    [1, 0, 0, 0, 1],
    [1, 1, 0, 1, 1],
    [1, 0, 1, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
  ],
  K: [
    [1, 0, 0, 0, 1],
    [1, 0, 0, 1, 0],
    [1, 0, 1, 0, 0],
    [1, 1, 0, 0, 0],
    [1, 0, 1, 0, 0],
    [1, 0, 0, 1, 0],
    [1, 0, 0, 0, 1],
  ],
  B: [
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
    [1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [1, 1, 1, 1, 0],
  ],
  T: [
    [1, 1, 1, 1, 1],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 1, 0, 0],
  ],
  "—": [
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 1, 1, 1, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ],
};

MATRIX_FONT.m = MATRIX_FONT.M;
MATRIX_FONT.k = MATRIX_FONT.K;
MATRIX_FONT.b = MATRIX_FONT.B;
MATRIX_FONT.t = MATRIX_FONT.T;

interface DotMatrixDisplayProps {
  text: string;
  className?: string;
}

const SCRAMBLE_MS = 700;
const SCRAMBLE_STEP_MS = 45;

/** When `target` changes, digits flicker through random values and lock in left to right. */
function useScrambled(target: string) {
  const [text, setText] = useState(target);
  const previous = useRef(target);
  useEffect(() => {
    if (previous.current === target) return;
    previous.current = target;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(target);
      return;
    }
    const start = performance.now();
    let last = 0;
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / SCRAMBLE_MS);
      if (progress === 1) {
        setText(target);
        return;
      }
      if (now - last >= SCRAMBLE_STEP_MS) {
        last = now;
        const locked = Math.floor(progress * target.length);
        setText(
          target
            .split("")
            .map((ch, i) =>
              i < locked || !/\d/.test(ch) ? ch : String(Math.floor(Math.random() * 10)),
            )
            .join(""),
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return text;
}

function DotMatrixDisplay({ text: target, className }: DotMatrixDisplayProps) {
  const text = useScrambled(target);
  const { columns, viewBoxWidth, viewBoxHeight } = useMemo(() => {
    const chars = text.split("");
    const cols: number[][] = [];

    cols.push([0, 0, 0, 0, 0, 0, 0]);

    chars.forEach((ch, idx) => {
      if (ch === " ") {
        cols.push([0, 0, 0, 0, 0, 0, 0]);
        cols.push([0, 0, 0, 0, 0, 0, 0]);
        return;
      }

      const glyph = MATRIX_FONT[ch] || MATRIX_FONT[ch.toUpperCase()] || MATRIX_FONT["0"];
      const glyphCols = glyph[0]?.length || 5;

      for (let c = 0; c < glyphCols; c++) {
        const colData: number[] = [];
        for (let r = 0; r < 7; r++) {
          colData.push(glyph[r]?.[c] ?? 0);
        }
        cols.push(colData);
      }

      if (idx < chars.length - 1) {
        cols.push([0, 0, 0, 0, 0, 0, 0]);
      }
    });

    cols.push([0, 0, 0, 0, 0, 0, 0]);

    const dotRadius = 2.8;
    const dotGap = 7.5;
    const pad = 3;
    const width = (cols.length - 1) * dotGap + 2 * dotRadius + pad * 2;
    const height = (7 - 1) * dotGap + 2 * dotRadius + pad * 2;

    return { columns: cols, viewBoxWidth: width, viewBoxHeight: height };
  }, [text]);

  const cell = 5.6;
  const dotGap = 7.5;
  const pad = 3;

  return (
    <div className={cn("relative inline-block select-none", className)}>
      <svg
        viewBox={`0 0 ${viewBoxWidth.toFixed(1)} ${viewBoxHeight.toFixed(1)}`}
        className="size-auto h-16 w-auto max-w-full sm:h-20"
        aria-hidden="true"
      >
        <g className="inactive-dots" shapeRendering="crispEdges">
          {columns.map((col, c) =>
            col.map((_, r) => {
              const x = c * dotGap + pad;
              const y = r * dotGap + pad;
              return (
                <rect
                  key={`in-${c}-${r}`}
                  x={x.toFixed(1)}
                  y={y.toFixed(1)}
                  width={cell}
                  height={cell}
                  fill="var(--dither-ink)"
                  opacity={0.45}
                />
              );
            }),
          )}
        </g>

        <g className="active-dots" shapeRendering="crispEdges">
          {columns.map((col, c) =>
            col.map((isLit, r) => {
              if (isLit !== 1) return null;
              const x = c * dotGap + pad;
              const y = r * dotGap + pad;
              return (
                <rect
                  key={`act-${c}-${r}`}
                  x={x.toFixed(1)}
                  y={y.toFixed(1)}
                  width={cell}
                  height={cell}
                  fill="var(--ink)"
                />
              );
            }),
          )}
        </g>
      </svg>
    </div>
  );
}

export const TOKEN_USAGE_PERIODS = [
  { id: "today", label: "Today", fullLabel: "Today" },
  { id: "24h", label: "24h", fullLabel: "Last 24 hours" },
  { id: "7d", label: "7D", fullLabel: "Last 7 days" },
  { id: "30d", label: "30D", fullLabel: "Last 30 days" },
];

export function TokenUsageCard({
  period,
  accounts,
}: {
  period: string;
  accounts: React.ReactNode;
}) {
  const { password } = useAuth();
  const [snapshot, setSnapshot] = useState<AggregatedTokenUsage | null>(null);
  const [failure, setFailure] = useState<{ period: string; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [displayCost, setDisplayCost] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const data = snapshot?.period === period ? snapshot : null;
  const error = failure?.period === period ? failure.message : null;
  const label = TOKEN_USAGE_PERIODS.find((item) => item.id === period)?.fullLabel ?? period;

  useEffect(() => {
    let request: AbortController | undefined;
    async function load() {
      if (document.hidden || request) return;
      const controller = new AbortController();
      request = controller;
      try {
        const result = await fetchTokenUsage(
          password || undefined,
          period,
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        if (result.nodes.length && result.nodes.every((node) => !node.online)) {
          throw new Error("No 9Router node reported usage.");
        }
        setSnapshot(result);
        setFailure(null);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFailure({
            period,
            message: error instanceof Error ? error.message : "Usage request failed.",
          });
        }
      } finally {
        request = undefined;
      }
    }
    const initial = window.setTimeout(load, 0);
    const timer = window.setInterval(load, 30_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      request?.abort();
    };
  }, [period, password, refresh]);

  const value = data
    ? displayCost
      ? `$${data.totalCost.toFixed(2)}`
      : formatTokens(data.totalTokens)
    : "—";
  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        if (data)
          gsap.fromTo(
            "[data-matrix]",
            { opacity: 0.7, y: 3 },
            { opacity: 1, y: 0, duration: 0.24, ease: "power3.out" },
          );
      });
      return () => media.revert();
    },
    { scope: panel, dependencies: [value], revertOnUpdate: true },
  );

  useGSAP(
    () => {
      const media = gsap.matchMedia();
      media.add("(prefers-reduced-motion: no-preference)", () => {
        const trigger = panel.current;
        if (!trigger) return;
        const scroller = trigger.closest("#main-content");
        const scroll = {
          trigger,
          scroller: scroller ?? undefined,
          start: "top 95%",
          end: "top 30%",
          scrub: true,
        };

        gsap.fromTo(
          "[data-telemetry-context]",
          { opacity: 0.82 },
          { opacity: 1, ease: "none", scrollTrigger: scroll },
        );
      });
      return () => media.revert();
    },
    { scope: panel },
  );

  const models = useMemo(
    () =>
      Object.entries(data?.byModel ?? {})
        .filter(([, stats]) => stats.requests > 0)
        .map(([name, stats]) => ({
          name,
          ...stats,
          tokens: stats.promptTokens + stats.completionTokens + stats.cachedTokens,
        }))
        .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
    [data],
  );

  return (
    <div ref={panel} className="grid min-w-0 grid-flow-dense items-start gap-4 lg:grid-cols-12">
      <Reveal order={2} className="min-w-0 lg:col-span-7">
        <DitherCard
          glow="bottom-right"
          color="--primary"
          reach={260}
          interactive
          radius={16}
          className="min-w-0"
        >
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">
              {displayCost
                ? period === "today"
                  ? "Today's cost"
                  : "Cost"
                : period === "today"
                  ? "Tokens used today"
                  : "Tokens used"}
            </h2>
            <Button
              type="button"
              variant="plain"
              size="icon"
              className="group size-11 rounded-full text-muted-foreground hover:text-foreground"
              aria-label="Refresh telemetry"
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw
                strokeWidth={1.5}
                className="transition-transform duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] group-hover:rotate-180 motion-reduce:transition-none"
              />
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-3">
            {error && (
              <p role="status" className="text-sm text-muted-foreground">
                {data ? "Showing last known usage. " : "Usage unavailable. "}
                {error}
              </p>
            )}
            {!error && !data && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading usage…
              </p>
            )}
            {data?.nodes.some((node) => !node.online) && (
              <p role="status" className="text-sm text-muted-foreground">
                Partial usage: a 9Router node is offline.
              </p>
            )}
            <Button
              type="button"
              variant="plain"
              disabled={!data}
              onClick={() => setDisplayCost((value) => !value)}
              className="group h-auto w-fit max-w-full gap-2 bg-transparent p-1 hover:bg-transparent"
              aria-label={
                displayCost
                  ? `${value} USD. Show tokens`
                  : `${data?.totalTokens.toLocaleString() ?? "Unavailable"} tokens. Show cost`
              }
            >
              <span data-matrix className="min-w-0">
                <DotMatrixDisplay text={value} />
              </span>
              <ArrowLeftRight
                aria-hidden="true"
                strokeWidth={1.5}
                className="size-4 shrink-0 text-muted-foreground transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
              />
            </Button>
            {data && (
              <div data-telemetry-context className="text-sm text-muted-foreground tabular-nums">
                {label} · {data.totalRequests.toLocaleString()} requests
                {displayCost ? " · USD" : ` · ${formatTokens(data.totalCachedTokens)} cached`}
              </div>
            )}
          </CardContent>
        </DitherCard>
      </Reveal>
      <Reveal order={3} className="min-w-0 lg:col-span-7">
        <RecentRequestsCard />
      </Reveal>

      <Reveal order={3} className="min-w-0 lg:col-span-5 lg:row-span-3">
        <section aria-labelledby="account-quota" className="min-w-0">
          {accounts}
        </section>
      </Reveal>
      <Reveal order={4} className="min-w-0 lg:col-span-7">
        <DitherCard
          glow="top-right"
          color="--primary"
          reach={260}
          interactive
          radius={16}
          className="min-w-0"
        >
          <CardHeader>
            <h2 className="text-base font-semibold">
              {period === "today" ? "Models used today" : `Models used · ${label}`}
            </h2>
          </CardHeader>
          <CardContent className="relative min-w-0">
            <DitherScroll label="Model usage list" className="max-h-[min(20vh,24rem)] pb-12">
              {models.length ? (
                <ul className="divide-y divide-border">
                  {models.map((model, index) => (
                    <li
                      key={model.name}
                      style={{ "--row-order": Math.min(index, 8) } as React.CSSProperties}
                      className="row-enter grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="wrap-anywhere text-sm font-medium">{model.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {model.requests.toLocaleString()} requests
                        </p>
                      </div>
                      <span className="text-right text-sm font-medium tabular-nums">
                        {displayCost ? `$${model.cost.toFixed(4)}` : formatTokens(model.tokens)}
                        <span className="block text-xs text-muted-foreground">
                          {displayCost ? "USD" : "tokens"}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {data
                    ? "No model requests reported for this period."
                    : error
                      ? "Model usage unavailable."
                      : "Waiting for usage data…"}
                </p>
              )}
            </DitherScroll>
            {models.length > 0 && <DitherFade size={36} color="--card" className="right-[33px]!" />}
          </CardContent>
        </DitherCard>
      </Reveal>
    </div>
  );
}
