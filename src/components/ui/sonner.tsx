"use client";

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--error-bg": "#1c1214",
          "--error-text": "#ffe4e6",
          "--error-border": "#881337",
          "--success-bg": "#111c15",
          "--success-text": "#d1fae5",
          "--success-border": "#065f46",
          "--warning-bg": "#1c1811",
          "--warning-text": "#fef3c7",
          "--warning-border": "#78350f",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "group toast group-[.toaster]:opacity-100",
          error:
            "group-[.toaster]:!bg-[#1c1214] group-[.toaster]:!text-[#ffe4e6] group-[.toaster]:!border-[#881337]",
          success:
            "group-[.toaster]:!bg-[#111c15] group-[.toaster]:!text-[#d1fae5] group-[.toaster]:!border-[#065f46]",
          warning:
            "group-[.toaster]:!bg-[#1c1811] group-[.toaster]:!text-[#fef3c7] group-[.toaster]:!border-[#78350f]",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
