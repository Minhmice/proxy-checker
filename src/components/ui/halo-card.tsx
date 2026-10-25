"use client";

/**
 * Composable card with animated gradient rim, frosted surface, and Obsidian Flame theme:
 * Animated gradient rim, frosted fill, layered shadow, and fine-hover polish.
 *
 * @example
 * <HaloCard aria-label="Example">
 *   <HaloCardHeader>
 *     <HaloCardTitle>Title</HaloCardTitle>
 *     <HaloCardDescription>Body copy.</HaloCardDescription>
 *   </HaloCardHeader>
 *   <HaloCardContent>Optional main area.</HaloCardContent>
 *   <HaloCardFooter>
 *     <HaloCardButton variant="secondary">Cancel</HaloCardButton>
 *     <HaloCardButton variant="primary">Continue</HaloCardButton>
 *   </HaloCardFooter>
 * </HaloCard>
 */
import * as React from "react";
import {
  forwardRef,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";

import { cn } from "@/lib/utils";

export type HaloThemeVariant = "flame" | "amber" | "emerald" | "rose";

const paddingClass = {
  none: "",
  sm: "p-4",
  md: "p-6",
  lg: "p-8",
} as const;

const BORDER_TRAIL_LOOP_MS = 5250;

export interface BorderGlowConfig {
  opacityIdle: number;
  primaryBg: string;
  secondaryBg: string;
  tertiaryBg: string;
  primaryLeft: string[];
  secondaryLeft: string[];
  tertiaryLeft: string[];
  durationMain: number;
  durationSec: number;
  durationTer: number;
  trailAmbient: string;
  trailCore: string;
  ambientShadow: string;
  coreShadow: string;
  ringShadow: string;
}
function borderGlowConfig(
  translucent: boolean,
  rimEmphasis: boolean,
  variant: HaloThemeVariant = "flame",
) {
  let idleOpacity: number;
  if (translucent) {
    idleOpacity = rimEmphasis ? 0.95 : 0.72;
  } else {
    idleOpacity = rimEmphasis ? 0.82 : 0.52;
  }

  if (variant === "amber") {
    return {
      opacityIdle: idleOpacity,
      primaryBg: "linear-gradient(90deg, #FFB522, #FF8A50, #F59E0B, #FF5B22)",
      secondaryBg: "linear-gradient(90deg, #F59E0B, #FDE047, #FF8A50)",
      tertiaryBg: "linear-gradient(90deg, #FF8A50, #FFB522, #F59E0B)",
      primaryLeft: ["-5%", "75%", "-5%"],
      secondaryLeft: ["65%", "10%", "65%"],
      tertiaryLeft: ["25%", "55%", "25%"],
      durationMain: 6,
      durationSec: 5,
      durationTer: 4,
      trailAmbient:
        "linear-gradient(90deg, transparent 0%, rgba(245,158,11,0) 6%, rgba(245,158,11,0.38) 24%, rgba(255,138,80,0.5) 50%, rgba(255,181,34,0.42) 76%, rgba(255,181,34,0) 94%, transparent 100%)",
      trailCore:
        "linear-gradient(90deg, transparent 0%, rgba(245,158,11,0.72) 20%, rgba(253,224,71,0.92) 50%, rgba(255,181,34,0.78) 80%, transparent 100%)",
      ambientShadow:
        "0 0 22px rgba(245,158,11,0.28), 0 0 44px rgba(255,181,34,0.18), 0 0 2px rgba(255,255,255,0.12)",
      coreShadow:
        "0 0 14px rgba(245,158,11,0.35), 0 0 28px rgba(255,181,34,0.32), inset 0 0 1px rgba(255,255,255,0.22)",
      ringShadow: "rgba(245,158,11,0.25)",
    };
  }

  if (variant === "emerald") {
    return {
      opacityIdle: idleOpacity,
      primaryBg: "linear-gradient(90deg, #10B981, #059669, #34D399, #047857)",
      secondaryBg: "linear-gradient(90deg, #34D399, #6EE7B7, #10B981)",
      tertiaryBg: "linear-gradient(90deg, #059669, #34D399, #10B981)",
      primaryLeft: ["-5%", "75%", "-5%"],
      secondaryLeft: ["65%", "10%", "65%"],
      tertiaryLeft: ["25%", "55%", "25%"],
      durationMain: 6,
      durationSec: 5,
      durationTer: 4,
      trailAmbient:
        "linear-gradient(90deg, transparent 0%, rgba(16,185,129,0) 6%, rgba(16,185,129,0.38) 24%, rgba(52,211,153,0.5) 50%, rgba(110,231,183,0.42) 76%, rgba(110,231,183,0) 94%, transparent 100%)",
      trailCore:
        "linear-gradient(90deg, transparent 0%, rgba(16,185,129,0.72) 20%, rgba(110,231,183,0.92) 50%, rgba(52,211,153,0.78) 80%, transparent 100%)",
      ambientShadow:
        "0 0 22px rgba(16,185,129,0.28), 0 0 44px rgba(52,211,153,0.18), 0 0 2px rgba(255,255,255,0.12)",
      coreShadow:
        "0 0 14px rgba(16,185,129,0.35), 0 0 28px rgba(52,211,153,0.32), inset 0 0 1px rgba(255,255,255,0.22)",
      ringShadow: "rgba(16,185,129,0.25)",
    };
  }

  if (variant === "rose") {
    return {
      opacityIdle: idleOpacity,
      primaryBg: "linear-gradient(90deg, #EF4444, #DC2626, #F87171, #B91C1C)",
      secondaryBg: "linear-gradient(90deg, #F87171, #FCA5A5, #EF4444)",
      tertiaryBg: "linear-gradient(90deg, #DC2626, #F87171, #EF4444)",
      primaryLeft: ["-5%", "75%", "-5%"],
      secondaryLeft: ["65%", "10%", "65%"],
      tertiaryLeft: ["25%", "55%", "25%"],
      durationMain: 6,
      durationSec: 5,
      durationTer: 4,
      trailAmbient:
        "linear-gradient(90deg, transparent 0%, rgba(239,68,68,0) 6%, rgba(239,68,68,0.38) 24%, rgba(248,113,113,0.5) 50%, rgba(252,165,165,0.42) 76%, rgba(252,165,165,0) 94%, transparent 100%)",
      trailCore:
        "linear-gradient(90deg, transparent 0%, rgba(239,68,68,0.72) 20%, rgba(252,165,165,0.92) 50%, rgba(248,113,113,0.78) 80%, transparent 100%)",
      ambientShadow:
        "0 0 22px rgba(239,68,68,0.28), 0 0 44px rgba(248,113,113,0.18), 0 0 2px rgba(255,255,255,0.12)",
      coreShadow:
        "0 0 14px rgba(239,68,68,0.35), 0 0 28px rgba(248,113,113,0.32), inset 0 0 1px rgba(255,255,255,0.22)",
      ringShadow: "rgba(239,68,68,0.25)",
    };
  }

  // Default: Signature Theme "flame" (Obsidian Flame from globals.css: #FF5B22, #FF3D00, #FF6830, #FF8A50)
  return {
    opacityIdle: idleOpacity,
    primaryBg: "linear-gradient(90deg, #FF5B22, #FF3D00, #FF8A50, #D82600)",
    secondaryBg: "linear-gradient(90deg, #FF6830, #FFB522, #FF5B22)",
    tertiaryBg: "linear-gradient(90deg, #FF3D00, #FF8A50, #FF6830)",
    primaryLeft: ["-5%", "75%", "-5%"],
    secondaryLeft: ["65%", "10%", "65%"],
    tertiaryLeft: ["25%", "55%", "25%"],
    durationMain: 6,
    durationSec: 5,
    durationTer: 4,
    trailAmbient:
      "linear-gradient(90deg, transparent 0%, rgba(255,91,34,0) 6%, rgba(255,91,34,0.38) 24%, rgba(255,104,48,0.5) 50%, rgba(255,181,34,0.42) 76%, rgba(255,181,34,0) 94%, transparent 100%)",
    trailCore:
      "linear-gradient(90deg, transparent 0%, rgba(255,91,34,0.72) 20%, rgba(255,138,80,0.92) 50%, rgba(255,181,34,0.78) 80%, transparent 100%)",
    ambientShadow:
      "0 0 22px rgba(255,91,34,0.28), 0 0 44px rgba(255,181,34,0.18), 0 0 2px rgba(255,255,255,0.12)",
    coreShadow:
      "0 0 14px rgba(255,91,34,0.35), 0 0 28px rgba(255,181,34,0.32), inset 0 0 1px rgba(255,255,255,0.22)",
    ringShadow: "rgba(255,91,34,0.28)",
  };
}
/** Moving rim highlight along the card edge (mask = border band only). */
function HaloCardBorderTrail({ active, config }: { active: boolean; config: BorderGlowConfig }) {
  const progress = useMotionValue(0);
  const offsetDistance = useTransform(progress, (v: number) => {
    const wrapped = ((v % 100) + 100) % 100;
    return `${wrapped}%`;
  });

  useEffect(() => {
    if (!active) {
      return;
    }
    let rafId = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      const next = progress.get() + (dt / BORDER_TRAIL_LOOP_MS) * 100;
      progress.set(((next % 100) + 100) % 100);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [active, progress]);

  const pathCornerRadiusPx = 16;
  const trailLengthPx = 184;
  const trailThicknessPx = 32;

  const trailBox = {
    height: trailThicknessPx,
    offsetPath: `rect(0 auto auto 0 round ${pathCornerRadiusPx}px)`,
    width: trailLengthPx,
  } as const;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask-image:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]",
        active ? "visible opacity-100" : "invisible opacity-0 transition-opacity duration-300",
      )}
    >
      {/* Wide soft bloom — ties into frosted card edge */}
      <motion.div
        className="absolute opacity-95 dark:opacity-[0.98]"
        style={{
          ...trailBox,
          filter: "blur(12px)",
          offsetDistance,
        }}
      >
        <div
          className="size-full rounded-[999px]"
          style={{
            background: config.trailAmbient,
            boxShadow: config.ambientShadow,
          }}
        />
      </motion.div>
      {/* Brighter core — higher-opacity read without a hard capsule edge */}
      <motion.div
        className="absolute dark:opacity-[0.94]"
        style={{
          ...trailBox,
          filter: "blur(4px)",
          offsetDistance,
        }}
      >
        <div
          className="size-full rounded-[999px]"
          style={{
            background: config.trailCore,
            boxShadow: config.coreShadow,
          }}
        />
      </motion.div>
    </div>
  );
}

