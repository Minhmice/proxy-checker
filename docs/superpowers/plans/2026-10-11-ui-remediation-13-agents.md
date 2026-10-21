# UI Remediation — 13-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax. This plan does not authorize backend policy changes.

**Goal:** Fix evidence-backed trust, error recovery, mobile and accessibility defects across minhmiceProxy without redesign.

**Architecture:** Thirteen exclusive file owners reuse existing Next.js/shadcn contracts. Owner 01 owns all shared styles and motion. Owners 02–13 consume existing tokens without editing shared CSS. Parent is sole integration owner and runs consolidated verification after all implementation slices settle.

**Tech Stack:** Existing Next.js App Router, React, Tailwind, shadcn/Radix, cmdk, Node HTTP APIs and SQLite. No new dependencies.

**Spec:** `docs/superpowers/plans/2026-10-11-ui-audit-critique.md`, `PRODUCT.md`, `DESIGN.md`, `docs/operations.md`. F01–F18 refer to the audit report. Audit is complete; implementation has not started. Authenticated browser evidence used intercepted empty states, not production backend proof.

## Global constraints

- Preserve dark control-room identity and business behavior. No redesign, fabricated telemetry, security guarantees, roadmap claims or services.
- Frontend/code generation workers use project role **3.8 Flash Auto** through existing routing. Do not modify OMP settings. If unavailable, disclose actual route rather than claiming it was used.
- All UI uses installed shadcn primitives. Read relevant Impeccable command and craft-floor immediately before UI edits. Parent ran context once; do not rerun it.
- Every filename has exactly one owner. Parent approves ownership changes. No commits, git resets, production server restarts or production mutation by workers. Preserve user's current changes.
- Workers MUST skip build/lint/tests/formatters mid-flight. Parent runs them once after integration. A worker may write a regression for a plausible consumer-visible bug, not source-text/wiring/copy/default tests.
- Browser write-path smoke uses request interception or isolated backend DB. Never sync, rotate, reveal production credentials, enroll real workers or delete actual proxies during QA.
- Backend performs proxy audit; DB persists classifications/history. No bypass/offload. Gemini SESSION only: deactivate at or below configured threshold, reserves above threshold, earliest reset priority. Default threshold 20%, active limit 3 configurable. Weekly/Claude/GPT informational, not selectors.
- Preserve live assigned proxy except dead replacement; manual speed optimization remains separate. Manual sync independent of auto toggle. Unified sync and rotation remain concurrent. No extra maintenance/polling routine.
- Aggregate quota stays in sidebar footer above logout with upward details. No duplicated inline account group. Controller remains fleet node. Worker token/revision safety untouched. Playwright stays installed.
- Preserve `/api/proxies/check` 409/502, atomic history and `UnifiedProxyHistoryEntry.errorMessage` / UDP Unknown semantics. Session cookie API remains authoritative; no auth-protocol migration.
- User approved English-only copy across the surfaces in this repair wave. Normalize existing Vietnamese UI labels/descriptions while preserving technical identifiers, commands, API names and exact business meaning.
- Mobile touch goal 44×44px where practical; compact desktop controls can remain. WCAG AA 2.5.8 baseline is 24px with exceptions. Measure contrast, do not guess it.

## Interfaces, docs and scheduling

Existing exports remain: `CommandPalette({open,onClose})`, `useCommandPalette()`, `RightPanel({open,onOpenChange})`, `ProxyDetailDrawer` props, table callbacks and `EnrollWorkerWizard` props. Current API shapes stay unchanged. Session-authenticated reads must not require an additional legacy password. Parent handles necessary shared exported-symbol changes only after LSP references and contract agreement.

Owner 01 preserves existing CSS variables and component class names. No new token framework. Parent alone updates shared `docs/operations.md` / `DESIGN.md` after smoke. Workers report factual changes rather than race on docs.

Dispatch all 13 slots in one batch. Owner 01 establishes shared styling while others investigate and edit their own markup. Existing token names prevent code dependency; owners 02–13 wait only for shared visual integration before final smoke. Owners 06/07 preserve drawer props; owners 09/10 preserve wizard props. Do not serialize independent work.

