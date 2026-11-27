import { ditherMaskStyle } from "@/lib/dither";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder: a static Bayer-dithered slab (no pulse).
 * Base colour is set by className (default `bg-dither-ink`); the mask supplies the texture.
 */
function Skeleton({ className, style, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("rounded-sm bg-dither-ink opacity-60", className)}
      style={{ ...ditherMaskStyle(0.375, { cell: 2 }), ...style }}
      {...props}
    />
  );
}

export { Skeleton };
