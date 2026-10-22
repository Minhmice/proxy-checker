# Design System — minhmiceProxy

## 1. Direction and authority

**Identity:** Cyberpunk NOC (Tokyo Midnight) infrastructure software: deep obsidian canvas (`#08090f`), razor-sharp electric cyan (`#00f5ff`) actions, electric magenta & neon phosphor green accents, subtle cyber-matrix background texture, ambient top spotlights, and glowing live indicators. Designed for high-speed network operations under dim ambient light.

Operators inspect proxy health, reconcile 9Router pools, rotate Antigravity accounts, and manage fleet nodes under time pressure. Every layout answers: what is happening, what needs attention, and what action is safe next?

This document owns durable visual decisions. PRODUCT.md owns product truth. Route-specific modes and task priorities belong in surface briefs.

### Implementation authority

- Runtime tokens: `src/app/globals.css`. Shell geometry: `src/components/dashboard-shell.css`.
- Shadcn primitives in `src/components/ui/` own buttons, fields, tabs, overlays, tables, tooltips, and keyboard behavior. Compose them; do not build parallel controls.
- Existing CSS is evidence, not proof of compliance. Standards below are targets; only rendered verification proves adoption.
- Current body font is system sans; current mono is platform monospace. Inter and JetBrains Mono are not installed assets.
- Preserve real data and backend workflows. Visual experiments must not trigger checks, change assignments, or manufacture health metrics.

## 2. Principles

1. **Hierarchy before decoration.** One page title, one dominant task, quiet alternatives.
2. **Density with breathing room.** Compact rows; generous separation between unrelated decisions. Avoid walls of controls and oversized empty cards.
3. **State is factual.** Saved configuration is not observed daemon health. A checked local switch remains an unsaved preference until persistence succeeds.
4. **Progressive disclosure, not concealment.** Requirements, warnings, units, consequences, and recovery remain visible. Tooltips hold optional explanation.
5. **Motion explains change.** Animate state, relationship, and progress—not static inventory to imply activity.
6. **One component language.** External effects enhance shadcn composition, never replace interaction contracts.
7. **Legibility wins.** Measure actual foreground/background pairs; token names alone do not establish contrast.

## 3. Semantic color architecture

Keep established navy/blue identity. Components reference semantic variables, not raw library example colors.

| Role | Cyberpunk Token (OKLCH) | Usage & Contrast |
|---|---|---|
| Canvas | `--bg: oklch(0.075 0.025 260)` | Deep obsidian midnight base |
| Surface | `--surface: oklch(0.115 0.035 260)` | Floating panels, glassmorphic cards |
| Raised surface | `--surface-raised: oklch(0.155 0.045 260)` | Popovers, active nav, dropdowns |
| Foreground | `--ink: oklch(0.985 0.005 260)` | Crisp high-contrast white text |
| Secondary text | `--muted: oklch(0.72 0.03 250)` | Subdued cyan-tinted secondary text |
| Action | `--primary: oklch(0.78 0.17 205)` | Electric Neon Cyan (`#00f5ff`) |
| Focus | `--ring: var(--primary)` | Cyan keyboard focus ring |
| Success | `--success: oklch(0.82 0.22 145)` | Neon Phosphor Green (`#10b981`) |
| Warning | `--warning: oklch(0.80 0.18 80)` | Neon Safety Amber (`#f59e0b`) |
| Error | `--error: oklch(0.68 0.24 25)` | Cyber Crimson / Hot Pink (`#ff3366`) |
| Border | `--border: oklch(0.25 0.045 260)` | Crisp luminous boundary |
| Subtle border | `--border-subtle: oklch(0.18 0.035 260)` | Internal dividers |
| Secondary series | `--accent-violet: oklch(0.68 0.25 315)` | Electric Magenta chart series & accents |

### Shadcn mapping and legacy constraints

Use `background/foreground`, `card/card-foreground`, `popover/popover-foreground`, `primary/primary-foreground`, `secondary/secondary-foreground`, `muted-foreground`, `destructive`, `input`, and `ring`.

Legacy `--muted` is a text color. Do not assume `bg-muted` creates an appropriate dark surface; prefer `bg-secondary` or `bg-card` until this collision is migrated deliberately. A CSS variable does not automatically create a Tailwind utility. Register a theme mapping or use an explicit variable utility; never rely on undefined `bg-surface-raised`.

Semantic backgrounds use restrained tints and readable foregrounds. Do not lower opacity on essential labels. Active tabs need shape/border plus text, not a barely different background. Status combines color with words and optionally icons.

Blue/violet gradients remain limited to small action/navigation accents. No gradient text, page-wide glow, or blended warning colors. A light theme requires a complete token set and state verification, not a partial palette swap.

## 4. Typography and rhythm

