# Product Context — minhmiceProxy

## 1. Register & Identity
- **Product Name:** minhmiceProxy
- **Product Type:** High-Performance Dual-9Router Fleet Management & Antigravity Quota Proxy Operations Console
- **Mode:** Operate (Task completion, rapid triage, situational awareness under live traffic)
- **Primary Domain:** Enterprise Proxy Infrastructure, LLM Quota Balancing (Antigravity & Gemini Session Quotas), Dual-Master 9Router Sync & WireGuard/Tailscale Worker Node Fleet.

## 2. Target Users & Operating Conditions
- **Primary Users:** Site Reliability Engineers (SRE), Network Operators, and AI Infrastructure Developers managing production proxy pools.
- **Operating Conditions:** High pressure, continuous uptime monitoring, dim control-room lighting, rapid decision-making during proxy bans or LLM session quota drops.
- **Cognitive Load Ceiling:** Operators must assess node/pool health within 2 seconds, execute routing adjustments or sync within 5 seconds, and never decipher cryptic error codes without contextual remediation tooltips.

## 3. Core Product Capabilities & Architecture
1. **Dual-Master 9Router Synchronization:**
   - Synchronizes routing topologies across dual-master 9Router instances with three-way merge conflict resolution.
   - Dual-node modifier dashboards, console streaming, proxy-account bindings.
   - Automatic background sync toggleable with zero UI blocking; manual sync trigger on demand.
2. **Antigravity AI Session Quota Rotator:**
   - Automatically tracks Gemini session quota percentages across active accounts.
   - Triggers account rotation when quota drops below 20%, activating standby accounts with quota > 20% and prioritizing those with the shortest reset time.
   - Default concurrency limit of 3 active accounts; keeps proxy-to-account bindings persistent unless the assigned proxy fails.
3. **Proxy Intelligence & Health Auditing:**
   - Continuous latency testing, country/ASN fingerprinting, and routability checks.
   - Proxy health audit centralized in backend database (no client-side bypass).
   - Strict proxy lifecycle: invalid or unparseable proxies are dropped immediately; healthy proxies ranked and bound to active services.
4. **Worker Node Fleet Management:**
   - Orchestrates worker nodes via Tailscale SSH & WireGuard meshes.
   - Controller node managed as an audited inventory node.
   - Public IP gate validation prevents collisions or rogue IP drift.

## 4. Operational Modes & Design Philosophy
- **Mode: Operate:**
  - Every UI element exists to communicate status, throughput, latency, or configuration safety.
  - No decorative AI gimmicks, no fake mock data, no gratuitous glassmorphic blur that degrades FPS on dense grids.
  - Visuals inspired by modern obsidian financial/infrastructure control decks (Image #1): deep charcoal slate (`#0B0B0E`), crisp typography, matte surfaces (`#141418`), and high-energy flame amber/orange accents (`#FF5B22`) to highlight active status, metrics, and warnings.
- **Motion with Purpose:**
  - Motion is functional choreography: communicates state transitions, hover lift affordances, accordion disclosures, and animated chart data feeds without layout thrashing.
  - All animations respect `prefers-reduced-motion`.

## 5. Key Workflows & User Journeys
1. **Pool Health Monitoring & Triage:**
   - Operator opens `/ninerouter/dashboard` or `/` Overview.
   - High-contrast stat cards highlight active vs degraded pools, current Gemini session quota, and aggregate throughput.
   - Real-time flame gradient bar charts indicate latency and request distribution.
2. **Proxy Pool Audit & Binding:**
   - Operator navigates to `/ninerouter/proxies`.
   - Data table surfaces active proxies, latency sparklines, protocol, and assigned Antigravity accounts.
   - Inline `FieldInfo` tooltips provide configuration guidance without vertical helper clutter.
3. **Dual-Router State Reconciliation:**
   - Operator triggers manual sync or inspects live console logs via `live-console-terminal.tsx`.
   - Visual feedback confirms 3-way merge outcome across Node A & Node B with zero lost state.
4. **System Settings & Account Management:**
   - Operator manages rotation thresholds, concurrency limits, and Tailscale credentials in `/settings`.
   - High-contrast tabs with `forceMount` prevent draft loss during tab switches.

## 6. Accessibility & Operational Guardrails
- **WCAG AA Compliance:** Body text contrast ≥ 4.5:1 against card backgrounds; interactive focus targets ≥ 44px.
- **Non-Color Reliance:** Statuses combine color dots with clear semantic labels (e.g. `Active`, `Degraded`, `Syncing`, `Offline`).
- **State Integrity:** Unsaved draft states are never displayed as observed daemon health. Persistence outcomes explicitly surfaced via toast/inline alerts.
