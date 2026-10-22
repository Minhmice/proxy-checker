# 21st.dev component integration — design contract

## Status and purpose

User approved inline execution of `docs/superpowers/plans/2026-10-22-21st-components.md`. This contract records that scope; it does not claim every source, feature description, license, or install command in the shortlist was verified.

Goal: a more distinctive, cohesive minhmiceProxy interface with useful interaction upgrades sourced from 21st.dev, preserving shadcn, operational clarity, and all backend behavior.

Visual authority: `DESIGN.md`. Preserve deep navy / blue identity, actual metrics, semantic status, accessible controls, and restrained motion.

## Corrections established from source inspection

- `src/components/command-palette.tsx` already implements searchable pools, loading/error/retry states, focus restoration, and dialog semantics. `src/app/(dashboard)/layout.tsx` mounts it. Topbar search is not a fake control.
- `src/components/proxies/proxy-selection-bar.tsx` already supports selection scope, pin/delete/export/clear. Upgrade its presentation, do not create duplicate selection state or invent a bulk-test endpoint.
- `src/lib/types.ts` defines `MetricsSnapshot` with active/reserve/dead/avgLatencyMs and timestamp. It does not provide traffic bytes or historical HTTP 409/502 counts. Do not manufacture those metrics.
- Unified proxies expose optional country/city, not verified latitude/longitude. Globe markers cannot imply precise IP geolocation.
- Monitoring reads `/api/fleet/nodes`; do not describe a terminal as streaming stdout/stderr or a remote shell unless an existing authorized API actually provides that capability.
- Candidate thresholds such as 150ms/1000ms were suggestions, not established performance policy. A latency visualization must not reclassify proxy health.

## Scope

Evaluate all 20 candidates and maintain a disposition for every entry: accepted, adapted, consolidated with an existing component, blocked by source/data/access, or declined with a concrete reason. The user must approve any reduced scope or replacement source before implementation of the affected slice. “20 evaluated” is not “20 installed.”

No registry guesses. Candidate author/slug from search results must be resolved to a real page, license, source, dependency list, and preview before fetching code. Missing license or paid/access requirements are blockers, not permission to copy.

### Operational requirements

- Shadcn primitives remain interaction owners. Retain Radix/cmdk focus and keyboard behavior.
- Reuse installed Motion and Recharts; do not add Framer Motion as a second animation runtime.
- Preserve API contracts, request cancellation, authentication, query persistence, selection scope, export safety policy, and destructive confirmations.
- Keep router sync and Antigravity rotation concurrent; proxy audits remain backend-owned. No new maintenance loops.
- Keep Gemini session-only rotation rules, default active limit 3, configurable threshold, earliest-reset priority, and sidebar aggregate quota placement.
- Unknown values remain unknown. No synthetic histories, fabricated geography, fake progress, simulated terminal output on operational pages, or tweened intermediate live measurements.
- At most one decorative motion focus per viewport. Respect reduced motion, keyboard, touch, 390px viewport, and 200% zoom.
- No API keys, authenticated proxy URLs, tokens, or private fleet information sent to 21st.dev or committed to documentation.

## Surface design

### Shared language and actions

Consolidate status appearances, copy feedback, tabs, and action busy states on current shadcn components. Status labels preserve separate concepts: health, router linkage, audit verdict, enabled state, pending action. Pulse only genuine activity, not every healthy row.

### Shell

Enhance the existing command palette rather than replacing its lifecycle. Navigation shortcuts and pool search are the first deliverable. Node search needs an existing read API, bounded requests, cancellation, and a real destination. Mutation commands reuse current authenticated handlers and safety confirmation paths; omit them until those contracts are verified.

A compact operation indicator may summarize existing sync progress. It must not become a second polling owner or obscure persistent errors. Text cycling must not hide critical state.

### Proxy workspace

Protocol control retains the exact supported set, URL serialization, page reset, keyboard selection, and responsive layout. The selection bar becomes a cohesive contextual action surface using existing callbacks. Measured latency and history remain literal, with a readable value and timestamp even if a visualization is present.

### Overview and quota

Use one cohesive metric composition, not several alternative metric-card libraries stacked together. Preserve counts and historical timestamps. Sparklines supplement accessible values. Quota remains in the existing sidebar footer; a visual treatment does not create a competing quota panel.

### Monitoring and nodes

Health matrix and command-center composition use actual node/runtime observations and timestamps. Terminal styling is read-only, sanitized diagnostics unless an existing API explicitly provides log data. Real errors remain legible and selectable. Do not add a remote execution subsystem for a visual component.

### Documentation and optional geography

Code block and copy interaction improve Help and agent-install instructions. Load syntax highlighting only where useful, prefer server rendering for static snippets, and preserve existing secret-redaction behavior.

Globe is a separate gated deliverable: require a reliable geographic dataset, honest country-level labeling if using centroids, an accessible list, WebGL failure fallback, reduced-motion behavior, offscreen pause, and no geolocation service calls merely for decoration. Without a reviewed data contract it remains blocked, not a fake demo passed off as fleet geography.

