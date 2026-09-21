# Design System — minhmiceProxy

## Theme

Dark control-room dashboard. Deep navy base with electric blue and violet accents for primary actions and active navigation. Neon green for positive metrics and success states. Scene: infra operator at a desk in dim evening light, monitoring a live proxy fleet.

**Color strategy:** Full palette — multiple named roles used deliberately across metrics, charts, and navigation.

## Color Palette (OKLCH)

```css
:root {
  /* Base */
  --bg: oklch(0.11 0.025 265);
  --surface: oklch(0.15 0.028 265);
  --surface-raised: oklch(0.18 0.032 265);
  --ink: oklch(0.95 0.01 265);
  --muted: oklch(0.68 0.02 265);

  /* Brand */
  --primary: oklch(0.62 0.19 255);
  --primary-hover: oklch(0.68 0.21 255);
  --accent-violet: oklch(0.58 0.22 295);
  --accent-green: oklch(0.78 0.18 145);
  --accent-teal: oklch(0.72 0.14 195);

  /* Semantic */
  --success: oklch(0.78 0.18 145);
  --warning: oklch(0.75 0.15 75);
  --error: oklch(0.65 0.2 25);
  --info: oklch(0.62 0.19 255);

  /* Borders */
  --border: oklch(0.25 0.03 265);
  --border-subtle: oklch(0.20 0.025 265);

  /* Gradients (buttons, active nav only — not text) */
  --gradient-primary: linear-gradient(135deg, oklch(0.62 0.19 255), oklch(0.58 0.22 295));
  --gradient-nav-active: linear-gradient(135deg, oklch(0.55 0.18 255 / 0.35), oklch(0.50 0.20 295 / 0.25));
}
```

## Typography

- **Family:** `"Inter", system-ui, -apple-system, sans-serif`
- **Scale:** Fixed rem — 0.75 / 0.875 / 1 / 1.125 / 1.25 / 1.5 / 2rem
- **Weights:** 400 body, 500 labels, 600 headings, 700 buttons
- **Display ceiling:** max 2rem for page titles; letter-spacing ≥ -0.03em
- **Mono:** `"JetBrains Mono", ui-monospace, monospace` for proxy URLs and metrics

## Spacing

4px base unit: 4, 8, 12, 16, 20, 24, 32, 48, 64

## Border Radius

- Cards / panels: 12px
- Inputs / buttons: 8px
- Pills / tags: 999px

## Z-Index Scale

- dropdown: 10
- sticky: 20
- sidebar-overlay: 30
- modal-backdrop: 40
- modal: 50
- toast: 60
- command-palette: 70

## Components

### Sidebar
240px fixed width; collapses to 64px icon rail below 1024px. Active nav item uses `--gradient-nav-active` background with primary text.

### Top Bar
64px height; search input with ⌘K hint; notification bell; user avatar block.

### Metric Cards
Surface background, 12px radius, single border (no paired shadow). Sparkline in bottom-right. Delta badge in green for improvements.

### Buttons
- Primary: gradient fill, white text
- Secondary: transparent with border
- Ghost: no border, hover surface

### Data Table
Dense rows, monospace proxy URLs, status pills with semantic colors.

## Motion

150–250ms ease-out-quart on hovers and state changes. Chart draw on mount (reduced-motion: instant). No page-load orchestration.

## Layout

```
Sidebar (240px) | Main (flex-1) | Right Panel (280px, hidden <1280px)
```

Main content max-width unconstrained; internal padding 24–32px.

## Anchor References

PYPROXY dashboard (primary visual), Bright Data control panel, Oxylabs dashboard.
