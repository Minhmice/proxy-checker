"use client";

import { useEffect, useState, type ReactNode } from "react";
import { startBrowserMocks } from "@/mocks/start-browser";

export function MockBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(
    process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_ENABLE_API_MOCKS !== "true",
  );

  useEffect(() => {
    if (ready) return;
    startBrowserMocks()
      .then(() => setReady(true))
      .catch(() => setReady(true));
  }, [ready]);

  if (!ready) {
    return null;
  }

  return <>{children}</>;
}
