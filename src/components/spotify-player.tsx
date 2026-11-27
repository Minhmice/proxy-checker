"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Pause, Play, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { DitherCard } from "@/components/dithercn/dither-card";
import { Button } from "@/components/ui/button";
import { DitherLayer } from "@/components/ui/dither";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchSpotifyNow, sendSpotifyAction } from "@/lib/api";
import { fillStyle } from "@/lib/dither";
import { controlMessage, formatClock, statusMessage } from "@/lib/spotify-ui";
import type { SpotifyAction, SpotifyNow } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 3_000;
/** Spotify applies a command a moment after it answers, so read the state back after this. */
const SETTLE_MS = 600;
const RING_LEVELS = [0.125, 0.375, 0.75] as const;

/** Spotify's own glyph (Simple Icons, CC0). Attribution is required beside Spotify content. */
function SpotifyMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn("size-4 shrink-0", className)}
      fill="currentColor"
    >
      <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
  );
}

interface Anchor {
  progressMs: number;
  at: number;
}

/** Polls Spotify, ticks the progress locally between polls, and sends controls. */
function useSpotify() {
  const [now, setNow] = useState<SpotifyNow | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [pending, setPending] = useState<SpotifyAction | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const anchor = useRef<Anchor>({ at: Date.now(), progressMs: 0 });
  const request = useRef<AbortController | null>(null);
  const settle = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (document.hidden || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    try {
      const next = await fetchSpotifyNow(controller.signal);
      if (controller.signal.aborted) return;
      anchor.current = { at: Date.now(), progressMs: next.progressMs };
      setNow(next);
      setUnreachable(false);
    } catch {
      if (!controller.signal.aborted) setUnreachable(true);
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const poll = window.setInterval(() => void refresh(), POLL_MS);
    const onVisible = () => void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(poll);
      window.clearTimeout(settle.current);
      document.removeEventListener("visibilitychange", onVisible);
      request.current?.abort();
    };
  }, [refresh]);

  const playing = now?.status === "ready" && now.playing;
  useEffect(() => {
    if (!playing) return;
    const tick = window.setInterval(() => {
      if (!document.hidden) setClock(Date.now());
    }, 1_000);
    return () => window.clearInterval(tick);
  }, [playing]);

  const act = useCallback(
    async (action: SpotifyAction) => {
      if (pending) return;
      setPending(action);
      try {
        await sendSpotifyAction(action);
        if (action === "play" || action === "pause") {
          const at = Date.now();
          setNow((current) => (current ? { ...current, playing: action === "play" } : current));
          // Freeze or resume the local progress from where it is right now.
          anchor.current = {
            at,
            progressMs: anchor.current.progressMs + (playing ? at - anchor.current.at : 0),
          };
          setClock(at);
        }
        window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => void refresh(), SETTLE_MS);
      } catch (error) {
        toast.error(controlMessage(error instanceof Error ? error.message : "upstream"), {
          id: "spotify-control",
        });
      } finally {
        setPending(null);
      }
    },
    [pending, playing, refresh],
  );

  const progressMs =
    now?.status === "ready"
      ? Math.min(
          now.durationMs || Number.POSITIVE_INFINITY,
          anchor.current.progressMs + (playing ? Math.max(0, clock - anchor.current.at) : 0),
        )
      : 0;

  return { act, now, pending, progressMs, unreachable };
}

/** Dither ring that ignites in three stepped levels behind the cover, never over it. */
function Ring({ playing }: { playing: boolean }) {
  return (
    <div
      aria-hidden="true"
      data-playing={playing}
      className="sp-ring pointer-events-none absolute -inset-1.5"
    >
      {RING_LEVELS.map((value, index) => (
        <DitherLayer
          key={value}
          level={value}
          color="--primary"
          cell={3}
          className="rounded-[14px]"
          style={{ "--l": index } as CSSProperties}
        />
      ))}
    </div>
  );
}

