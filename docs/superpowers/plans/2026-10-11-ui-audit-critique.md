# UI Audit + Critique — minhmiceProxy

Method: dual-agent pairs (A: DesignShellOverview · B: AuditShellOverview; A: DesignProxySettings · B: AuditProxySettings; A: DesignFleetSecondary · B: AuditFleetSecondary), with parent-run browser and mechanical evidence supplement.

## Scope and evidence boundary

Read-only application assessment. All existing routes included: /, /auth, /proxies, /settings, /help, /nodes, /nodes/[id], /proxy-endpoints, /monitoring, /events, /scraping, /cdk, /invoice, /referral, /reseller, /wallet. Mode Operate; Help Read. Preserve incumbent dark control-room world in PRODUCT.md and DESIGN.md, not redesign.

Six scout agents independently evaluated source. Scout has no browser/bash tools: source scores are provisional heuristic judgment, not WCAG certification or performance measurements. Parent executed actual browser inspection at desktop1440x900 and mobile390x844, first live unauthenticated, then intercepted authenticated empty states and settings data. These fixtures prove rendering, not live backend success. Populated tables, node detail and destructive actions were not exercised; source defects there require isolated fixture reproduction before fixes. Evidence artifacts local://audit-browser-evidence.json and local://audit-browser-fixtures.json; captures .impeccable/audit-2026-10-11-*.png and .impeccable/fixture-audit-*.png. Desktop initial captures include transient hydration states; do not judge opacity or missing content from those frames.

All A assessments completed before parent read B reports/detector output. CLI `impeccable.cmd detect --json src/app src/components` ran once: exit0, output[]. Agent manual rule names are NOT detector findings. Mutation preflight and detect.js injection succeeded on4 pages (/auth,/proxies,/settings,/nodes); no reliable detector-console/overlay findings verified, no persistent user-visible overlay claimed. Temporary server port8400 stopped; parent managed browser tab released. No production API writes, server restarts, build/lint/tests or application edits.

## Verdict and strengths

Product-specific composition: dense operational tables, endpoint monospace, semantic health labels and domain-specific details are worth preserving. shadcn Table already provides horizontal scrolling; proxy delete already separated and danger-styled; guarded credential export and truthful recent check-history reason/UnknownUDP are strong. Biggest weakness: unmeasured status presented as successful and policy copy diverging from actual rules.

Cognitive load: moderate on table workflows, high when Settings instructions contradict policy or event payloads are clipped. Emotional valley: login rejection gives no readable reason; Help navigation ends in Coming soon. Infra power users need reliable stale/error states; first-time operators need actual runbooks; keyboard/touch operators need accessible action parity, not a new batch feature.

## Provisional scorecards

H1 status, H2 real-world match, H3 control, H4 consistency, H5 prevention, H6 recognition, H7 efficiency, H8 minimalism, H9 recovery, H10 help. Scores0–4 reflect source assessment; do not average unrelated pages into product certification. Help is Read: score all10 (static content does not exempt recovery/help). Parent conservatively recalibrates inflated Overview score because authenticated live telemetry was not inspected.

|Surface|H1|H2|H3|H4|H5|H6|H7|H8|H9|H10|Total /40|
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
|Shell/navigation|2|3|3|3|3|3|2|3|2|2|26|
|Overview|3|4|3|3|3|4|3|3|3|2|31|
|Auth|2|1|3|3|2|3|3|2|1|2|22|
|Proxies|3|3|3|2|4|3|3|3|4|2|30|
|Settings|3|1|3|3|3|2|2|3|3|2|25|
|Help|1|1|2|3|3|0|1|2|1|0|14|
|Nodes|3|3|3|3|3|3|3|3|2|2|28|
|Node detail|2|3|3|3|3|3|2|3|2|2|26|
|Endpoints|3|3|3|3|4|3|3|3|2|2|29|
|Monitoring|2|3|3|2|3|3|2|3|2|2|25|
|Events|3|3|3|2|3|1|2|2|2|1|22|
|Six secondary unavailable routes|1|2|3|2|3|1|1|2|1|1|17|

