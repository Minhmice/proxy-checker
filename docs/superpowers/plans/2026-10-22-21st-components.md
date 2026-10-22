# 21st.dev Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evaluate all 20 approved candidates and integrate useful, source-verified upgrades into the real dashboard without duplicating controls or compromising operational behavior.

**Architecture:** Adopt visual treatments onto existing shadcn/Radix/cmdk controls, existing React state, API clients, and data models. Deliver independently reviewable slices: shared status/actions, shell navigation, proxy workspace, telemetry/overview, documentation/diagnostics, then data-gated geography. One integration owner controls shared primitives and dependency changes.

**Tech Stack:** Existing Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/Radix, cmdk, Motion, Recharts, node:test and Playwright. Confirm installed versions from package.json at execution time; preserve unrelated package changes.

**Spec:** `docs/superpowers/specs/2026-10-22-21st-components-design.md`. Read together with `DESIGN.md` and `PRODUCT.md`. This plan is pending user review; it does not start implementation.

## Global Constraints

- Shadcn primitives remain interaction owners. Retain Radix/cmdk focus and keyboard behavior.
- Reuse installed Motion and Recharts; do not add Framer Motion as a second animation runtime.
- Preserve API contracts, request cancellation, authentication, query persistence, selection scope, export safety policy, and destructive confirmations.
- Keep router sync and Antigravity rotation concurrent; proxy audits remain backend-owned. No new maintenance loops.
- Keep Gemini session-only rotation rules, default active limit 3, configurable threshold, earliest-reset priority, and sidebar aggregate quota placement.
- Unknown values remain unknown. No synthetic histories, fabricated geography, fake progress, simulated terminal output on operational pages, or tweened intermediate live measurements.
- At most one decorative motion focus per viewport. Respect reduced motion, keyboard, touch, 390px viewport, and 200% zoom.
- No API keys, authenticated proxy URLs, tokens, or private fleet information sent to 21st.dev or committed to documentation.
- User approval is required for source substitutions or omissions, with blockers recorded instead of silently shrinking scope.
- No automatic Git commits or broad staging: repository contains unrelated in-flight changes. Commit only if user explicitly requests it, staging exact task-owned paths.

## Known baseline and corrections

`CommandPalette` and `ProxySelectionBar` already exist. Their previous description as missing was incorrect. Preserve their state/error/selection behavior while improving presentation. `MetricsSnapshot` has counts and average latency, not traffic bytes. Unified proxy geography is country/city, not coordinates. Terminal styling does not authorize SSH or introduce log streaming.

Existing files are large and may have changed during other work. Read current sections before every patch. Shared exported symbol changes require language-server references; a text grep alone is not sufficient for call-site migration.

## Candidate ledger: all 20 remain accounted for

Links are discovery leads, not evidence that full source/access/license has been reviewed. Entries explicitly marked unresolved must be resolved before adoption. The final source ledger lives in the spec and includes resolved canonical URL, author, license, dependencies, data contract, disposition, and smoke evidence. No generic category page counts as an installed component.

