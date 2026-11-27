"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Section entrance: rises and fades in once, the first time it scrolls into view. `order`
 * staggers siblings by 80ms each. The motion is CSS (see `[data-reveal]` in globals.css), so it
 * stays interruptible and reduced motion shows the content at once.
 */
export function Reveal({
  order = 0,
  className,
  children,
}: {
  order?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -6% 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      data-reveal={shown ? "shown" : "pending"}
      style={{ "--reveal-order": order } as CSSProperties}
      className={className}
    >
      {children}
    </div>
  );
}