| Role | Size / line height | Weight | Guidance |
|---|---|---|---|
| Page title | 24–32 / 32–40px | 600 | One h1; tracking at least -0.03em |
| Section title | 18–20 / 28px | 600 | h2 groups a real task |
| Panel title | 16 / 24px | 600 | Do not repeat tab copy verbatim |
| Body / label | 14 / 20–22px | 400 / 500 | Default reading size |
| Supporting detail | 12–13 / 18–20px | 400 | Optional metadata, not requirements |
| Data / endpoint | 12–14 / 18–20px mono | 400 / 500 | IDs, URLs, measurements; tabular numerals |
| Badge | 12 / 16px | 500 | Sentence case, icon plus word |

- Prose measure: about 65–75 characters; do not stretch instructions across ultrawide tables.
- Align numbers by column. Units remain visible: “Timeout (ms)”, not tooltip-only units.
- Avoid uppercase paragraphs, 10px status badges, and ornamental monospace headings.
- Long hostnames wrap or truncate with an accessible full-value path. One endpoint must not dictate page width.
- Stable vocabulary: 9Router, Antigravity, Gemini session quota, WireGuard, proxy pool. Sentence case for controls.

## 5. Geometry and composition

4px spacing base; scale: 4, 8, 12, 16, 20, 24, 32, 48, 64px.

| Relationship | Space |
|---|---|
| Label to field | 6–8px |
| Field to optional helper | 4–6px |
| Related fields | 16–20px |
| Panel padding | 20–24px desktop; 16px narrow |
| Related panels | 16–24px |
| Major sections | 32–48px |

Cards: 12px radius; controls: 8px; small badges may be pills. Define elevation once: border on persistent panels, soft offset shadow on floating overlays. Avoid border-plus-wide-shadow ghost cards and colored halos.

### Workspace anatomy

- Existing shell: 240px sidebar, 64px collapsed rail, 64px top bar; optional context panel 280px.
- Remove secondary context before compressing the primary task.
- Tables/charts may expand; forms retain intentional reading widths. Do not stretch three password inputs across a 3400px canvas.
- Asymmetric grids express priority: primary work plus narrower context/activity, not arbitrary bento decoration.
- Metrics reflect actual data. Different card sizes must correspond to different information needs.
- No cards inside cards just to obtain padding. Use fieldsets, whitespace, and separators.

### Responsive rules

| Available content width | Composition |
|---|---|
| Under 640px | Single column, wrapped actions, 44px targets, visible required labels |
| 640–1023px | Two-column related fields only when labels fit; no clipped navigation |
| 1024–1279px | Persistent navigation where space permits; primary task dominates |
| 1280px and wider | Optional context panel and richer data grids |
| Ultrawide | Expand data, not prose; bounded form columns |

At 200% zoom use narrower composition. Tables may scroll in their own region; the document must not acquire horizontal scroll. Prefer content-width decisions over device-name assumptions.

## 6. Component contracts

### Navigation and tabs

Shadcn Tabs requires a named tablist, visible selection, native arrow-key behavior, and obvious keyboard focus. Inactive labels remain readable. Active treatment combines contrast with an outline, underline, or filled shape.

Never force five fixed-minimum-width tabs into a narrow workspace. Wrap with sensible semantics or provide an explicitly scrollable strip. Preserve unsaved state across tabs. A tab denotes location, not live health.

### Forms and settings

Use persistent labels and shadcn Field/Label/Input/Switch/Select. Related fields get meaningful grouping. Native input types/constraints complement—not replace—backend validation.

- Keep accepted formats, required/optional status, validity limits, re-login consequences, and plaintext credential risks visible before submission.
- Optional help uses shadcn Tooltip with a focusable, specifically named trigger. Never put necessary help behind `tabIndex={-1}`.
- Support hover, focus, and explicit touch interaction; do not assume hover exists.
- Distinguish editing, saving, saved preference, and observed runtime state. Never label a local toggle “Daemon running” without runtime evidence.
- One primary save action per independently persisted section. Preserve input on failure and show recovery near the action.
- A visual refresh or another section's save must not silently discard unrelated unsaved edits.

### Actions and feedback

Shadcn Button variants: primary for next meaningful task, outline for alternatives, ghost for utility, destructive for irreversible operations. Busy actions retain dimensions and expose a text label and accessible busy state.

Persistent errors, safety consequences, and connection results use inline alerts. Toasts confirm transient outcomes; they do not replace required instructions. Error copy identifies failure and next action without inventing a cause.

### Tables and inventory

Use shadcn Table with existing table state patterns. Target 40–44px readable rows. Selection and row actions remain accessible. Distinguish health, audit verdict, routability, and enabled state instead of merging everything into one green badge.

Keep units/sorting consistent, empty/error/loading states explicit, bulk-action scope visible. Copy actions identify the copied value; redact secrets unless explicitly requested.

### Metrics and charts

Recharts remains the installed chart stack. Reflect actual check/sync history. Zero is not unknown; load failure is not an empty dataset. Show gaps for missing observations, not invented interpolation.

Series order/colors/units stay stable across refreshes. Lower latency may improve service; lower active count is not inherently good. Deltas need domain meaning, not reflexive red/green.

### Overlays and help

Use shadcn Dialog/Sheet/Tooltip. Modal focus returns to its trigger; Escape works. Tooltips contain short supporting text, never forms, confirmations, or essential warnings.

