# Product Context — minhmiceProxy

## 1. Register & Identity
- **Product Name:** minhmiceProxy
- **Product Type:** Antigravity Account Quota Management & Token Telemetry Console
- **Mode:** Operate (Task completion, rapid triage, situational awareness under live traffic)
- **Primary Domain:** LLM Quota Balancing (Antigravity & Gemini Session Quotas), 9Router Node Transport & WireGuard/Tailscale Worker Node Fleet.

## 2. Target Users & Operating Conditions
- **Primary Users:** Site Reliability Engineers (SRE), Network Operators, and AI Infrastructure Developers managing model quota and token efficiency.
- **Operating Conditions:** High pressure, continuous uptime monitoring, dim control-room lighting, rapid decision-making during LLM session quota exhaustion.
- **Cognitive Load Ceiling:** Operators must assess account health within 2 seconds, execute routing adjustments or sync within 5 seconds, and never decipher cryptic error codes without contextual remediation tooltips.

## 3. Core Product Capabilities & Architecture
1. **Antigravity AI Single-Account Quota Rotator:**
   - Tracks Gemini session quota percentages across configured Antigravity accounts.
   - Enforces single-account active tenure globally across configured 9Router endpoints at steady state.
   - Uniformly samples an integer quota threshold between 10% and 20% inclusive per activation tenure, persisted in SQLite across process restarts.
   - Triggers rotation when the active account's Gemini session quota drops to or below its threshold, or when an account error occurs.
   - Activates eligible standby accounts (>20% quota, no error) prioritizing earliest reset duration (`resetAt`).
   - Ensures safe activate-before-deactivate handoff, retaining the current account if replacement activation fails or no eligible candidates exist.
2. **9Router Node Transport & Synchronization:**
   - Connects directly to 9Router endpoints without proxy pool layers.
   - Synchronizes connection states and aggregates model token usage telemetry across nodes.
   - Non-blocking concurrent execution alongside quota evaluation.
3. **Worker Node Fleet Management:**
   - Orchestrates worker nodes via Tailscale SSH & WireGuard meshes.
   - Controller node managed as an audited inventory node.
   - Public IP gate validation prevents collisions or rogue IP drift.

## 4. Operational Modes & Design Philosophy
- **Mode: Operate:**
  - Every UI element exists to communicate status, throughput, quota, or configuration safety.
  - No decorative AI gimmicks, no fake mock data, no gratuitous glassmorphic blur that degrades FPS on dense grids.
  - Visuals inspired by modern obsidian financial/infrastructure control decks: deep charcoal slate (`#0B0B0E`), crisp typography, matte surfaces (`#141418`), and high-energy flame amber/orange accents (`#FF5B22`) to highlight active status, metrics, and warnings.
- **Motion with Purpose:**
  - Motion is functional choreography: communicates state transitions, hover lift affordances, accordion disclosures, and animated chart data feeds without layout thrashing.
  - All animations respect `prefers-reduced-motion`.

## 5. Key Workflows & User Journeys
1. **Account Quota & Token Telemetry Monitoring:**
   - Operator opens `/` Dashboard.
   - High-contrast stat cards highlight active account quota, model token distribution, and cost metrics.
   - Real-time dot-matrix displays toggle between token volume and cost.
2. **Account Status & Rotation Tracking:**
   - Overview data table surfaces active and reserve Antigravity accounts, Gemini session quota, weekly quota, assigned threshold, and rotation status.
   - Explicitly unavailable quota is shown truthfully; never faked as 0%.
3. **System Settings & Account Management:**
   - Operator manages 9Router endpoint credentials, rotation daemon intervals, and master access password in `/settings`.
   - High-contrast tabs with `forceMount` prevent draft loss during tab switches.

## 6. Accessibility & Operational Guardrails
- **WCAG AA Compliance:** Body text contrast ≥ 4.5:1 against card backgrounds; interactive focus targets ≥ 44px.
- **Non-Color Reliance:** Statuses combine color dots with clear semantic labels (e.g. `Active`, `Scheduled Rotate`, `Reserve`, `Degraded`).
- **State Integrity:** Unsaved draft states are never displayed as observed daemon health. Persistence outcomes explicitly surfaced via toast/inline alerts.