Technical vectors A11y/performance/theming/responsive/integrity (each0–4), provisional source rubric, NOT measured contrast/performance certification:

|Surface|A11y|Perf|Theme|Responsive|Integrity|Total /20|
|---|---:|---:|---:|---:|---:|---:|
|Shell/overview/auth group|2|2|2|3|2|11|
|Proxies|2|3|3|2|3|13|
|Settings|2|3|3|2|2|12|
|Help|2|4|3|3|1|13|
|Nodes/detail/endpoints/monitoring, each|2|3|2|2|3|12|
|Events|2|2|3|2|2|11|
|Enrollment wizard|1|3|1|2|2|9|
|Secondary unavailable pages|3|4|3|3|2|15|

## Findings retained for implementation

No P0 established. P1=major task/trust/accessibility issue; P2=workaround or consistency gap. One unique item per root concern, not six duplicate reports.

|ID|Severity|Evidence and location|Impact and bounded fix|Command|
|---|---|---|---|---|
|F01|P1|auth/page.tsx:63-66,220-238,266-268,390; session-auth.ts:7,31-36|Fixed24/24,38ms,99.8%,TLS1.3,zero-leak/AES256 and midnightUTC claims mislead. Remove unsupported claims and faux telemetry; state24h expiry from login, not midnight or slidingTTL. Keep legitimate login content.|clarify|
|F02|P1|auth/page.tsx:143-177|Blank/rejected/network error only shake/buzz; no pending state during login await. Add accessible text, error differentiation from API and request-pending disabling without changing auth protocol.|harden|
|F03|P1|settings/page.tsx:480; antigravity-quota-widget.tsx:255-256|Weekly≤10% and oldest-turn copy contradict Gemini-session-only/reset priority. Use configured threshold (default20%), disable≤threshold/reserve>threshold, earliest reset; weekly displayed informational only.|clarify|
|F04|P1|app-sidebar.tsx:69; right-panel.tsx:127-129,309-330; live/fixture body|9Router Active fixed; missing password stops operations loads; null status defaultsHealthy. Use verified session state for reads, unknown/loading/error/unconfigured labels until real data. Authenticated is not upstreamConnected.|harden|
|F05|P1|proxies/page.tsx header; proxy-toolbar.tsx; proxy-table.tsx; fixture-audit-proxies-390.png|Toolbar action and reset clipped inside main although document overflow=false. Wrap/shrink controls; empty message/reset outside intrinsic table width; locally scroll table only. No mandatory duplicate card view.|adapt|
|F06|P1|proxy-endpoints/page.tsx:151-155,193-205; nodes/page.tsx hidden action cells|Mobile hides status/reveal/manage; contextmenu not discoverable touch control. Keep status/action available via existing shadcn button/dropdown, preserve guards.|adapt|
|F07|P1|nodes/page.tsx:79-94; nodes/[id]/page.tsx:58-74,80-106; endpoints/page.tsx:43-66,68-83; monitoring/page.tsx:27-45; events/page.tsx:25-43|Non2xx/errors silent or uncaught, empty looks valid, stale data unmarked. Separate request errors from successful empty, accessible retry/read timestamp; abort lifecycle correctly. No added background routine.|harden|
|F08|P1|enroll-worker-wizard.tsx:98-116,286-325|Token failures silently remain, separate labels not associated; hardcoded controller fallback not verified reachable. Accessible failure and id/htmlFor, require deliberate controller URL from existing config/origin. No provision mutations during visual QA.|harden|
|F09|P2|globals.css:130-149; kinetic-grid.tsx:145-160|Global0.01ms reduction yet canvas continuously RAF without reduced-motion/hidden handling. Semantic token consolidation, static reduced-motion fallback and stop when hidden. Do not claim measuredFPS/lag.|optimize|
|F10|P2|topbar.tsx:61-98; command-palette.tsx:27-31,70-98|Search claims routes/actions yet only pools; password gate breaks session-only fetch. Migrate installed shadcnCommand/Dialog, truthful pool search label, loading/error/empty distinct, keyboard select/focus restore.|harden|
|F11|P2|quota-widget.tsx:148-155,169-178; topbar.tsx icon buttons; fixture target measurements|Small mobile hit areas; hidden opacity quota region remains in accessibility tree. Hide inactive content accessibly, improve44px mobile ergonomics, preserve footer/upward layout. 44px is design target, WCAG2.5.8 AA baseline24px with exceptions.|adapt|
|F12|P2|proxy-export-dialog.tsx:76-143|Scope/format custom buttons show selection only visually. InstalledToggleGroup single-select or shadcn equivalent with keyboard/selected semantics; preserve export credentials opt-in.|harden|
|F13|P2|settings/page.tsx export checkbox; proxies/import/export; drawer probe rows|Native checkbox differs projectshadcn rule; small controls/long content need bounded layout. Use existingCheckbox; narrow dialog/long endpoint wrapping; no claim drawer overflow proven with empty data.|polish|
|F14|P2|events/page.tsx:107-111|Raw JSON truncated without full payload affordance. Read-only shadcn disclosure with complete bounded readable payload and exact timestamp; no invented summaries, filtering or virtualization by default.|layout|
|F15|P1|help/page.tsx:1-5, stub-page.tsx|Main nav promises Help but onlyComingsoon. Real read-only runbook from docs/operations.md and deployment docs: status,409/502,quota,manual/autosync,worker enrollment and troubleshooting; no new unsupported commands.|onboard|
|F16|P2|monitoring/page.tsx:81-100|Active(:8090) and overlay settings hardcoded as verified availability. Show not measured when no existing telemetry evidence; network defaults not current confirmation.|clarify|
|F17|P2|stub-page.tsx:4-13 and six secondary pages|Unsupported commercial/scraping routes bareComingsoon deadends. Honest unavailable state, existing navigation return path and matching typography; no invented billing/scraping services or roadmap claims.|onboard|
|F18|P2|enroll-worker-wizard.tsx zinc classes; dashboard-shell.css hardcoded colors|Incumbent token drift; semantic substitutions preserve control-room tone and terminal meaning. Don't expand into new visual world.|colorize|

