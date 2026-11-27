"use client";

import { useEffect, useState, type CSSProperties } from "react";

import {
  cssColor,
  DitherShader,
  ditherMaskStyle,
  fillStyle,
  type DitherColor,
  type DitherMatrix,
  type DitherShaderProps,
} from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * Dither language for the whole app. Ambient texture uses the dim neutral
 * `ink`; data and active state use a named colour or `--primary`.
 * Shaders: at most one per surface (backdrop, hero glow). Everything else is
 * static CSS masks, which cost nothing after first paint.
 */

type ShaderRest = Omit<DitherShaderProps, "field" | "colorField" | "uniforms" | "fallback">;

// ---- Backdrop: slow contour field -----------------------------------------

const BACKDROP_FIELD = `
float bdHeight(vec2 p) {
  return 0.5 + 0.35 * snoise(p * 0.9) + 0.15 * snoise(p * 2.1);
}

float bdContour(float h, float hx, float hy, float count, float width) {
  float offset = abs(fract(h * count + 0.5) - 0.5);
  float perCell = max(length(vec2(hx - h, hy - h)) * count, 1e-4);
  float line = 1.0 - smoothstep(width * 0.5 - 0.5, width * 0.5 + 0.5, offset / perCell);
  return line * (1.0 - smoothstep(0.06, 0.1, offset));
}

float field(vec2 uv, vec2 res, float t) {
  vec2 p = vec2(uv.x * res.x / res.y, uv.y) * bdScale + vec2(t * 0.012, t * 0.005);
  float s = bdScale / res.y;
  float h = bdHeight(p);
  float lines = bdContour(h, bdHeight(p + vec2(s, 0.0)), bdHeight(p + vec2(0.0, s)), bdLines, 1.5);
  float haze = smoothstep(0.55, 1.0, h) * 0.4;
  return bdIntensity * max(lines, haze);
}
`;

export type DitherBackdropProps = ShaderRest & {
  /** Peak tone, 0 to 1. Default 0.3 (quiet enough to sit behind text). */
  intensity?: number;
  /** Feature size; bigger numbers give smaller terrain. Default 1.4. */
  scale?: number;
  /** Contour lines across the height range. Default 9. */
  lines?: number;
};

/** Full-box contour terrain. Place in a positioned parent; content goes in a sibling above. */
export function DitherBackdrop({
  intensity = 0.3,
  scale = 1.4,
  lines = 9,
  palette = ["--dither-paper", "--dither-ink"],
  className,
  ...props
}: DitherBackdropProps) {
  return (
    <DitherShader
      {...props}
      field={BACKDROP_FIELD}
      palette={palette}
      fps={24}
      stillTime={8}
      uniforms={{ bdIntensity: intensity, bdScale: scale, bdLines: lines }}
      className={cn("absolute inset-0", className)}
      fallback={<div className="absolute inset-0 bg-dither-paper" />}
    />
  );
}

// ---- Glow: drifting cloud light for hero cards ----------------------------

const GLOW_FIELD = `
float field(vec2 uv, vec2 res, float t) {
  // Measured in cells (90 cells = 1 unit), so the glow keeps one size on tall phone cards.
  vec2 q = uv * res / 90.0;
  // focus.x: fraction of width; focus.y: units of 90 cells below the top edge.
  vec2 f = vec2(glowFocus.x * res.x / 90.0, (res.y - glowFocus.y * 90.0) / 90.0);
  float light = exp(-dot(q - f, q - f) * glowTightness);
  float clouds = fbm(q * 2.5 + vec2(t * 0.03, -t * 0.015));
  return glowIntensity * light * mix(0.55, 1.15, clouds);
}
`;

export type DitherGlowProps = ShaderRest & {
  /** Light position: [fraction of width from the left, units of 90 cells below the top]. Default [0.9, 0.1]. */
  focus?: readonly [number, number];
  /** Peak tone, 0 to 1. Default 0.7. */
  intensity?: number;
  /** How tightly the light gathers; bigger is tighter. Default 5. Radius is about 1/sqrt(n) units of 90 cells. */
  tightness?: number;
};