## Completion criteria

Every accepted integration is reachable through its real workflow; no duplicate old control remains. Each of 20 entries has source evidence and an explicit disposition. Existing full affected test modules pass or unrelated failures are reported precisely. Desktop/mobile rendered inspection and interaction evidence are required; source detector output alone is insufficient. User approval is required for source substitutions or omissions, with blockers recorded instead of silently shrinking scope.



## Source verification checkpoint — 2026-10-22

Public catalog metadata was verified for 19 candidates; Halo Button was located in the official Cult UI documentation rather than a verified 21st item. This is metadata verification, not full source/security/compatibility review. Official CLI documentation lists credential precedence as flags, TWENTYFIRST_TOKEN, API_KEY_21ST, then stored login. Environment API_KEY_21ST is absent; `npx --yes @21st-dev/cli@latest usage --json` returned `Not signed in. Run 21st login or set TWENTYFIRST_TOKEN.` Public install URLs require authenticated retrieval. Source-review work for catalog components remains pending authentication or explicit approval to use reviewed public upstream sources instead.

Verified metadata highlights:

| # | Verified source fact | Current disposition |
|---|---|---|
| 1 | Dice UI Status, MIT, `radix-ui` + `class-variance-authority`, 21st registry requires API key | Blocked pending code retrieval; shadcn Badge/status remains fallback |
| 2 | Elements AI Latency Meter, MIT, `lucide-react`, AI TTFB/total-duration vocabulary | Blocked pending code retrieval; candidate may be adapted only after confirming prop semantics |
| 3 | Appica Sparkline, MIT, `@delego`, compact chart | Blocked pending source; existing Recharts is preferred if visual-only |
| 4 | Astralyx Health Checks, MIT, `lucide-react`, endpoint health + latency sparkline | Blocked pending source; data mapping still requires existing node/runtime fields |
| 5 | Serafim Command Menu, MIT, no dependency metadata beyond catalog | Blocked pending source; existing cmdk palette already owns behavior |
| 6 | Ddoemonn Segmented Control, MIT, `motion`, radio/keyboard semantics | Blocked pending source; existing shadcn ToggleGroup is safer until reviewed |
| 7 | Cnippet Toolbar, MIT, `@base-ui-components/react`, roving toolbar | Blocked pending source; existing selection bar owns scope/actions |
| 8 | Cult UI Halo Button is documented at `cult-ui.com`, not verified as 21st candidate; uses Cult/Motion stack | Source substitution requiring user approval; do not add Base UI or second button system |
| 9 | Ibelick Prompt Kit Code Block, MIT, `shiki` | Blocked pending source; code-highlighter bundle cost must be reviewed |
| 10 | 21st Agent Elements Bash Tool page says MIT, read-only demo shape still needs source review | Blocked pending source; no fake terminal output or remote shell |
| 11 | Builder OS Bento canonical author is `@drewdog` (not earlier `@drewsephski` lead), MIT | Source corrected; blocked pending source; demo data cannot map directly to fleet |
| 12 | Ddoemonn Copy Button, MIT, `motion`, clipboard fallback/reduced motion | Blocked pending source; local minimal copy control may be preferable |
| 13 | Shuding COBE Globe, MIT, `cobe`, WebGL | Blocked pending source and geographic data decision |
| 14 | ShadcnSpace Number Ticker, MIT, `@number-flow/react` | Blocked pending source; exact-value transitions only |
| 15 | UI Layouts Stats Bento, MIT, no dependency metadata | Blocked pending source; no invented statistics |
| 16 | Sltowl Matte Metric Display, MIT, existing sparkline/period controls | Blocked pending source; quota footer behavior remains authoritative |
| 17 | EduCalvo Animated Tabs, MIT, `motion`, keyboard navigation | Blocked pending source; preserve current shadcn Tabs |
| 18 | Cult UI Dynamic Island 21st page reports unknown license and `framer-motion` | Pending upstream license/version verification; not declined or omitted without user approval |
| 19 | Cnippet Text Loop, MIT, `motion`; canonical item is `text-loop`, not `text-loop/status-badge` | Blocked pending source; secondary metadata only |
| 20 | Dillion Verma Magic UI Border Beam, MIT; local `@magicui/border-beam` already installed from official Magic UI registry | Consolidate with existing local component; no duplicate 21st install |

No substitution or omission is approved merely by this checkpoint. Prefer verified same-author public upstream source when available, subject to the plan's source-review gate and user approval for a changed source. Missing environment credentials do not alone prove all code is inaccessible. Candidate #18 needs upstream license/dependency verification before deciding its disposition; unknown catalog metadata is not a final legal determination.

Workspace gate: execution checkout is the ordinary repository on `main`, not a linked worktree, and contains substantial unrelated uncommitted edits. Inline execution selects no subagents; it does not authorize discarding work or moving changes to a fresh HEAD-only checkout. Before app edits, choose an isolated worktree seeded with the current working snapshot, or explicitly authorize in-place execution on a task branch preserving all existing files. No app edits, dependency installation, or authentication changes were made during this verification checkpoint.
