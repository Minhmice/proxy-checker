"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const statusVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors border",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/30 text-muted-foreground",
        success: "border-success/30 bg-success/15 text-success",
        error: "border-error/30 bg-error/15 text-error",
        warning: "border-warning/30 bg-warning/15 text-warning",
        info: "border-primary/30 bg-primary/15 text-primary",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface StatusProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof statusVariants> {}

export function Status({ className, variant, ...props }: StatusProps) {
  return (
    <span
      data-slot="status"
      className={cn(statusVariants({ variant }), className)}
      role="status"
      {...props}
    />
  );
}

export interface StatusIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  pulse?: boolean;
}

export function StatusIndicator({ className, pulse = false, ...props }: StatusIndicatorProps) {
  return (
    <span
      data-slot="status-indicator"
      className={cn("relative flex size-2 shrink-0 items-center justify-center", className)}
      {...props}
    >
      {pulse && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75 motion-reduce:hidden" />
      )}
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function StatusLabel({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span data-slot="status-label" className={cn("truncate", className)} {...props} />;
}
