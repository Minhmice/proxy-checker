# Product Context — minhmiceProxy

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Site reliability engineers, network operators, and AI infrastructure developers monitoring LLM quota and usage under live traffic, often in dim control rooms. Operators need to assess account health within two seconds and get actionable explanations for failures.

## Product Purpose

minhmiceProxy is a 9Router quota and token telemetry console. It keeps eligible accounts serving traffic and gives operators one place to check session quota, confirmed account rotation, model token usage, and cost.

## Positioning

The console combines live telemetry with independent two-account rotation for Antigravity and Codex. It uses observed session quota and verifies the successor before switching off the incumbent, rather than assuming a requested change succeeded.

## Operating Context

- **Dashboard (`/`):** Monitor aggregate quota, active and reserve accounts, and model usage. Switch the main numeric display between token volume and cost.
- **Settings (`/settings`):** Manage 9Router credentials, the shared rotation toggle and interval, Git backups, and the control password. Tab changes preserve draft settings.
- **Rotation feedback:** The dashboard announces a confirmed replacement as a toast. Opening the dashboard does not replay past rotations.

## Capabilities and Constraints

- Antigravity and Codex are evaluated independently. Each provider keeps two active accounts when eligible standbys exist. Claude accounts are not rotated; this workflow connects directly to 9Router without a proxy pool.
- The persisted threshold is sampled once per activation from 5–10% inclusive. Antigravity decisions use Gemini session quota; Codex decisions use Codex session quota. Weekly quota is display-only and hidden for Codex.
- At or below the threshold, or on a qualifying account error, choose an eligible same-provider standby with more than 20% session quota, ordered by highest session quota and then earliest reset. Confirm the successor active before deactivating the incumbent. Keep the incumbent if no successor is available or activation fails.
- Scheduled rotation can be disabled without disabling manual refresh. Quota collection and router sync are not serialized solely for UI presentation.

## Evidence on Hand

- `README.md` documents the rotation contract and local operation.
- `tests/antigravity-rotation-history.test.ts` exercises confirmed handoff, persistence, and failed writes. `tests/a11y/` covers dashboard accessibility.

## Product Principles

- **Observed state first.** Show unavailable quota as unavailable, not 0%. Keep unsaved settings distinct from configuration in effect.
- **Safe handoff before throughput.** Retain a working incumbent until its replacement is verified.
- **Triage quickly.** Show quota, health, and threshold together. Explain both the failure and the next useful action.
- **Confirm actual outcomes.** Use a toast or inline alert to distinguish completed changes from failed or pending ones.

## Accessibility & Inclusion

Target WCAG AA: at least 4.5:1 for body text and 44px interactive targets. Pair status colors with meaningful text (such as Active, Scheduled Rotate, Reserve, and Degraded). Preserve keyboard operation and honor reduced-motion preferences.
