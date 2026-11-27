import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-input/80 bg-background/60 px-3 py-2 text-base shadow-xs transition-[color,background-color,border-color,box-shadow] motion-reduce:transition-none outline-none placeholder:text-muted-foreground hover:border-ring/50 focus-visible:border-ring focus-visible:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/20 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
