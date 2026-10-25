# Design System — minhmiceProxy (Obsidian Flame)

## 1. Direction and Authority

**Identity:** High-Performance Obsidian Flame Control Deck.
Inspired by modern dark luxury finance & infrastructure consoles (Image #1 reference): deep matte obsidian canvas (`#09090C`), structured charcoal surfaces (`#121217` to `#181820`), hairline luminous borders (`#23232C`), and high-energy flame amber/orange accents (`#FF5B22` to `#FF3D00` gradient). Crisp typography, glowing active states, and high-contrast tabs.

Operators manage critical proxy traffic, 9Router dual-master topologies, and Antigravity session quotas under high pressure. The interface is calm, purposeful, and delivers immediate situational clarity without juvenile cyan/magenta cyberpunk clash.

This document owns durable visual decisions. PRODUCT.md owns product truth.

### Implementation Authority
- Runtime tokens: `src/app/globals.css`. Shell geometry: `src/components/dashboard-shell.css`.
- Shadcn primitives in `src/components/ui/` own buttons, fields, tabs, overlays, tables, tooltips, and keyboard behavior. Compose them; do not build parallel controls.
- Motion library: `motion` (Framer Motion 14.5.0) via `import { motion, AnimatePresence } from "motion/react"`.
- Typography: System sans with crisp letter spacing (`tracking-tight` on headings, `tabular-nums` for metrics/ports/IPs).

---

## 2. Core Principles

1. **Precision & Situational Awareness:** The primary operational state (pool health, quota, active route) is visible in under 2 seconds.
2. **Obsidian Flame Palette:** Deep dark matte canvas with rich, radiant flame orange for high-priority actions, active indicators, and critical metrics. Secondary elements remain quiet and legible.
3. **High-Contrast Interactive Surfaces:** Follows `impeccable-shadcn-redesign`. Inactive tabs and controls remain clearly legible; active controls pop with solid flame orange (`bg-primary text-primary-foreground shadow-md shadow-primary/20`).
4. **Motion with Intent:** Motion explains state transitions (accordions expanding, tabs gliding, chart bars rising on load, hover elevations `translateY(-2px)`). Never animate layout dimensions or block user input.
5. **Cognitive Load Reduction:** Strip noisy multi-line subtext. Encapsulate technical parameter hints into inline `FieldInfo` tooltip buttons (`HelpCircle`).
6. **Robust State Preservation:** Multi-tab interfaces use `forceMount` and `data-[state=inactive]:hidden` to preserve in-flight forms, terminal logs, and node mesh state.

---

## 3. Semantic Color Architecture

The new palette transitions from chaotic neon cyan/magenta to a cohesive, ultra-premium Obsidian Flame aesthetic:

| Role | Token (OKLCH / CSS Var) | Hex Approximate | Usage & Contrast |
|---|---|---|---|
| Canvas | `--bg: oklch(0.10 0.005 260)` | `#09090C` | Deep obsidian canvas base |
| Surface | `--surface: oklch(0.14 0.008 260)` | `#131318` | Cards, panels, sidebar base |
| Raised Surface | `--surface-raised: oklch(0.18 0.012 260)` | `#1C1C24` | Popovers, active nav, hover cards |
| Surface Muted | `--surface-muted: oklch(0.12 0.006 260)` | `#0F0F13` | Recessed backgrounds, table headers |
| Foreground / Ink | `--ink: oklch(0.98 0.005 260)` | `#F4F4F6` | Crisp high-contrast primary text (≥12:1) |
| Secondary Text | `--muted: oklch(0.70 0.015 260)` | `#9E9EA8` | Legible secondary labels and subtext (≥5.5:1) |
| Subtle Text | `--muted-foreground: oklch(0.55 0.015 260)` | `#6E6E7A` | Inactive hints, timestamps, units |
| Primary Action | `--primary: oklch(0.66 0.22 38)` | `#FF5B22` | Flame Orange action, primary CTA, active pill |
| Primary Hover | `--primary-hover: oklch(0.72 0.23 42)` | `#FF7338` | Luminous flame hover |
| Primary Foreground | `--primary-foreground: oklch(0.99 0.005 0)` | `#FFFFFF` | Text on flame orange buttons/badges |
| Flame Gradient Start | `--flame-start: #FF6830` | `#FF6830` | Linear gradient start for hero cards & charts |
| Flame Gradient End | `--flame-end: #FF3500` | `#FF3500` | Linear gradient end |
| Success | `--success: oklch(0.76 0.18 145)` | `#10B981` | Healthy proxy, online node, 100% quota |
| Warning | `--warning: oklch(0.78 0.17 75)` | `#F59E0B` | Low quota (<20%), degraded pool latency |
| Error / Destructive | `--error: oklch(0.62 0.22 25)` | `#EF4444` | Dead proxy, failed sync, connection error |
| Border | `--border: oklch(0.24 0.012 260)` | `#23232C` | Crisp card and container boundaries |
| Border Subtle | `--border-subtle: oklch(0.18 0.008 260)` | `#181820` | Inner table dividers and subtle separators |
| Focus Ring | `--ring: oklch(0.66 0.22 38 / 0.5)` | `rgba(255,91,34,0.5)`| Flame keyboard focus ring |

---

## 4. Typography and Scale

- **Font Family:** System Sans (`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`) with `font-feature-settings: "cv02", "cv03", "cv04", "cv11"`.
- **Monospace:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace` with `font-variant-numeric: tabular-nums` for all IP addresses, ports, latencies, and quota percentages.

| Level | Size / Line Height | Weight | Letter Spacing | Guidance |
|---|---|---|---|---|
| Page Header | 24–28px / 32–36px | 600 / 700 | -0.03em | Clean, confident page anchors |
| Card Metric | 26–32px / 32–38px | 700 | -0.02em | Prominent stat figures with tabular numerals |
| Section Title | 16–18px / 24–26px | 600 | -0.015em | Card headers, table section titles |
| Body / Standard | 13–14px / 20–22px | 400 / 500 | normal | Main reading text, inputs, table cells |
| Caption / Secondary| 11–12px / 16–18px | 400 / 500 | +0.01em | Timestamps, units, metadata labels |
| Badge / Pill | 11–12px / 14–16px | 600 | +0.02em | Status badges, category tags |

---

## 5. Geometry and Shadows

- **Border Radius:**
  - Metric / Feature Cards: `rounded-2xl` (16px) — gives the modern, refined financial deck feel (Image #1).
  - Sub-cards / Modules / Tables: `rounded-xl` (12px).
  - Buttons / Controls / Selectors: `rounded-lg` (8px).
  - Tags / Active Tabs / Status Badges: `rounded-full` (9999px) pills.
- **Shadow Architecture:**
  - Card Default: `box-shadow: 0 4px 20px -4px rgba(0, 0, 0, 0.45), 0 1px 2px rgba(255, 255, 255, 0.03) inset;`
  - Card Hover: `box-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.65), 0 0 20px -4px rgba(255, 91, 34, 0.15);`
  - Flame Hero Card: `box-shadow: 0 8px 32px -6px rgba(255, 91, 34, 0.35);`

---

## 6. Motion & Framer Motion Choreography

Using `motion` (`motion/react`):

1. **Card Entrance & Stagger:**
   ```tsx
   const containerVariants = {
     hidden: { opacity: 0 },
     visible: {
       opacity: 1,
       transition: { staggerChildren: 0.06, delayChildren: 0.02 },
     },
   };
   const itemVariants = {
     hidden: { opacity: 0, y: 12 },
     visible: {
       opacity: 1,
       y: 0,
       transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] },
     },
   };
   ```
2. **Hover Elevation:**
   Interactive cards gently elevate on hover: `whileHover={{ y: -2, transition: { duration: 0.18, ease: "easeOut" } }}` with border highlight (`border-white/15`).
3. **Tab Indicator Slide:**
   Active tab pill uses `layoutId="activeTabPill"` with a snappy spring transition `{ type: "spring", stiffness: 450, damping: 35 }`.
4. **Pulsing Live Indicators:**
   Status dots pulse smoothly: `@keyframes flame-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.6; transform: scale(0.92); } }`.
5. **Bar Chart Inflow Animation:**
   Recharts bars animate in with smooth easing (`animationDuration={800}`, `animationEasing="ease-out"`), with flame gradient fill on the active/highest bar.

---

## 7. Component Specific Specifications

### A. High-Contrast Tabs (`impeccable-shadcn-redesign`)
```tsx
<TabsList className="flex flex-wrap sm:flex-nowrap w-full h-auto p-1.5 bg-[#121217] border border-[#23232C] rounded-xl gap-1.5 shadow-sm">
  <TabsTrigger
    value="tab-id"
    className="flex-1 min-w-[120px] flex items-center justify-center gap-2 py-2 px-3 text-xs sm:text-sm font-semibold rounded-lg transition-all text-[#9E9EA8] hover:text-[#F4F4F6] hover:bg-white/5 data-[state=active]:bg-[#FF5B22] data-[state=active]:text-white data-[state=active]:shadow-md data-[state=active]:shadow-[#FF5B22]/25"
  >
    <Icon className="size-4 shrink-0" />
    <span>Tab Label</span>
  </TabsTrigger>
