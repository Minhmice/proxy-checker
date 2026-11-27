"use client";

import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * A flat track and a round thumb. Off is a quiet tinted well; on fills with the primary
 * colour and the thumb carries a hairline so it stays readable on either. The thumb slides on
 * an overshoot curve and squeezes a little under the pointer, so the control feels like it has
 * mass. Only transform and background change, and reduced motion drops the slide.
 */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "group/switch peer relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full p-[3px] outline-none",
        "bg-foreground/10 shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--foreground)_14%,transparent)]",
        "transition-[background-color,box-shadow] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        "hover:bg-foreground/15",
        "data-[state=checked]:bg-primary data-[state=checked]:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary),black_30%)] data-[state=checked]:hover:bg-primary",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        // The hit area stays 44px tall without growing the track.
        "before:absolute before:-inset-x-1 before:-inset-y-2.5 before:content-['']",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block h-[18px] w-[18px] rounded-full bg-foreground/70 shadow-[0_1px_2px_rgb(0_0_0/0.45)]",
          "transition-[transform,width,background-color] duration-300 ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none",
          "data-[state=unchecked]:translate-x-0 data-[state=checked]:translate-x-5 data-[state=checked]:bg-primary-foreground",
          "group-active/switch:w-[22px] group-active/switch:data-[state=checked]:translate-x-4 group-data-[disabled]/switch:group-active/switch:w-[18px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