Approved execution: all retained F01–F18; trust/error recovery first; English copy normalization throughout owned UI surfaces. Execute 13 disjoint owners in the current workspace, preserve all existing user edits. Shared verification remains parent-only.

## Owner 01 — Shared tokens and motion

**Owns:** `src/app/globals.css`, `src/components/dashboard-shell.css`, `src/components/ui/kinetic-grid.tsx`.
**Findings:** F09, F18. **Commands:** optimize, colorize.
**Contract:** Existing CSS variables, shell class names and KineticGrid props stay unchanged.

- [ ] Read OKLCH palette, `.dark` sidebar override and class consumers. Substitute semantic roles only where they genuinely match. Preserve intentional brand gradients.
- [ ] Remove conflicting sidebar token world; consolidate duplicated surface/text/border literals without flattening brand identity.
- [ ] Reduced motion draws static canvas once after size changes; no ripple/warp RAF. Runtime preference changes stop/restart safely. `document.hidden` pauses RAF; cleanup cancels active frames/listeners. Never create duplicate frame chains.
- [ ] Replace global 0.01ms hammer with intentional reduced-motion alternatives. Preserve busy/error/status meaning and auth/dialog behavior.
- [ ] Supply parent smoke recipe: emulate reduced motion, resize, toggle preference, hide/show tab. Verify static behavior and normal resume; measure contrast before changing text tokens.

**Acceptance:** Incumbent appearance retained; no decorative RAF when reduced/hidden; dialog/auth states remain readable and functional.

## Owner 02 — Truthful auth and readable rejection

**Owns:** `src/app/auth/page.tsx`, `src/app/auth/layout.tsx`.
**Findings:** F01, F02. **Commands:** clarify, harden.
**Contract:** Existing login errors and session methods; auth protocol unchanged.

- [ ] Trace `login()` and session expiry. Reproduce blank submit, intercepted 401, network/500 and delayed pending login.
- [ ] Remove faux 24/24, 38ms, 99.8%, TLS 1.3 and fabricated event/security assurances. Replace with factual session guidance, not a public telemetry endpoint. Delete length-to-256-bit guarantees; length is not entropy.
- [ ] Set request pending before awaiting login. Disable duplicate submit, expose `aria-busy` and inline alert for blank/rejected/network/backend failures. Preserve entered value and password visibility control; never expose secrets in errors.
- [ ] Correct expiry guidance to 24 hours after login, not midnight UTC or sliding TTL. Keep audio optional and reduced-motion behavior.

**Acceptance:** Explicit non-audio errors, one pending request, no unsupported metrics/security claims, Enter/keyboard recovery at 390px and 1440px.

## Owner 03 — Navigation and pool command search

**Owns:** `src/app/(dashboard)/layout.tsx`, `src/components/topbar.tsx`, `src/components/app-sidebar.tsx`, `src/components/command-palette.tsx`, `src/components/command-palette.css`; `src/components/ui/sidebar.tsx` only if primitive adjustment needed.
**Findings:** F04, F10, F11. **Commands:** harden, adapt.
**Contract:** Existing command/sidebar callbacks; no quota-widget or AuthProvider edits.

- [ ] Reproduce authenticated cookie session with empty legacy password. Search must read pools through existing session API.
- [ ] Remove competing inline header password flow; expired session points to `/auth`. Distinguish authenticated session from upstream connection. Sidebar must not claim fixed `9Router Active`; use existing evidence or an honest neutral label, no new polling routine.
- [ ] Migrate search to installed CommandDialog/Input/List/Item. Keep current pool search/navigation only; labels must not promise routes/actions. Loading, failed read, no pools and no matches differ.
- [ ] Make mobile triggers usable, overlays Escape/dismiss correctly and focus return to trigger. Keep quota above logout; owner 04 owns quota interaction.
- [ ] Delete obsolete palette stylesheet only if no consumers remain. Preserve Ctrl+K/platform hint.

**Acceptance:** Session-only search, Arrow/Enter/Escape/Tab support, truthful status, working mobile navigation and no competing password prompt.

## Owner 04 — Quota footer policy and accessible drop-up

**Owns:** `src/components/antigravity-quota-widget.tsx`.
**Findings:** F03, F11. **Commands:** clarify, adapt, harden.
**Contract:** Existing snapshot/component props; same footer placement.