Existing layer roles: dropdown 10; sticky 20; sidebar overlay 30; backdrop 40; modal 50; toast 60; command 70. Check real portal stacking contexts; numeric roles alone do not prove correct layering.

## 7. Motion and micro-interactions

| Purpose | Timing | Treatment |
|---|---|---|
| Hover / press | 120–160ms | Color/border, no layout movement |
| Tab / selection | 160–220ms | Local indicator; content readable immediately |
| Overlay | 180–240ms | Small opacity/position change, no bounce |
| Copy / save feedback | 150–250ms | Text/icon transition, stable dimensions |
| Pending operation | Real lifetime | Labeled spinner/progress tied to actual state |

Use existing `--ease-out-quart` and `--ease-out-quint`. Prefer CSS for simple transitions. Add Motion only when an adopted component genuinely needs coordinated animation.

Budget: at most one decorative motion focus per viewport; none required for comprehension. No perpetual canvas/marquee/cursor spotlight/3D tilt on tables or forms. No tweened operational numbers suggesting invented intermediate measurements.

Reduced motion keeps meaning through static state indicators and labels. Disable decorative loops and spatial movement without globally destroying useful timing with a 0.01ms override. Decorative effects are pointer-inert and hidden from accessibility APIs.

## 8. External component sources

Curated sources, not four competing design systems. Verify source, license, dependencies, React/Tailwind compatibility, client boundary, accessibility, and runtime cost. Retain upstream attribution/license notices.

| Source | Role | Suitable use | Guardrail |
|---|---|---|---|
| 21st.dev | Discovery/generation through official skill/MCP | Find layout/interaction, adapt to local tokens/shadcn | Untrusted results require review; never send credentials/private fleet data |
| Magic UI | Small animated accents | Bounded emphasis or explicit component reference | No infinite effects on every card |
| Aceternity UI | Expressive composition | Isolated preview or purposeful emphasis | No cursor/3D/canvas effects in operational forms |
| cult-ui | Focused micro-interactions | Copy feedback, disclosure, utility behavior | Retain semantics, touch, reduced motion |

Install individual registry components, not entire libraries. Shadcn remains interaction owner. Do not globally reskin buttons for one demo. Preview-only dependencies should remain outside operational route imports where possible.

Installed skills are not proof of authenticated MCP operation. State missing API credentials precisely, finish reachable work, never commit secrets or pretend placeholder config works.

Component reference demonstrations use labeled examples, clearly distinct from live fleet data, reachable from Help, responsive, and genuinely interactive—not copied screenshots.

## 9. Accessibility and resilience

- WCAG AA: text contrast at least 4.5:1; large text and meaningful non-text graphics at least 3:1. Check selected, hover, disabled, error, and focus states.
- Keyboard access, visible focus, logical headings, specific accessible help names.
- Target 44×44px touch areas. A 14px icon alone is not a sufficient hit area.
- No color-only verdicts. Use words and where useful icons.
- Long URLs, missing quota, unknown handshakes, empty results, failed requests, and interruptions remain honest states.
- Loading reserves structure. Live regions announce meaningful outcomes, not every refreshing table row.
- Preserve native selection, password managers, validation. Never leak secrets into screenshots/logs/examples.

## 10. Implementation workflow

1. Read product context, this system, target implementation, existing primitives.
2. Prefer native/CSS/existing dependency; inspect remote component code before installation.
3. Keep server components by default; isolate client interactions/effects.
4. Complete real use cases with minimal APIs. Avoid one-consumer abstraction without concrete benefit.
5. Check matching callers for shared primitive/signature changes. Preserve unrelated in-flight work.
6. Run full affected test modules, typecheck, build. Detectors supplement rendered proof.
7. Inspect desktop/mobile together, keyboard, touch help, reduced motion, 200% zoom. Batch fixes; one confirmation pass.
8. Report exact exercised evidence and prerequisites. Update durable decisions, not wishful installed assets.

## 11. Acceptance checklist

- Main task and active location visible without hover.
- Labels/units legible; optional help keyboard/touch reachable.
- No document overflow at 390px or 200% zoom.
- Unsaved preferences never shown as observed health.
- Example data clearly distinct from live status.
- Effects cannot intercept input or obscure warnings.
- Every new runtime dependency has an exercised imported component.
- No remote tracking script, secret, or undocumented source/license.
- Shared controls remain shadcn; no second button/tab/dialog system.
- Source checks and rendered behavior reported separately.

## 12. References

- Shadcn: https://ui.shadcn.com/
- 21st.dev: https://21st.dev/ and https://github.com/21st-dev/magic-mcp
- Magic UI: https://magicui.design/ and https://github.com/magicuidesign/magicui
- Aceternity UI: https://ui.aceternity.com/
- cult-ui: https://www.cult-ui.com/ and https://github.com/nolly-studio/cult-ui

Linear/Vercel inform hierarchy and feedback precision, not copied branding. Existing PYPROXY/Bright Data/Oxylabs references inform operational familiarity, not copied assets.