function GradientRimPillBlobs({
  borderGlow,
  reduceMotion,
}: {
  borderGlow: BorderGlowConfig;
  reduceMotion: boolean;
}) {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-full">
      <motion.div
        animate={{
          opacity: reduceMotion ? borderGlow.opacityIdle * 0.82 : borderGlow.opacityIdle,
        }}
        className="absolute inset-x-0 bottom-0 h-1/2"
        transition={{ duration: 0.25, ease: "easeOut" }}
      >
        <motion.div
          animate={{
            left: borderGlow.primaryLeft,
          }}
          className="-bottom-5 absolute h-20 w-56 blur-2xl"
          style={{
            background: borderGlow.primaryBg,
          }}
          transition={{
            duration: reduceMotion ? 0.01 : borderGlow.durationMain,
            repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
            ease: "easeInOut",
          }}
        />
        <motion.div
          animate={{
            left: borderGlow.secondaryLeft,
          }}
          className="-bottom-4 absolute h-16 w-40 blur-xl"
          style={{
            background: borderGlow.secondaryBg,
          }}
          transition={{
            duration: reduceMotion ? 0.01 : borderGlow.durationSec,
            repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
            ease: "easeInOut",
          }}
        />
        <motion.div
          animate={{
            left: borderGlow.tertiaryLeft,
          }}
          className="-bottom-3 absolute h-14 w-32 blur-lg"
          style={{
            background: borderGlow.tertiaryBg,
          }}
          transition={{
            duration: reduceMotion ? 0.01 : borderGlow.durationTer,
            repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
            ease: "easeInOut",
          }}
        />
      </motion.div>
    </div>
  );
}