- [ ] Trace snapshot fields, errors, visibility and timers. Unknown quota must not look like measured 0% success.
- [ ] Replace weekly ≤10% / oldest-turn instructions with Gemini session threshold and earliest reset. Reserves need quota above configured threshold; 20% is default, not a universal hard-coded requirement. Weekly display can remain informational.
- [ ] Closed region must be absent/inert to focus and accessibility tree, not only opacity zero. Upward card fits sidebar/mobile sheet; touch click and keyboard focus can inspect it.
- [ ] Reliable pointer handoff and timer cleanup, no arbitrary timeout-only fix. Keep refresh guarded; don't trigger production refresh in QA.

**Acceptance:** Exact policy; closed details not tab-reachable; upward detail usable by keyboard/touch; no invented quota or duplicated group.

## Owner 05 — Overview and Operations evidence states

**Owns:** `src/app/(dashboard)/page.tsx`, `src/components/right-panel.tsx`, `src/components/metric-card.tsx`, `src/components/traffic-chart.tsx`, `src/components/sparkline.tsx`.
**Findings:** F04 and metric truth. **Commands:** harden, clarify.
**Contract:** Current PoolStatus/MetricsSnapshot/PoolRecord and RightPanel props.

- [ ] Reproduce session-only read, null status, unconfigured, failure, running and recovery. Fix password-only gate without bypassing backend authentication.
- [ ] Null status is unknown/loading/auth-required, never Healthy. Unconfigured/error/stale remains labelled. Success and counts need actual evidence.
- [ ] Preserve unified concurrent sync and manual-sync independence. No scheduling/config redesign.
- [ ] Empty data produces no fake sparkline/trend. Accessible trend text only when actual additional information exists; no invented tooltips/graphs.

**Acceptance:** Existing overview behavior, truthful status transitions, session-only reads and no AbortController cleanup regression.

## Owner 06 — Proxy workspace and mobile grid

**Owns:** `src/app/(dashboard)/proxies/page.tsx`, `src/components/proxies/proxy-table.tsx`, `proxy-toolbar.tsx`, `proxy-summary.tsx`, `proxy-selection-bar.tsx`, `proxy-context-menu.tsx`, `audit-job-indicator.tsx` (all preceding short filenames under `src/components/proxies/`); `src/components/proxy-health-badge.tsx`.
**Findings:** F05, F06, F11. **Commands:** adapt, layout.
**Contract:** Existing query, callbacks and health enum; no backend change.

- [ ] Reproduce 390px clipped toolbar/reset; fixture populated rows, long endpoint and bulk selection. Inspect internal scroll/clipping, not only document overflow.
- [ ] Header/actions wrap within width; search shrinks without becoming unusable. Keep table scroll local. Empty message/reset fits visible content rather than wide intrinsic columns.
- [ ] Endpoint, health, selection and actions remain reachable on mobile. Use smallest responsive column/layout solution, not automatic duplicated card tree. Expand touch bounds without bloating desktop.
- [ ] Keep explicit keyboard detail button. Existing delete grouping is correct; retain protections. Add touch action trigger only where existing actions otherwise inaccessible.
- [ ] Preserve dead/everPassed/regressed, pin/unlink/force-delete and manual speed optimization. No new lifecycle, filters or j/k feature.

**Acceptance:** Search/actions/reset visible at 390px; long endpoint safe; selection/query behavior preserved; 409/502 remains error toast without fake health.

## Owner 07 — Proxy drawer and import/export

**Owns:** `src/components/proxy-detail-drawer.tsx`, `src/components/proxies/proxy-import-dialog.tsx`, `src/components/proxies/proxy-export-dialog.tsx`.
**Findings:** F12, F13. **Commands:** harden, adapt, polish.
**Contract:** Existing props, history error/Unknown UDP and credential export guards.

- [ ] Fixture long reasons/endpoints/history errors, import preview error and export selected-count boundaries. No production mutation.
- [ ] Scope/format use installed single-select ToggleGroup or equivalent accessible shadcn control. Selection announced, keyboard operable; Selected Only disabled with zero selection. Credentials remain explicit opt-in.
- [ ] Mobile dialog/sheet has bounded height/local scroll and reachable footer; long content wraps. Bind labels/error descriptions.
- [ ] Preserve failure reason and `UDP not measured`; unavailable exit IP/ISP stays unmeasured. Host address must not masquerade as verified exit node. Detail/history load error differs from no history.