function Progress({ progressMs, durationMs }: { progressMs: number; durationMs: number }) {
  const percent = durationMs > 0 ? Math.min(100, (progressMs / durationMs) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-10 shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {formatClock(progressMs)}
      </span>
      <div
        role="progressbar"
        aria-label="Track progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationMs / 1000)}
        aria-valuenow={Math.round(progressMs / 1000)}
        aria-valuetext={`${formatClock(progressMs)} of ${formatClock(durationMs)}`}
        className="relative h-2 min-w-0 flex-1 overflow-hidden"
      >
        <div
          aria-hidden="true"
          className="absolute inset-0 opacity-45"
          style={fillStyle("dotted", { cell: 2, color: "grey" })}
        />
        <div
          aria-hidden="true"
          className="sp-fill absolute inset-0"
          style={{
            ...fillStyle("gradient", {
              cell: 2,
              color: "--primary",
              edge: "right",
              from: 1,
              length: 14,
              to: 0.5,
            }),
            clipPath: `inset(0 ${100 - percent}% 0 0)`,
          }}
        />
      </div>
      <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {formatClock(durationMs)}
      </span>
    </div>
  );
}

/**
 * Now-playing card for the sign-in page: cover, title, progress, play/pause and next.
 * Cover art stays exactly as Spotify serves it (no overlay, blur, crop or animation) with the
 * 4px/8px corners their guidelines ask for; all the motion happens around it.
 */
export function SpotifyPlayer({ className, style }: { className?: string; style?: CSSProperties }) {
  const { act, now, pending, progressMs, unreachable } = useSpotify();
  const ready = now?.status === "ready";
  const playing = ready && now.playing;
  const message = statusMessage(now, unreachable);
  const canControl = ready && now.canControl && pending === null;

  return (
    <DitherCard
      glow="bottom-left"
      color="--primary"
      reach={220}
      strength={playing ? 0.4 : 0.16}
      radius={16}
      className={cn("min-w-0 gap-0 py-0", className)}
      style={style}
    >
      <div className="flex gap-4 p-4 sm:p-5">
        <div className="relative size-20 shrink-0 sm:size-24">
          {ready ? <Ring key={now.trackId ?? "none"} playing={playing} /> : null}
          {ready && now.art ? (
            <img
              src={now.art}
              alt={now.album ? `Cover of ${now.album}` : "Album cover"}
              width={96}
              height={96}
              className="relative size-full rounded-[4px] object-contain lg:rounded-[8px]"
            />
          ) : (
            <Skeleton className="relative size-full rounded-[4px] lg:rounded-[8px]" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-between gap-3">
          {ready ? (
            <div key={now.trackId ?? "none"} className="min-w-0">
              <p className="auth-line text-base font-semibold leading-snug">
                <span className="truncate" style={{ "--i": 0 } as CSSProperties} title={now.title}>
                  {now.title}
                </span>
              </p>
              <p className="auth-line text-sm leading-snug text-muted-foreground">
                <span className="truncate" style={{ "--i": 1 } as CSSProperties} title={now.artist}>
                  {now.artist || "Unknown artist"}
                </span>
              </p>
              {now.device ? (
                <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                  on {now.device}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="min-w-0">
              <p className="text-sm font-semibold">Spotify</p>
              {message ? (
                <p role="status" className="mt-1 text-sm leading-snug text-muted-foreground">
                  {message}
                </p>
              ) : (
                <div aria-hidden="true" className="mt-2 grid gap-2">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              )}
            </div>
          )}

          {ready ? <Progress progressMs={progressMs} durationMs={now.durationMs} /> : null}

          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="icon"
              variant="default"
              className="size-11"
              disabled={!canControl}
              aria-label={playing ? "Pause" : "Play"}
              onClick={() => void act(playing ? "pause" : "play")}
            >
              {playing ? (
                <Pause fill="currentColor" strokeWidth={0} />
              ) : (
                <Play fill="currentColor" strokeWidth={0} />
              )}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-11"
              disabled={!canControl}
              aria-label="Next track"
              onClick={() => void act("next")}
            >
              <SkipForward fill="currentColor" strokeWidth={2} />
            </Button>
            <span className="min-w-0 flex-1" />
            {ready && now.url ? (
              <a
                href={now.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium whitespace-nowrap text-foreground/80 transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <SpotifyMark />
                <span>Open Spotify</span>
              </a>
            ) : (
              <span className="inline-flex min-h-11 shrink-0 items-center gap-1.5 px-2 text-xs font-medium whitespace-nowrap text-muted-foreground">
                <SpotifyMark />
                <span>Spotify</span>
              </span>
            )}
          </div>
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {ready && now.title ? `Now playing: ${now.title} by ${now.artist}` : ""}
      </p>
    </DitherCard>
  );
}
