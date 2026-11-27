"use client";

import { useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";

const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);

/**
 * Counts up to `value` in step with DitherBar's one second fill. Later changes count from the
 * last shown value, so a refresh nudges the number instead of replaying it. Writes its own text
 * node, so React renders it empty; reduced motion writes the value at once.
 */
export function CountUp({
  value,
  delay = 0,
  format = oneDecimal,
}: {
  value: number;
  /** Milliseconds before the first count from 0. */
  delay?: number;
  format?: (value: number) => string;
}) {
  const node = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  useLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    const write = (next: number) => {
      shown.current = next;
      el.textContent = format(next);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      write(value);
      return;
    }
    const state = { v: shown.current };
    write(state.v);
    const tween = gsap.to(state, {
      v: value,
      duration: 1,
      delay: state.v === 0 ? delay / 1000 : 0,
      ease: "power2.out",
      onUpdate: () => write(state.v),
    });
    return () => {
      tween.kill();
    };
  }, [value, delay, format]);
  return <span ref={node} className="tabular-nums" />;
}