**Acceptance:** Keyboard selection/disabled option correct; long drawer content readable at 390px; honest history/metadata; no fake UDP failure.

## Owner 08 — Settings facts and recovery

**Owns:** `src/app/(dashboard)/settings/page.tsx`.
**Findings:** F03, F13. **Commands:** clarify, harden, layout.
**Contract:** Current per-section SettingsUpdatePayload whitelist/API.

- [ ] Trace configured threshold/active limit; fix weekly/LRU copy to session-only/reset priority and configured threshold, not fixed 20%.
- [ ] Replace native credential checkbox with installed Checkbox and explicit label/description. Preserve false default and export confirmation.
- [ ] Keep section saves. Clarify save scope and mobile button layout. Simple anchors only if needed; no tab or dirty-state framework by default.
- [ ] Load failure exposes error/retry. Save/test pending prevents duplicate writes; values survive failures.

**Acceptance:** Threshold 20% or 30% accurately explained; no weekly/LRU claims; form whitelist intact; mobile actions and recovery work.

## Owner 09 — Nodes inventory/detail

**Owns:** `src/app/(dashboard)/nodes/page.tsx`, `src/app/(dashboard)/nodes/[id]/page.tsx`, `src/components/nodes/node-context-menu.tsx`.
**Findings:** F06, F07. **Commands:** harden, adapt.
**Contract:** Current node/endpoints/events and unchanged wizard props.

- [ ] Reproduce successful empty, 500/network, 404 node vs request error, stale data and long IDs with interception.
- [ ] Separate error/loading/empty, show last successful read when stale; abort reads/catch non-2xx. No extra maintenance polling.
- [ ] Mobile Manage/actions and key health remain visible through existing button/dropdown; back navigation reachable; wide tables scroll locally.
- [ ] Existing nested labels already name quick-endpoint Inputs. Bind separate protocol group, preserve port 1–65535 and server validation; create failures visible with values retained.
- [ ] Controller remains node; roles/revisions/auth untouched. Owner 10 exclusively owns enrollment wizard.

**Acceptance:** Failure never looks like No nodes; mobile actions/detail reachable; 404 distinct from network failure; endpoint errors readable.

## Owner 10 — Enrollment wizard

**Owns:** `src/components/nodes/enroll-worker-wizard.tsx`.
**Findings:** F08, F18. **Commands:** harden, colorize, adapt.
**Contract:** Current props, token API and Linux/ARM/Windows bootstrap commands.

- [ ] Reproduce token non-2xx/network and handshake state transitions with fixtures. Preserve actual backend token TTL.
- [ ] Bind Node Identifier / Controller Server labels with id/htmlFor; readable error/status, pending blocks duplicates, failure retains input.
- [ ] Replace zinc material/text/border classes with existing semantic roles; preserve terminal language/platform meaning, no global translation.
- [ ] Do not claim hard-coded controller IP reachable. Use existing verified config/origin where available; otherwise explicit operator URL. Preserve bootstrap command/security validation.
- [ ] Close/back/unmount stops polling; success callback fires once for intended node. No real token creation in QA; preserve token masking/copy security.

**Acceptance:** Accessible labels and token errors; explicit controller; correct commands; safe cleanup and mobile scroll; backend enrollment unchanged.

## Owner 11 — Endpoint operations

**Owns:** `src/app/(dashboard)/proxy-endpoints/page.tsx`, `src/components/endpoints/endpoint-context-menu.tsx`.
**Findings:** F06, F07. **Commands:** adapt, harden.
**Contract:** Existing endpoint/reveal API and credentials guards.

- [ ] Fixture populated mobile action, list failure, name lookup failure and reveal pending/failure/close.
- [ ] Enabled status and deliberate Reveal remain reachable on mobile. Use installed dropdown/button alternate to right-click; no automatic reveal/plaintext list.
- [ ] Distinguish endpoint failure from partial name lookup. Retry/error/stale identity labelled. Reveal non-2xx/network readable; clear visible credentials on close per existing security contract.
- [ ] Copy only explicitly requested secrets; auth/encryption/disable semantics unchanged.