function fillBackgroundFor(translucent: boolean, interactive: boolean, rimEmphasis: boolean) {
  if (translucent) {
    if (interactive && rimEmphasis) {
      return "linear-gradient(to bottom, color-mix(in oklch, var(--card) 90%, transparent) 0%, color-mix(in oklch, var(--card) 78%, transparent) 100%)";
    }
    return "linear-gradient(to bottom, color-mix(in oklch, var(--card) 85%, transparent) 0%, color-mix(in oklch, var(--card) 72%, transparent) 100%)";
  }
  if (interactive && rimEmphasis) {
    return "linear-gradient(to bottom, var(--card) 0%, color-mix(in oklch, var(--card) 92%, var(--muted)) 100%)";
  }
  return "linear-gradient(to bottom, var(--card) 0%, color-mix(in oklch, var(--card) 96%, var(--muted)) 100%)";
}

export interface HaloCardProps extends ComponentProps<"div"> {
  children: ReactNode;
  /** Frosted inner surface so gradient blobs read through. */
  translucent?: boolean;
  /** Hover + rim emphasis on the animated edge. */
  interactive?: boolean;
  /** Padding inside the card surface. */
  padding?: keyof typeof paddingClass;
  /** Color theme variant matching globals.css (default: "flame") */
  variant?: HaloThemeVariant;
}