</TabsList>
```

### B. Inline Field Info Tooltips
Eliminate noisy multi-line instructions below input controls:
```tsx
<FieldInfo content="Rotation activates when Gemini quota drops below 20%. Prioritizes lowest remaining reset time." />
```

### C. Sidebar & Navigation
- Obsidian background (`#0D0D11`), sharp right border (`#1E1E26`).
- Logo badge: Flame gradient square (`from-[#FF6830] to-[#FF3500]`) with white monogram `mP` and soft orange ambient glow.
- Active route: Filled pill highlight with flame accent marker.
- Left-sidebar footer: Aggregate quota widget with smooth expandable popover displaying per-account Gemini session quotas.

### D. Unified Table System
- Component: `src/components/ui/table.tsx`.
- Card Container: `rounded-2xl border border-[#23232C] bg-[#131318] shadow-sm overflow-hidden`.
- Grid Dividers: Subtle muted hairline borders (`border-[#23232C]` / `border-[#23232C]/40`), strictly avoiding glaring pure-white lines.
- Table Header: `bg-[#0F0F13] text-[#9E9EA8] font-semibold text-xs border-b border-[#23232C] uppercase tracking-wider`.
- Table Rows: `border-b border-[#23232C]/40 hover:bg-white/[0.025] transition-colors`.
- Selected Row: `bg-[#FF5B22]/10 border-l-2 border-[#FF5B22]`.
- Numbers & Metrics: `font-mono tabular-nums` for latency, ports, IPs, quotas.
- Status Badges: Consistent semantic badge pills (`Active` emerald, `Fallback` amber, `Dead` rose).
---

## 8. Verification & Accessibility Guardrails
- **WCAG AA:** Contrast verified ≥4.5:1 for standard text (`#9E9EA8` on `#131318` achieves 5.8:1; `#F4F4F6` achieves 13.5:1).
- **Reduced Motion:** If `prefers-reduced-motion` is active, disable all spatial `y` movements and spring layout transitions, keeping instant opacity changes only.
- **State Integrity:** Real check history and observed daemon states are always respected.
