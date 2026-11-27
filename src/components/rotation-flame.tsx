"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import { Fire } from "@/components/dithercn/fire";

const PALETTE = ["transparent", "--dither-ink", "--primary"] as const;

export function RotationFlame() {
  const reducedMotion = useReducedMotion();
  const [finished, setFinished] = useState(false);

  if (finished) return null;

  return (
    <motion.div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-4"
      initial={false}
      animate={reducedMotion ? { opacity: 0.65 } : { opacity: [0.65, 1, 0] }}
      transition={
        reducedMotion ? { duration: 0 } : { duration: 1.2, times: [0, 0.2, 1], ease: "easeOut" }
      }
      onAnimationComplete={() => {
        if (!reducedMotion) setFinished(true);
      }}
    >
      <Fire
        className="absolute inset-0"
        palette={PALETTE}
        height={0.8}
        intensity={0.7}
        embers={0}
        cell={2}
        fps={24}
      />
    </motion.div>
  );
}