/** Soft dithered light in one corner of a card. Text above stays on near-clear ground. */
export function DitherGlow({
  focus = [0.9, 0.1],
  intensity = 0.7,
  tightness = 5,
  palette = ["transparent", "--dither-ink", "--primary"],
  matrix = "bayer8",
  className,
  ...props
}: DitherGlowProps) {
  return (
    <DitherShader
      {...props}
      field={GLOW_FIELD}
      palette={palette}
      matrix={matrix}
      fps={20}
      stillTime={6}
      uniforms={{ glowFocus: focus, glowIntensity: intensity, glowTightness: tightness }}
      className={cn("absolute inset-0", className)}
      fallback={<div className="absolute inset-0" />}
    />
  );
}

// ---- Static layers (no JS after paint) ------------------------------------

type LayerProps = {
  /** Share of cells inked, 0 to 1. Default 0.25. */
  level?: number;
  color?: DitherColor;
  matrix?: DitherMatrix;
  /** Cell size in CSS px. Default `--dither-cell`. */
  cell?: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * An empty absolute layer masked to one dither level. Cross-fade two layers
 * with `opacity` for hover states; the mask itself does not transition.
 * The parent needs `relative`; content goes in a sibling.
 */
export function DitherLayer({
  level = 0.25,
  color = "ink",
  matrix,
  cell,
  className,
  style,
}: LayerProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        backgroundColor: cssColor(color),
        ...ditherMaskStyle(level, { matrix, cell }),
        ...style,
      }}
    />
  );
}

/** Section transition: dense at `edge`, fading to a faint floor grain. */
export function DitherDivider({
  color = "ink",
  edge = "top",
  length = 8,
  cell = 2,
  className,
}: {
  color?: DitherColor;
  edge?: "top" | "bottom" | "left" | "right";
  length?: number;
  cell?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("h-2 w-full opacity-40", className)}
      style={fillStyle("gradient", { color, edge, length, cell })}
    />
  );
}

/**
 * Track and fill for a meter. Put inside an element that is `relative
 * overflow-hidden` and carries `role="progressbar"` and the aria values.
 */
export function DitherBar({
  percent,
  color = "--primary",
  cell = 2,
  className,
  delay = 0,
}: {
  /** 0 to 100. Clamped. */
  percent: number;
  color?: DitherColor;
  cell?: number;
  className?: string;
  /** Milliseconds before the fill first grows from 0. */
  delay?: number;
}) {
  const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const width = grown ? value : 0;
  return (
    <>
      <div
        aria-hidden="true"
        className={cn("absolute inset-0 opacity-45", className)}
        style={fillStyle("dotted", { color: "grey", cell })}
      />
      <div
        aria-hidden="true"
        className="absolute inset-y-0 left-0 overflow-hidden transition-[width] duration-1000 ease-out motion-reduce:transition-none"
        style={{ width: `${width}%`, transitionDelay: grown ? `${delay}ms` : "0ms" }}
      >
        <div
          className="absolute inset-0"
          style={fillStyle("gradient", {
            color,
            edge: "right",
            length: 14,
            from: 1,
            to: 0.5,
            cell,
          })}
        />
        <span
          className="absolute inset-y-0 left-0 w-1/3 animate-[bar-sweep_2.4s_ease-in-out_infinite] motion-reduce:hidden"
          style={{
            animationDelay: `${delay + 1000}ms`,
            background:
              "linear-gradient(90deg, transparent, color-mix(in oklab, var(--background) 70%, transparent), transparent)",
          }}
        />
        <span
          className="absolute inset-y-0 right-0 w-0.5 bg-background animate-[bar-tip_1.2s_ease-in-out_infinite] motion-reduce:animate-none"
          style={{ opacity: width > 0 ? 1 : 0 }}
        />
      </div>
    </>
  );
}
