import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { DitherButton, type DitherButtonProps } from "@/components/dithercn/dither-button";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-[color,background-color,border-color,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "",
        destructive: "",
        outline:
          "border border-input bg-background shadow-xs hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        halo: "",
        plain: "hover:bg-accent hover:text-accent-foreground",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };
type DitherVariant = Exclude<NonNullable<ButtonProps["variant"]>, "plain">;

const DITHER_VARIANT: Record<DitherVariant, DitherButtonProps["variant"]> = {
  default: "filled",
  destructive: "filled",
  outline: "outline",
  secondary: "outline",
  ghost: "outline",
  link: "outline",
  halo: "filled",
};
const DITHER_COLOR: Record<DitherVariant, DitherButtonProps["color"]> = {
  default: "--primary",
  destructive: "--destructive",
  outline: "--foreground",
  secondary: "--foreground",
  ghost: "--foreground",
  link: "--primary",
  halo: "--primary",
};
const DITHER_SIZE: Record<NonNullable<ButtonProps["size"]>, DitherButtonProps["size"]> = {
  default: "md",
  xs: "sm",
  sm: "sm",
  lg: "lg",
  icon: "icon",
  "icon-xs": "icon",
  "icon-sm": "icon",
  "icon-lg": "icon",
};

function Button({
  className,
  variant: requestedVariant,
  size: requestedSize,
  asChild = false,
  ...props
}: ButtonProps) {
  const variant = requestedVariant ?? "default";
  const size = requestedSize ?? "default";
  const classes = cn(buttonVariants({ variant, size }), className);

  if (variant !== "plain") {
    const actionVariant = variant;
    return (
      <DitherButton
        data-dither-button
        asChild={asChild}
        variant={DITHER_VARIANT[actionVariant]}
        color={DITHER_COLOR[actionVariant]}
        size={DITHER_SIZE[size]}
        className={cn(
          (actionVariant === "default" ||
            actionVariant === "destructive" ||
            actionVariant === "halo") &&
            "text-primary-foreground [text-shadow:none]",
          classes,
        )}
        {...props}
      />
    );
  }

  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={classes}
      {...props}
    />
  );
}

export { Button, buttonVariants };