## Rejected / deferred claims

- shadcn Table ALREADY has overflow-x-auto; proxy menu ALREADY has separators/reddelete.
- Inputs nested inside label in Nodes quick-endpoint dialog have implicit accessible names; only separate unbound wizard labels verified deficient.
- A text input plus link-list is not inherently invalid unless claiming combobox keyboard semantics. Command migration justified by projectshadcn rule and session/error handling, not invented mandatory roles.
- 28px controls do not automatically fail AA2.5.8 (24px baseline); enlarge for product44px touch goal. Need actual spacing/contrast before compliance labels.
- Slate400 contrast3.6:1 was not measured; reject ratio. Global0.01ms is poor motion design but not automatic WCAG2.3.3 AA violation (criterionAAA).
- 200 events are bounded, not unbounded; no benchmark supports perf failure. No virtualization/pagination/filter/j-k shortcuts/new lifecycle status/bulkrestart/curl/billing feature additions.
- Decorative aria-hidden sparkline not inherently invalid; provide accessible actual trend only when conveyed as important information, no mandatory narrative.
- Language normalization requires user choice; preserve bilingual source rather than silently translating whole product.

## Repair direction

Prioritize F01–F08/F15 trust/task issues, then responsive/a11y/token consistency. Separate 13 file-owning slices in companion plan. Finish with bounded polish (one desktop+mobile round, one correction batch, at most one confirmation), not repeated audit loops.