const HaloCard = forwardRef<HTMLDivElement, HaloCardProps>(function HaloCard(
  {
    children,
    className,
    translucent = true,
    interactive = true,
    padding = "md",
    variant = "flame",
    "aria-label": ariaLabel = "Card",
    onBlur,
    onFocus,
    onMouseEnter,
    onMouseLeave,
    ...props
  },
  ref,
) {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocusedWithin, setIsFocusedWithin] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  const rimEmphasis = interactive && (isHovered || isFocusedWithin);

  const borderGlow = useMemo(
    () => borderGlowConfig(translucent, rimEmphasis, variant),
    [translucent, rimEmphasis, variant],
  );

  const fillBackground = useMemo(
    () => fillBackgroundFor(translucent, interactive, rimEmphasis),
    [translucent, interactive, rimEmphasis],
  );

  const showTrailChrome = interactive && !reduceMotion;
  const trailActive = isHovered || isFocusedWithin;

  return (
    <div
      aria-label={ariaLabel}
      className={cn("relative w-full max-w-full", className)}
      data-slot="halo-card"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setIsFocusedWithin(false);
        }
        onBlur?.(e);
      }}
      onFocus={(e) => {
        if (interactive) {
          setIsFocusedWithin(true);
        }
        onFocus?.(e);
      }}
      onMouseEnter={(e) => {
        if (interactive) {
          setIsHovered(true);
        }
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        setIsHovered(false);
        onMouseLeave?.(e);
      }}
      ref={ref}
      role="group"
      {...props}
    >
      <div className="relative rounded-2xl p-px">
        {/* Animated Gradient Blobs in Bottom Rim */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-2xl">
          <motion.div
            animate={{
              opacity: reduceMotion ? borderGlow.opacityIdle * 0.82 : borderGlow.opacityIdle,
            }}
            className="absolute inset-x-0 bottom-0 h-[58%]"
            transition={{ duration: 0.25, ease: "easeOut" }}
          >
            <motion.div
              animate={{
                left: borderGlow.primaryLeft,
              }}
              className="-bottom-10 absolute h-32 w-88 blur-2xl"
              style={{
                background: borderGlow.primaryBg,
              }}
              transition={{
                duration: reduceMotion ? 0.01 : borderGlow.durationMain,
                repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
                ease: "easeInOut",
              }}
            />
            <motion.div
              animate={{
                left: borderGlow.secondaryLeft,
              }}
              className="-bottom-7 absolute h-24 w-52 blur-2xl"
              style={{
                background: borderGlow.secondaryBg,
              }}
              transition={{
                duration: reduceMotion ? 0.01 : borderGlow.durationSec,
                repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
                ease: "easeInOut",
              }}
            />
            <motion.div
              animate={{
                left: borderGlow.tertiaryLeft,
              }}
              className="-bottom-5 absolute h-20 w-44 blur-xl"
              style={{
                background: borderGlow.tertiaryBg,
              }}
              transition={{
                duration: reduceMotion ? 0.01 : borderGlow.durationTer,
                repeat: reduceMotion ? 0 : Number.POSITIVE_INFINITY,
                ease: "easeInOut",
              }}
            />
          </motion.div>
        </div>

        {/* Frosted Card Surface */}
        <div
          className={cn(
            "relative z-0 flex flex-col gap-6 rounded-[15px] border border-border/80",
            "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.35),0_4px_20px_rgba(0,0,0,0.35)]",
            "outline-none transition-[background-color,backdrop-filter,border-color,box-shadow] duration-200 ease-out",
            interactive &&
              "hover:border-primary/50 hover:shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_2px_6px_rgba(0,0,0,0.42),0_8px_28px_rgba(255,91,34,0.18)]",
            interactive &&
              "focus-within:border-primary/70 focus-within:shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_2px_6px_rgba(0,0,0,0.42),0_8px_28px_rgba(255,91,34,0.22)]",
            translucent && "backdrop-blur-xl backdrop-saturate-150",
            padding !== "none" && paddingClass[padding],
          )}
          data-slot="halo-card-surface"
          style={{ background: fillBackground }}
        >
          {children}
        </div>

        {/* Moving Border Trail */}
        {showTrailChrome ? (
          <div className="pointer-events-none absolute inset-0 z-10 rounded-2xl">
            <HaloCardBorderTrail active={trailActive} config={borderGlow} />
          </div>
        ) : null}
      </div>
    </div>
  );
});

