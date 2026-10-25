"use client";

import * as React from "react";
import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string;
  language?: string;
  title?: string;
}

export function CodeBlock({ code, language = "bash", title, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-black/85 text-foreground shadow-sm overflow-hidden font-mono text-xs",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-3.5 py-2 select-none">
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-rose-500/80" />
            <span className="size-2.5 rounded-full bg-amber-500/80" />
            <span className="size-2.5 rounded-full bg-emerald-500/80" />
          </div>
          {title ? (
            <span className="text-[11px] font-medium text-muted-foreground truncate ml-1">
              {title}
            </span>
          ) : (
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground ml-1">
              <Terminal className="size-3" />
              <span>{language}</span>
            </div>
          )}
        </div>
        <CopyButton
          value={code}
          label={title || "Code"}
          size="icon-xs"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
        />
      </div>

      <div className="p-3.5 overflow-x-auto text-emerald-400 leading-relaxed">
        <pre className="font-mono text-xs">
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
