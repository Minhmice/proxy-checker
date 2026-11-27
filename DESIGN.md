---
name: minhmiceProxy
description: Obsidian Flame operator console.
colors:
  canvas: "oklch(0.1 0.005 260)"
  surface: "oklch(0.14 0.008 260)"
  surface-raised: "oklch(0.18 0.012 260)"
  ink: "oklch(0.98 0.005 260)"
  primary: "oklch(0.66 0.22 38)"
  on-primary: "#07090c"
  success: "oklch(0.76 0.18 145)"
  warning: "oklch(0.78 0.17 75)"
  destructive: "oklch(0.62 0.22 25)"
rounded: { card: "16px" }
components:
  button-primary: { backgroundColor: "{colors.primary}", textColor: "{colors.on-primary}" }
  card: { backgroundColor: "{colors.surface}", textColor: "{colors.ink}", rounded: "{rounded.card}" }
---

# Obsidian Flame

## Overview

Matte surfaces; Bayer dither for structure and data, not decoration.

Sources: `src/app/globals.css`, `src/components/dashboard-shell.css`, `src/components/ui/`.

## Colors

Orange actions and focus; dark text on orange. Neutral dither; labeled statuses.

## Typography

System sans, tabular mono, 5×7 telemetry.

## Layout

17.5rem sidebar, 4rem rail, mobile drawer; scroll tables internally.

## Elevation & Depth

Tonal layers, hairlines, small shadows.

## Shapes

16px cards, 12px panels. Clip decoration.

## Components

- Shadcn controls: visible focus, labels, mounted settings panels.
- Buttons use the dithercn Bayer bevel, semantic action colors, visible keyboard focus, and static state changes under reduced motion.
- Clip Grid Beam to tables. Sidebar click flame fades; quota expands above sign-out.
- Confirmed handoff: one Sonner flame below text, static under reduced motion.

## Do's and Don'ts

Keep keyboard access and 4.5:1 text contrast. Never fake quota or success. Avoid neon and persistent pulses.
