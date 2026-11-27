"use client";

import type { ReactNode } from "react";

import { DitherBackdrop } from "@/components/ui/dither";
import { cn } from "@/lib/utils";

/**
 * Page frame with one fixed dithered contour field behind everything.
 * Replaces the old canvas grid: same slot, same children contract.
 */
export default function DitherFrame({
  children,
  className,
  intensity = 0.14,
}: {
  children?: ReactNode;
  className?: string;
  intensity?: number;
}) {
  return (
    <div
      className={cn(
        "relative isolate min-h-screen w-full overflow-hidden bg-background",
        className,
      )}
    >
      <DitherBackdrop className="fixed inset-0 z-0" intensity={intensity} />
      <div className="relative z-10 h-full w-full">{children}</div>
    </div>
  );
}