| # | Candidate / source lead | Target | Slice | Adoption constraint |
|---|---|---|---|---|
| 1 | [Dice UI Status](https://21st.dev/@diceui/components/status) | Shared status, proxy and node rows | 2 | Preserve domain labels; pulse only active work |
| 2 | [AI Latency Meter](https://21st.dev/@elements-/components/latency-meter) | Proxy latency/detail | 4 | Inspect whether AI demo fits measured network latency; no new health thresholds |
| 3 | [Sparkline](https://21st.dev/@appica-dev/components/sparkline) | Existing metric history | 5 | Preserve timestamps/null gaps; reuse Recharts if adapting visual treatment |
| 4 | [Health Checks](https://21st.dev/@astralyxdev/components/health-checks) | Monitoring matrix | 6 | Actual node/runtime observations only |
| 5 | [Serafim Command Menu](https://21st.dev/@serafimcloud/components/command-menu) | Existing command palette | 3 | Keep cmdk/Radix; do not import demo shortcuts or replace auth lifecycle |
| 6 | [Segmented Control](https://21st.dev/@ddoemonn/components/segmented-control) | Protocol filter | 4 | Retain supported values, URL state, keyboard behavior |
| 7 | Cnippet Toolbar — exact author/slug unresolved | Existing selection bar | 4 | Resolve canonical 21st item; preserve selection scope and callbacks |
| 8 | Cult UI Halo Button — exact 21st item unresolved | Current primary action buttons | 2 | Adapt visual layer to shadcn Button; no second Base UI button stack |
| 9 | [Prompt Kit Code Block](https://21st.dev/@ibelick/components/code-block) | Help and install instructions | 6 | Inspect license and Shiki cost; static highlighting server-side where practical |
| 10 | [Agent Elements Bash Tool](https://docs.21st.dev/@21st/components/bash-tool) | Read-only diagnostics | 6 | No fake stdout, remote shell, or executable prompt |
| 11 | [Builder OS Bento](https://21st.dev/@drewsephski/components/builder-os-bento) | Monitoring composition | 6 | Remove sample AI/build/social data; map only real diagnostics |
| 12 | [Copy Button](https://docs.21st.dev/@ddoemonn/components/copy-button) | Endpoint/key/code copying | 2 | Await clipboard success; visible failure; preserve secret safeguards |
| 13 | [COBE Globe](https://21st.dev/@shuding/components/cobe-globe) | Optional Overview geography | 7 | Geographic contract, WebGL fallback and offscreen pause required |
| 14 | [Number Ticker 05](https://21st.dev/@shadcnspace/components/number-ticker-05) | Metric transitions | 5 | Real values exact; use crossfade/roll between exact values, no invented intermediate readings |
| 15 | [Stats Bento](https://21st.dev/@uilayout.contact/components/stats-bento) | Overview hierarchy | 5 | One cohesive composition; not an additional duplicated metric grid |
| 16 | [Matte Metric Display](https://21st.dev/@sltowl/components/matte-metric-display) | Existing quota footer | 5 | Quota remains above sidebar logout; details expand upward |
| 17 | [SmoothUI Animated Tabs](https://21st.dev/@educalvolpz/components/animated-tabs) | Settings tabs | 2 | Keep shadcn semantics and form state; sliding indicator only |
| 18 | Cult UI Dynamic Island — exact 21st item unresolved | Global operation summary | 3 | Consume existing operation data; no duplicate polling or hidden errors |
| 19 | [Cnippet text-loop/status-badge](https://21st.dev/@cnippet-dev/components/text-loop/status-badge) | Secondary rotating metadata | 3 | Verify actual nested demo; critical state stays static and visible |
| 20 | Magic UI Border Beam — existing local file, exact 21st item unresolved | Sync/deployment emphasis | 2 | Existing `src/components/ui/border-beam.tsx`; no redundant install or idle loops |

## File ownership map

| Area | Existing files to inspect/edit | Potential new files, only if adopted |
|---|---|---|
| Shared status/actions | `src/components/proxy-health-badge.tsx`, `src/components/ui/badge.tsx`, `button.tsx`, `tabs.tsx`, `border-beam.tsx`, `src/components/nodes/wireguard-settings.tsx` | `src/components/ui/status.tsx`, `copy-button.tsx` |
| Shell | `src/components/command-palette.tsx`, `topbar.tsx`, `right-panel.tsx`, `src/app/(dashboard)/layout.tsx` | `src/components/operation-indicator.tsx` |
| Proxies | `src/components/proxies/proxy-toolbar.tsx`, `proxy-selection-bar.tsx`, `proxy-table.tsx`, `src/components/proxy-detail-drawer.tsx`, `src/app/(dashboard)/proxies/page.tsx` | `src/components/proxies/latency-indicator.tsx` |
| Metrics/quota | `src/components/metric-card.tsx`, `traffic-chart.tsx`, `app-sidebar.tsx`, `src/app/(dashboard)/page.tsx`; locate existing quota footer owner first | No additional metric framework |
| Diagnostics/docs | `src/app/(dashboard)/monitoring/page.tsx`, `nodes/[id]/page.tsx`, `help/page.tsx`, `help/components/page.tsx`, `src/components/nodes/node-runtime-card.tsx`; locate installer snippet owner | `src/components/ui/code-block.tsx`, `src/components/nodes/diagnostic-output.tsx` |
| Geography | Existing Overview and API/data types; source discovery first | `src/components/proxy-geography.tsx` only after data approval |
| Tokens/dependencies | `src/app/globals.css`, `src/components/dashboard-shell.css`, `components.json`, `package.json`, `package-lock.json` | No global MCP config or secret files |

Paths above are responsibilities, not permission to create unused components. Do not add a wrapper or registry file unless a production consumer is integrated in the same slice.

## Slice 1 — Verify catalog sources and approve integration contracts

**Files:** Update source/disposition section in the spec. Read existing installed `.agents/skills/21st-ui/SKILL.md`, local primitives, package/config files. No app changes.

**Consumes:** Candidate ledger above. **Produces:** Verified source records for 1–20 and a concrete install/adaptation decision per candidate.

- [ ] Inspect current official 21st search/retrieval instructions. Check `API_KEY_21ST` presence as a boolean without printing its value. Use public catalog pages/CLI where permitted; an installed skill does not imply authenticated MCP access.
- [ ] Resolve exact sources for #7, #8, #18, #20 and confirm #19 is a usable demo rather than a guessed registry path. Read licensing, dependency manifest, full source, React 19/Tailwind 4 support, and preview for every candidate.
- [ ] Trace current consumers/data for each entry. Record canonical link, license, upstream revision or retrieved date, required packages, props, real data source, and target existing consumer. Do not record just the marketing description.
- [ ] Inspect example code for remote scripts, tracking, hidden fetches, key requirements, arbitrary eval, and secret leakage. Remove unrelated demo data from the integration design, not by adding fake operational fields.
- [ ] Present blockers/source changes to the user before implementing the affected slice. Missing license/access or absent data must be an explicit decision; do not silently substitute a homemade approximation while claiming catalog adoption.
- [ ] Review gate: all 20 entries accounted for. No install yet. Verify links resolve and records distinguish “viewed preview,” “read source,” and “authenticated retrieval.”

**Stop condition:** Unknown source/auth affects only dependent candidates, not all reachable slices. Continue independent approved work; final delivery still lists unfinished prerequisites honestly.

## Slice 2 — Shared status, copy, animated tabs, and action feedback

**Candidates:** #1, #8, #12, #17, #20.

**Files:** Shared status/action paths in ownership map; `src/app/(dashboard)/settings/page.tsx`; all verified call sites. Inspect existing local border beam first.

**Interfaces:** Existing Button/Badge/Tabs interfaces stay unchanged. If a dedicated status/copy composition is justified by repeated callers, use this minimal contract:

```tsx
type StatusTone = 'neutral' | 'success' | 'warning' | 'error';
type StatusProps = {
  label: string;
  tone: StatusTone;
  busy?: boolean;
};
type CopyButtonProps = {
  value: string;
  label: string;
  disabled?: boolean;
};
```

`busy` means observed activity, never “healthy.” `value` is supplied by the existing authorized caller; this component must not unmask secrets or fetch credentials.

- [ ] Before exported symbol edits, inspect language-server references and grep duplicate inline status/copy logic. Capture current user-facing health/linkage/audit labels; do not normalize different domain concepts into one enum.
- [ ] Install only verified registry files needed by this slice. Review emitted changes; do not overwrite existing shadcn files or unrelated package versions. Adapt Halo visual treatment onto current Button instead of importing another primitive library.
- [ ] Implement clipboard feedback with success/error distinction and stable dimensions. The core sequence must await success:

```tsx
try {
  await navigator.clipboard.writeText(value);
  setState('copied');
} catch {
  setState('error');
}
```

Reset timers must cancel on repeated action/unmount. Do not show “Copied” before promise resolution; unsupported/denied clipboard must expose a recovery message.

- [ ] Add animated tab selection to current shadcn triggers. Preserve keyboard navigation, accessible names, active contrast, and Settings form state. Remove conflicting dark active styles only where verified necessary; do not globally restyle unrelated tabs.
- [ ] Add reduced-motion/static alternative to beam and busy visuals. Existing sync text remains visible. A deployment beam is allowed only while an actual deployment state is observed, not every enabled WireGuard node.
- [ ] Browser smoke: copy allowed value; deny clipboard permission and confirm failure; rapid repeat then navigate away; navigate settings tabs with arrows/Home/End/Escape where applicable; change a non-secret field then switch tabs and confirm draft retained. Emulate reduced motion and confirm no decorative loop.
- [ ] Run full `tests/fleet-ui-contract.test.ts`, `tests/proxy-unified-status.test.ts`, `tests/app-config.test.ts`, `tests/proxy-export-policy.test.ts`. Update only behavior tests invalidated by real contract changes; never pin source strings/styles.
- [ ] Review gate: migrate all matching callers or explicitly preserve callers with a different semantic contract. Delete obsolete duplicate component code made unreachable by migration. Update source disposition and DESIGN.md only after smoke proof.

## Slice 3 — Existing command palette and compact operation context

**Candidates:** #5, #18, #19.

**Files:** `command-palette.tsx`, `topbar.tsx`, `right-panel.tsx`, dashboard layout. Add `operation-indicator.tsx` only if it has a real consumer and avoids duplicate presentation ownership.

**Consumes:** Existing `CommandPaletteProps = { open: boolean; onClose: () => void }`, `fetchPools`, router, `PoolStatus`/`syncProgress`, operation panel data. **Produces:** Same command API, enhanced visual grouping and a single-owner operation summary.

- [ ] Reproduce current Ctrl/Cmd+K and pool selection in browser. Check `handleSelect` currently uses `/proxies?search=...` while workspace query is `q`; inspect serializer/compatibility handling before deciding whether a real routing bug exists.
- [ ] Adapt command-menu visual treatment to current cmdk dialog. Preserve abort-on-close, retry, empty state, unauthorized recovery, focus restoration, and shortcuts. Never register a second global shortcut listener.
- [ ] Add grouped route commands for existing `/`, `/proxies`, `/nodes`, `/monitoring`, `/events`, `/settings`, `/help`. Keep pool search results distinct. Node search only uses verified existing read API and valid destinations; no new backend search service for visual parity.
- [ ] If query mismatch is confirmed, use the workspace serializer instead of hand-written URL parameters. Regression belongs in the existing full workspace test module and must prove selecting a result actually produces the intended filter after routing.
- [ ] Integrate operation summary into the current owner of status data; do not add another `fetchStatus` interval in a decorative child. Keep persistent failures static. Text-loop may rotate only secondary metadata, with pause/static reduced-motion output and an accessible complete text alternative.
- [ ] Do not add destructive/mutation quick commands without the existing confirmation/auth flow. Initial shell upgrade can be read/navigation only; record that boundary in the ledger rather than pretending sync commands exist.
- [ ] Smoke keyboard open/search/select/close, delayed response after close, empty/error/retry/session expired, and current status with no known progress. Exercise navigation and verify actual destination/filter, not only toast text.
- [ ] Run full `tests/proxy-workspace-state.test.ts`, `tests/request-lifecycle.test.ts`, `tests/activity-grouping.test.ts`, `tests/session-auth.test.ts`.
- [ ] Review gate: one command dialog, one global shortcut owner, no additional backend polling owner, no critical information hidden in a cycling string.

## Slice 4 — Proxy filter, contextual selection bar, measured latency

**Candidates:** #2, #6, #7.

**Files:** Proxy toolbar, selection bar, table, detail drawer, proxy route. Add latency indicator only if shared table/detail use warrants it.

**Consumes:** `ProxyToolbarProps.query: ProxyWorkspaceQuery`, `onQueryChange(Partial<ProxyWorkspaceQuery>)`; existing `ProxySelectionBarProps`; `UnifiedProxyItem.latencyMs` and history measurements. **Produces:** Same query/callback contracts; improved responsive presentation.

- [ ] Record existing supported protocols from query parser and toolbar, including SOCKS4 if still supported. Segmented control must not drop a supported value just because source demo has three segments.
- [ ] Adapt segmented visual treatment onto shadcn ToggleGroup/radio semantics, choosing the installed primitive appropriate for one selected value. Retain query reset:

```tsx
onQueryChange({ protocol: nextProtocol, page: 1 });
```

Only `nextProtocol` validated against the existing supported set may enter query state. Browser Back/Forward and direct URL load remain authoritative.

- [ ] Restyle existing selection bar contextually; keep actual `selectedCount`, `totalMatching`, `selectAllMatching`, pin/delete/export/clear callbacks. On mobile reserve space or use sticky layout so the bar never covers pagination/actions. Do not invent “Test All Selected” when no handler exists.
- [ ] Preserve explicit selected-page versus all-matching scope and destructive confirmation. Inspect whether existing handlers actually support all-matching mutation; if not, expose the limitation instead of silently broadening target scope.
- [ ] Adapt latency meter to literal measured milliseconds with null/invalid handling. Labels must say measured latency, not AI token latency. No new 150ms/1000ms health thresholds without a separate domain decision. Decorative length/color may communicate relative magnitude only when legend and basis are explicit.
- [ ] If formatting/mapping requires new logic, keep one small deterministic regression check behind. Use boundaries rather than source assertions:

```ts
// Cases for the adopted latency formatter/mapping:
// null -> Unknown; 0 -> 0 ms; non-finite -> Unknown;
// an observed failed check remains failed, not a large fake latency.
```

Use current formatter if it already satisfies these cases; do not extract a helper solely to test trivial markup.

- [ ] Smoke protocol URL persistence, pagination reset, long endpoint, null latency, selecting current page, all-matching scope, clear selection, export redaction, cancelled deletion, and preserved selection after a failed action.
- [ ] Run full `tests/proxy-workspace-state.test.ts`, `tests/proxy-unified-status.test.ts`, `tests/proxy-management-api.test.ts`, `tests/proxy-pin-and-delete.test.ts`, `tests/proxy-export-policy.test.ts`.
- [ ] Review gate: backend handlers unchanged; no duplicate selection state; all protocol choices reachable at 390px and 200% zoom.

## Slice 5 — Cohesive Overview metrics and existing sidebar quota

**Candidates:** #3, #14, #15, #16.

**Files:** `metric-card.tsx`, `traffic-chart.tsx`, Overview route, existing sidebar quota owner discovered through imports/references, `app-sidebar.tsx` only where wiring changes.

**Consumes:** `MetricsSnapshot[]` with timestamp, active/reserve/dead and nullable avgLatencyMs; current pool status; existing active-account Gemini quota data. **Produces:** One metric composition, original values and quota behavior.

- [ ] Inspect current metric-card props, sparkline code, Recharts usage, quota footer, and all consumers before choosing one shared composition. Avoid stacking Stats Bento and Matte Metric Display as competing card frameworks.
- [ ] Adapt Stats Bento hierarchy: measured count group plus existing chart/context. No traffic/uptime/growth/error-rate tile without actual data. Preserve loading vs no observations vs request failure.
- [ ] Use Sparkline source as a reviewed visual treatment over existing data/chart stack. Sort only if contract requires it; never turn absent/null readings into zero. Keep accessible summary values and timestamps; do not install a second chart engine for three tiny graphs.
- [ ] Adapt number transition without exposing fabricated live values. Exact previous/current values may crossfade; count-up through nonexistent measurements violates DESIGN.md. If source cannot support exact-value transitions, request approval for adaptation or decline the candidate.
- [ ] Apply matte treatment to existing quota footer, not a new dashboard quota group. Preserve upward hover expansion, aggregate quota and per-active-account detail. Missing/resetting quota remains unknown rather than zero. Keep the user's Gemini-session-only meaning.
- [ ] Smoke changing real snapshots, null average latency, stale/error state, narrow sidebar, quota expansion with mouse/keyboard/touch, long account names, reduced motion and 4K width. Use sanitized isolated fixture data only for explicit test states, never as production fallback.
- [ ] Run full `tests/proxy-check-history.test.ts`, `tests/antigravity-rotator.test.ts`, `tests/antigravity-config-client.test.ts`, `tests/antigravity-rotation-history.test.ts`.
- [ ] Review gate: no fabricated metrics, no duplicate quota location, no tweened intermediate values; old unused metric drawing code removed after migration.

## Slice 6 — Monitoring composition, read-only diagnostics, code blocks

**Candidates:** #4, #9, #10, #11.

**Files:** Monitoring route, node detail/runtime card, Help route, actual agent-install snippet owner. Add code-block/diagnostic-output compositions only for exercised consumers.

**Consumes:** Existing fleet-node/runtime API responses, observed health/timestamps, existing sanitized activity/error text and static runbook commands. **Produces:** Read-only health matrix/diagnostics and usable copyable documentation; no remote execution or new log service.

- [ ] Inspect fleet/runtime types, node detail read requests, redaction helpers, and installer snippet generation. Map each desired field to an existing response. Mark absent stream/log fields as unavailable; do not fabricate stdout/stderr.
- [ ] Adapt Health Checks to current observed statuses and timestamps. Do not invent historical uptime squares from one current observation. Distinguish disabled, unhealthy, offline, unknown, loading, and failed request.
- [ ] Use Builder OS Bento as composition reference, removing demo projects/AI credits/deployment/social feeds. Show actual node/runtime data only; avoid multiple panels repeating the same status summary.
- [ ] Adapt Bash Tool visual treatment into a read-only diagnostics viewer with selectable text, accessible title, wrapping/scrolling for long lines, and real timestamp. No executable prompt or implied live terminal. Preserve current sanitization/redaction; never dangerously render raw log HTML.
- [ ] Integrate Code Block for Help runbooks and actual installation instructions. Code text remains unchanged; copy excludes line numbers. If Shiki is needed, isolate static highlighting server-side or lazy-load only documentation languages after measuring cost. Do not load a highlighter into every inventory row.
- [ ] Smoke genuine observations, absent runtime fields, failed fleet request, sanitized secret-like error, long output, code copy exactness, and keyboard/text selection. For install commands use disposable non-production credentials and redact screenshots.
- [ ] Run full `tests/fleet-ui-contract.test.ts`, `tests/fleet-runtime-validation.test.ts`, `tests/fleet-state-safety.test.ts`, `tests/fleet-enrollment.test.ts`, `tests/activity-grouping.test.ts`. Use an isolated data directory for modules needing runtime state.
- [ ] Review gate: actual backend data only; health matrix not fictional history; no new shell/log API; source attributions retained.

## Slice 7 — Geography contract and gated COBE integration

**Candidate:** #13. Independent of slices 2–6 after source verification. This slice requires a data decision before implementation.

**Files:** Overview/data consumer and `proxy-geography.tsx` only after approval. No schema/backend additions are assumed by this plan.

**Consumes:** Current optional `geo.country`/`geo.city`, not precise coordinates. **Produces:** Either approved honest country-level geography, or an explicit unresolved prerequisite for this candidate.

- [ ] Verify geographic coverage and normalization from existing proxy data without printing sensitive endpoints. Country strings alone cannot establish latitude/longitude or completeness of the whole fleet from one paginated page.
- [ ] Present concrete options: country-centroid overview with explicit coarse-location labels and licensed dataset; existing trusted coordinate source if genuinely available; or omit geography with user approval. Do not choose silently or add a geolocation service without approval.
- [ ] After approval, document source/license, known/unknown coverage, aggregation scope, grouping rules, and coordinate precision before installing COBE. A sample globe belongs only in an explicitly labeled reference preview, not live fleet geography.
- [ ] Integrate via dynamic client loading with reserved layout. Provide accessible country/count list, WebGL-disabled fallback, reduced-motion static rendering, pause when offscreen/document hidden, and disposal on unmount. Do not globally poll geolocation.
- [ ] Smoke known and unknown country, all unknown, partial-page scope, failed WebGL creation, reduced motion, pointer/touch rotation, route navigation/unmount, and offscreen pause. The list remains useful when canvas fails.
- [ ] Run full affected repository/API test modules only if data aggregation is changed; visual-only integration uses browser evidence plus the final typecheck/build. Any new aggregation algorithm gets one deterministic behavior test covering unknown/duplicate countries and scope.
- [ ] Review gate: location labels never imply exact exit-IP placement; no hidden external lookup; candidate not claimed complete while awaiting data approval.

## Slice 8 — Integrated consistency, source accounting, and final proof

**Files:** All task-owned UI files, source/disposition section of spec, DESIGN.md if durable decisions changed, existing component reference page only where its claims need correction.

- [ ] Inspect changed shared exports with language-server references; grep old inline copies of migrated statuses, copy handlers, tab treatments, and action bars. Preserve intentionally different domain semantics and record why.
- [ ] Confirm scope against task-owned changes. No server mutation/scheduler/audit logic changes, global MCP edits, unrelated dependency upgrades, or discarded user work. Ask before deleting unrelated assets/code.
- [ ] Run repository full test suite once after integration, plus complete affected modules if not included by its glob:

```sh
npm test
npm run typecheck
npm run build
```

Capture exact commands/results. Never narrow to only one expected-to-pass test or pin wording/style tests. Do not rerun a user-reported unrelated failure merely to confirm it; report the known failure and continue relevant checks.

- [ ] Launch the actual app using the existing development command. Inspect port/server convention first; use a dedicated isolated data directory and known disposable auth if starting another server. Never let visual smoke sync production accounts, mutate real proxies, or expose secrets. Reuse an existing authenticated user-controlled session only with permitted scope.
- [ ] Batch rendered verification at 390px, 1440px, and shipped ultrawide layout; include 200% zoom, reduced motion, long names/URLs, keyboard focus, and touch interactions. Exercise commands, filters, copy success/failure, selections, tab draft persistence, quota disclosure, diagnostics, and any adopted globe. Verify actual content and interactions, not screenshots alone.
- [ ] Fix observed defects in one batch; confirm affected cases once. Run Impeccable detector once on changed markup targets, review findings in context, and report source findings separately from browser evidence.
- [ ] Record page-route JS/bundle impact before/after for added Motion/COBE/highlighter imports with the available build tooling. Keep heavy optional code out of unrelated route imports. No fabricated byte savings or performance claims.
- [ ] After smoke proof, remove temporary fixture scripts/captures containing secrets; stop owned servers and close owned tabs. Keep only purposeful regression checks. Preserve Playwright tooling.
- [ ] Deliver a table for all 20: canonical source, disposition, real consumer, exercised proof, and any user-approved omission/blocker. Do not equate skill installation or local copied files with a working authenticated 21st integration.

## Execution order and review ownership

1. Slice 1 gates all remote adoption. Resolve access/source concerns before registry installation.
2. Slice 2 establishes shared primitive decisions.
3. Slices 3, 4, 5, 6 may run independently after slice 2 with isolated file ownership. Shared package/token edits remain integration-owner-only. Frontend/code generation uses the project's configured 3.8 Flash Auto role when available; do not silently change configured model roles.
4. Slice 7 waits for geographic data approval; do not block unrelated reachable slices on it.
5. Slice 8 integrates and verifies. Builders skip build/lint/tests/formatters while peers are editing; integration owner runs complete checks after each assembled checkpoint, not simultaneously against half-written shared files.

No mid-flight API widening, extra telemetry, retry subsystem, remote shell feature, or backend maintenance work is authorized by this visual plan.

## Plan self-review record

- All candidates 1–20 map to source validation and a surface slice; unresolved canonical identities remain explicit gates rather than guessed install commands.
- Interfaces preserve existing CommandPalette, workspace query and selection contracts. New shared props are defined in slice 2; no absent backend methods are named as implemented APIs.
- Verification covers complete affected test modules and actual browser workflows; CSS/source-string assertions are not proposed.
- Known command palette/selection baseline corrected; nonexistent traffic/log/geography data not assumed.
- All reduced-motion, secret handling, quota placement, scheduler concurrency, export safety and dirty-work preservation requirements trace to global constraints and slice acceptance gates.
- This is a planning deliverable only. No implementation, installs, runtime checks, or Git commit is claimed by saving this plan.
