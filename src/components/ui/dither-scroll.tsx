"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cssColor, ditherMaskStyle, fillStyle } from "@/lib/dither";
import type { DitherColor } from "@/lib/dither";
import { cn } from "@/lib/utils";

const CELL = 3;
const MIN_THUMB = 30;
const STEPS = 4;
/** Opacity snaps to quarter steps so the glow ignites in stages, like the dither grid. */
const stepped = (value: number) => Math.ceil(Math.min(1, Math.max(0, value)) * STEPS) / STEPS;

/**
 * Scroll region with its own rail in a reserved gutter, so the bar never covers content.
 * The thumb is a half-dither block snapped to whole cells. Scroll speed ignites it to solid
 * and throws a dithered tail behind it in the direction of travel; both decay in stepped
 * frames. Reduced motion keeps the static thumb only.
 */
export function DitherScroll({
  label,
  color = "--primary",
  className,
  children,
}: {
  label: string;
  color?: DitherColor;
  className?: string;
  children: ReactNode;
}) {
  const view = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const dense = useRef<HTMLDivElement>(null);
  const before = useRef<HTMLDivElement>(null);
  const after = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewEl = view.current;
    const railEl = rail.current;
    const thumbEl = thumb.current;
    const denseEl = dense.current;
    const beforeEl = before.current;
    const afterEl = after.current;
    if (!viewEl || !railEl || !thumbEl || !denseEl || !beforeEl || !afterEl) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let heat = 0;
    let last = viewEl.scrollTop;
    let drag: { y: number; top: number } | null = null;

    const place = () => {
      const { scrollHeight, clientHeight, scrollTop } = viewEl;
      const range = scrollHeight - clientHeight;
      railEl.dataset.active = String(range > 1);
      if (range <= 1) return;
      const track = railEl.clientHeight;
      const size = Math.min(
        track,
        Math.max(MIN_THUMB, Math.round((track * clientHeight) / scrollHeight)),
      );
      const offset = Math.round(((track - size) * scrollTop) / range / CELL) * CELL;
      thumbEl.style.height = `${size}px`;
      thumbEl.style.transform = `translateY(${offset}px)`;
    };

    const paint = () => {
      heat *= 0.88;
      if (Math.abs(heat) < 0.03) heat = 0;
      const live = reduce.matches ? 0 : heat;
      denseEl.style.opacity = String(stepped(Math.abs(live) * 1.5));
      beforeEl.style.opacity = String(stepped(live * 1.2));
      afterEl.style.opacity = String(stepped(-live * 1.2));
      frame = heat === 0 ? 0 : requestAnimationFrame(paint);
    };

    const onScroll = () => {
      place();
      heat = Math.max(-1, Math.min(1, heat + (viewEl.scrollTop - last) / 48));
      last = viewEl.scrollTop;
      if (!frame) frame = requestAnimationFrame(paint);
    };

    const onDown = (event: PointerEvent) => {
      event.preventDefault();
      thumbEl.setPointerCapture(event.pointerId);
      drag = { y: event.clientY, top: viewEl.scrollTop };
      railEl.dataset.drag = "true";
    };
    const onMove = (event: PointerEvent) => {
      if (!drag) return;
      const travel = railEl.clientHeight - thumbEl.offsetHeight;
      if (travel <= 0) return;
      viewEl.scrollTop =
        drag.top +
        ((event.clientY - drag.y) * (viewEl.scrollHeight - viewEl.clientHeight)) / travel;
    };
    const onUp = () => {
      drag = null;
      delete railEl.dataset.drag;
    };
    const onTrack = (event: PointerEvent) => {
      if (event.target instanceof Node && thumbEl.contains(event.target)) return;
      const box = thumbEl.getBoundingClientRect();
      viewEl.scrollBy({
        top: (event.clientY < box.top ? -1 : 1) * viewEl.clientHeight * 0.9,
        behavior: reduce.matches ? "auto" : "smooth",
      });
    };

    const observer = new ResizeObserver(place);
    observer.observe(viewEl);
    if (viewEl.firstElementChild) observer.observe(viewEl.firstElementChild);
    place();
    viewEl.addEventListener("scroll", onScroll, { passive: true });
    thumbEl.addEventListener("pointerdown", onDown);
    thumbEl.addEventListener("pointermove", onMove);
    thumbEl.addEventListener("pointerup", onUp);
    thumbEl.addEventListener("pointercancel", onUp);
    railEl.addEventListener("pointerdown", onTrack);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      viewEl.removeEventListener("scroll", onScroll);
      thumbEl.removeEventListener("pointerdown", onDown);
      thumbEl.removeEventListener("pointermove", onMove);
      thumbEl.removeEventListener("pointerup", onUp);
      thumbEl.removeEventListener("pointercancel", onUp);
      railEl.removeEventListener("pointerdown", onTrack);
    };
  }, []);

  return (
    <div className="flex min-w-0">
      <div
        ref={view}
        role="region"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable region must be keyboard accessible
        tabIndex={0}
        aria-label={label}
        className={cn(
          "min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden focus-visible:outline-2 focus-visible:outline-ring",
          className,
        )}
      >
        {children}
      </div>
      <div
        ref={rail}
        aria-hidden="true"
        data-active="false"
        className="group relative ml-3 w-[9px] shrink-0 select-none overflow-hidden data-[active=false]:hidden"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={fillStyle("dotted", { color: "grey", cell: CELL })}
        />
        <div
          ref={thumb}
          className="absolute inset-x-0 top-0 cursor-grab touch-none group-data-[drag=true]:cursor-grabbing"
        >
          <div
            ref={before}
            className="pointer-events-none absolute inset-x-0 bottom-full h-9 opacity-0"
            style={fillStyle("gradient", { color, edge: "bottom", length: 12, cell: CELL })}
          />
          <div
            ref={after}
            className="pointer-events-none absolute inset-x-0 top-full h-9 opacity-0"
            style={fillStyle("gradient", { color, edge: "top", length: 12, cell: CELL })}
          />
          <div
            className="absolute inset-0 opacity-60 transition-opacity duration-150 ease-[cubic-bezier(0.25,1,0.5,1)] group-hover:opacity-100 group-data-[drag=true]:opacity-100 motion-reduce:transition-none"
            style={{ ...ditherMaskStyle(0.5, { cell: CELL }), backgroundColor: cssColor(color) }}
          />
          <div
            ref={dense}
            className="absolute inset-0 opacity-0"
            style={{ backgroundColor: cssColor(color) }}
          />
        </div>
      </div>
    </div>
  );
}