HaloCard.displayName = "HaloCard";

function HaloCardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid auto-rows-min items-start gap-x-4 gap-y-1.5",
        "has-[>[data-slot=halo-card-action]]:grid-cols-[1fr_auto]",
        "has-[>[data-slot=halo-card-description]]:grid-rows-[auto_auto]",
        className,
      )}
      data-slot="halo-card-header"
      {...props}
    />
  );
}
HaloCardHeader.displayName = "HaloCardHeader";

const HaloCardTitle = forwardRef<HTMLHeadingElement, ComponentProps<"h3">>(function HaloCardTitle(
  { className, ...props },
  ref,
) {
  return (
    <h3
      className={cn(
        "col-start-1 row-start-1 text-balance font-semibold text-foreground text-lg leading-tight tracking-tight antialiased",
        className,
      )}
      data-slot="halo-card-title"
      ref={ref}
      {...props}
    />
  );
});
HaloCardTitle.displayName = "HaloCardTitle";

const HaloCardDescription = forwardRef<HTMLParagraphElement, ComponentProps<"p">>(
  function HaloCardDescription({ className, ...props }, ref) {
    return (
      <p
        className={cn(
          "col-start-1 row-start-2 text-pretty text-muted-foreground text-sm leading-relaxed",
          className,
        )}
        data-slot="halo-card-description"
        ref={ref}
        {...props}
      />
    );
  },
);
HaloCardDescription.displayName = "HaloCardDescription";

function HaloCardAction({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)}
      data-slot="halo-card-action"
      {...props}
    />
  );
}
HaloCardAction.displayName = "HaloCardAction";

function HaloCardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex min-h-0 flex-col gap-3", className)}
      data-slot="halo-card-content"
      {...props}
    />
  );
}
HaloCardContent.displayName = "HaloCardContent";

function HaloCardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-wrap items-center justify-end gap-2", className)}
      data-slot="halo-card-footer"
      {...props}
    />
  );
}
HaloCardFooter.displayName = "HaloCardFooter";

export interface HaloCardButtonProps extends ComponentProps<"button"> {
  children: ReactNode;
  /**
   * `primary` — animated gradient rim + frosted fill (matches card chrome).
   * `secondary` — muted surface, high-contrast `text-foreground`, subtle gradient ring.
   */
  variant?: "primary" | "secondary";
  size?: "default" | "icon";
  glowVariant?: HaloThemeVariant;
}