**Acceptance:** Touch status/reveal reachable; failures never successful empty; correct modal focus; secrets absent from errors/persistent browser state.

## Owner 12 — Monitoring and Events

**Owns:** `src/app/(dashboard)/monitoring/page.tsx`, `src/app/(dashboard)/events/page.tsx`.
**Findings:** F07, F14, F16. **Commands:** clarify, harden, layout.
**Contract:** Current FleetNodeRecord/FleetEventRecord; no new health-probe API.

- [ ] Fixture empty/populated/failed reads. Constants do not prove Beszel Active/current overlay settings; show Not measured or explicitly configured defaults only where source supports them.
- [ ] Loading/error/empty/stale distinct, manual refresh timestamp and safe abort. No new poller.
- [ ] Full event payload available via read-only shadcn disclosure, bounded scroll/wrap and exact timestamp. Keep raw facts, no invented summaries. Call stream Live only if updates actually live.
- [ ] Accessible heading/table relation, mobile local scroll. No virtualization/pagination/filter feature without observed need and parent approval.

**Acceptance:** No events differs from failed read; no false Beszel health; complete long payload readable at 390px; backend history unchanged.

## Owner 13 — Real Help and unavailable exits

**Owns:** `src/app/(dashboard)/help/page.tsx`, `src/components/stub-page.tsx`, `src/app/(dashboard)/scraping/page.tsx`, `src/app/(dashboard)/cdk/page.tsx`, `src/app/(dashboard)/invoice/page.tsx`, `src/app/(dashboard)/referral/page.tsx`, `src/app/(dashboard)/reseller/page.tsx`, `src/app/(dashboard)/wallet/page.tsx`.
**Findings:** F15, F17. **Commands:** onboard, clarify.
**Contract:** Existing static routes; no commercial/scraping backend additions.

- [ ] Read existing operations/deployment/lifecycle docs. Derive exact supported guidance, no invented shell commands.
- [ ] Real Help sections: health/verdicts/Unknown UDP, manual check 409/502 and next steps, auto/manual sync, Gemini threshold/reset priority, worker onboarding/troubleshooting. Link actual `/proxies`, `/settings`, `/nodes` routes.
- [ ] Shared unavailable state uses matching typography and Back to Overview/Proxies. No promised roadmap date, fake wallet/CDK/scraping or nav promotion of unsupported services.
- [ ] Semantic Read layout, keyboard links, long identifier wrapping and mobile content access.

**Acceptance:** Help answers actual 409/502/quota questions from docs; all six secondary routes honest and escapable; no fabricated command/feature claim.

## Parent integration and verification gate

- [ ] Collect 13 reports: changed files, root cause, reproduction recipes, contract changes and limits. Reject unsupported findings/features. Approved shared export changes require LSP references and full caller migration.
- [ ] After all workers settle, run `npm run typecheck`, `npm test`, `npm run lint` once. Report unrelated existing failures; do not re-pin incidental wording tests.
- [ ] Actual app smoke, writes isolated/intercepted: desktop 1440×900 and mobile 390×844 in one batched round. Cover auth blank/401/network/pending/success, cookie-session search, quota open/focus, Operations unknown/error/running, proxy empty/reset/populated/long endpoint, export selection/credential guard, settings facts/error, node empty/error/404/detail, wizard token error, reveal error, monitor unknown, complete event payload and Help/secondary exits. Include reduced motion, Escape and focus return.
- [ ] Capture visuals and internal clipping, not only document overflow. Fix all observed defects in one owned batch, at most one confirmation round. Final detector once over changed markup. End with bounded Impeccable polish; no repeated audit loop.
- [ ] After smoke, parent updates existing shared docs for actual behavior and removes throwaway fixtures/scripts. Audit screenshots can stay archived. Report production-coverage limits; no commit/push without request.

## Critique-close decisions

User selected all retained F01–F18, trust/error recovery priority, and English-only UI copy across owned surfaces. Thirteen repair agents were spawned as one parallel batch with exclusive file ownership. Backend policy remains out of scope. Parent owns integration and the consolidated verification gate.
