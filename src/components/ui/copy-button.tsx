"use client";

import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "error";

export interface CopyButtonProps {
  value: string;
  label: string;
  className?: string;
  size?: React.ComponentProps<typeof Button>["size"];
}

export function CopyButton({ value, label, className, size = "sm" }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>("idle");
  const resetRef = useRef<number | undefined>(undefined);
  const requestRef = useRef(0);

  useEffect(
    () => () => {
      requestRef.current += 1;
      window.clearTimeout(resetRef.current);
    },
    [],
  );

  async function handleCopy() {
    if (!value) return;
    const request = ++requestRef.current;
    window.clearTimeout(resetRef.current);

    try {
      await navigator.clipboard.writeText(value);
      if (request !== requestRef.current) return;
      setState("copied");
    } catch {
      if (request !== requestRef.current) return;
      setState("error");
    }
    resetRef.current = window.setTimeout(() => setState("idle"), 2200);
  }

  const statusLabel =
    state === "copied"
      ? `${label} copied`
      : state === "error"
        ? `Could not copy ${label.toLowerCase()}`
        : `Copy ${label}`;

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={() => void handleCopy()}
      aria-label={statusLabel}
      title={statusLabel}
      className={cn("gap-1.5", className)}
    >
      {state === "copied" ? (
        <Check className="size-3.5 text-emerald-400" aria-hidden="true" />
      ) : state === "error" ? (
        <X className="size-3.5 text-destructive" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
      <span className="sr-only sm:not-sr-only">
        {state === "copied" ? "Copied" : state === "error" ? "Retry" : "Copy"}
      </span>
    </Button>
  );
}