const HaloCardButton = forwardRef<HTMLButtonElement, HaloCardButtonProps>(function HaloCardButton(
  {
    children,
    className,
    variant = "primary",
    size = "default",
    glowVariant = "flame",
    disabled,
    onFocus,
    onBlur,
    onMouseEnter,
    onMouseLeave,
    style,
    type = "button",
    ...props
  },
  ref,
) {
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  const rimEmphasis = isHovered || isFocused;

  const borderGlow = useMemo(
    () => borderGlowConfig(true, rimEmphasis, glowVariant),
    [rimEmphasis, glowVariant],
  );

  const fillBackground = useMemo(() => fillBackgroundFor(true, true, rimEmphasis), [rimEmphasis]);

  if (variant === "secondary") {
    return (
      <div
        className={cn("relative inline-flex max-w-full", className)}
        data-slot="halo-card-button"
        data-variant="secondary"
      >
        <div
          className={cn(
            "rounded-full p-px transition-opacity duration-200 ease-out",
            "hover:opacity-100 opacity-95",
            "[background:linear-gradient(135deg,rgba(255,91,34,0.38),rgba(255,61,0,0.28),rgba(255,181,34,0.35))]",
          )}
        >
          <button
            className={cn(
              "relative flex min-w-0 select-none items-center justify-center rounded-full cursor-pointer",
              "border border-border/80 bg-surface-raised font-medium text-foreground text-sm tracking-tight antialiased",
              "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.3)]",
              "hover:border-primary/50 hover:bg-surface-raised/90 hover:text-white",
              "outline-none transition-[background-color,border-color,box-shadow,color,transform] duration-200 ease-out",
              "focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/30",
              "enabled:active:scale-[0.96] motion-reduce:enabled:active:scale-100",
              "disabled:pointer-events-none disabled:opacity-50",
              size === "icon" ? "size-11 p-0 [&_svg]:shrink-0" : "min-h-10 px-5 py-2",
            )}
            disabled={disabled}
            onBlur={(e) => {
              setIsFocused(false);
              onBlur?.(e);
            }}
            onFocus={(e) => {
              setIsFocused(true);
              onFocus?.(e);
            }}
            onMouseEnter={(e) => {
              setIsHovered(true);
              onMouseEnter?.(e);
            }}
            onMouseLeave={(e) => {
              setIsHovered(false);
              onMouseLeave?.(e);
            }}
            ref={ref}
            type={type}
            {...props}
          >
            {children}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn("relative inline-flex max-w-full", className)}
      data-slot="halo-card-button"
      data-variant="primary"
    >
      <div className="relative rounded-full p-px">
        <GradientRimPillBlobs borderGlow={borderGlow} reduceMotion={reduceMotion} />
        <button
          className={cn(
            "relative flex min-w-0 select-none items-center justify-center rounded-full cursor-pointer",
            "border border-border/80",
            "shadow-[0_1px_0_rgba(255,255,255,0.06)_inset,0_1px_2px_rgba(0,0,0,0.35),0_4px_20px_rgba(0,0,0,0.35)]",
            "outline-none transition-[transform,background-color,backdrop-filter,border-color,box-shadow] duration-200 ease-out",
            "hover:border-primary/60 hover:shadow-[0_1px_0_rgba(255,255,255,0.08)_inset,0_4px_12px_rgba(0,0,0,0.45),0_8px_24px_rgba(255,91,34,0.3)]",
            "focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/30",
            "enabled:active:scale-[0.96] motion-reduce:enabled:active:scale-100",
            "disabled:pointer-events-none disabled:opacity-50",
            "backdrop-blur-xl backdrop-saturate-150",
            "font-medium text-foreground text-sm tracking-tight antialiased",
            size === "icon" ? "size-11 p-0 [&_svg]:shrink-0" : "min-h-10 gap-2 px-5 py-2",
          )}
          disabled={disabled}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onMouseEnter={(e) => {
            setIsHovered(true);
            onMouseEnter?.(e);
          }}
          onMouseLeave={(e) => {
            setIsHovered(false);
            onMouseLeave?.(e);
          }}
          ref={ref}
          style={{
            ...style,
            background: fillBackground,
          }}
          type={type}
          {...props}
        >
          {children}
        </button>
      </div>
    </div>
  );
});

HaloCardButton.displayName = "HaloCardButton";
export {
  HaloCard,
  HaloCardAction,
  HaloCardButton,
  HaloCardContent,
  HaloCardDescription,
  HaloCardFooter,
  HaloCardHeader,
  HaloCardTitle,
};
