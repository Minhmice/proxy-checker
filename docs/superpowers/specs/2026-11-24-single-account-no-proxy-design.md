# Single-Account Antigravity Rotation Without Proxies

- **Date:** 2026-11-24
- **Status:** Approved for specification; implementation not started

## Goal

Replace multi-account proxy-bound rotation with one-account-at-a-time Antigravity rotation. Remove proxy management from this project. Existing 9Router proxy pools remain untouched; account bindings are removed separately from live 9Router connections.

## Scope and non-goals

### In scope

- Keep one selected Antigravity account active globally across configured 9Router endpoints at steady state. The approved activate-before-deactivate handoff briefly overlaps two enabled accounts; a failed deactivation is surfaced as degraded state, not reported as single-account success.
- Rotate when the active account's Gemini session quota reaches a randomly selected threshold from 10% through 20%, inclusive, or when fresh quota evaluation reports an account error.
- Select replacement accounts with session quota above 20%, no current error, and earliest known reset time; use account ID as deterministic tie-breaker.
- Preserve the current active account when no replacement is eligible or replacement activation fails.
- Remove proxy assignment, proxy health, proxy repair, proxy ownership, proxy intelligence, proxy pool ranking, proxy import/export, proxy auditing, and proxy-only UI/API/database code from the repository.
- Remove obsolete proxy-only plans/specs and update mixed documentation to describe direct Antigravity account rotation.
- Provide one manually executed live migration command that removes `providerSpecificData.proxyPoolId` from every Antigravity connection. It must support `--dry-run`; it must not delete 9Router proxy pools.

### Out of scope

- Deleting proxy pools from 9Router.
- Changing 9Router account authentication or usage endpoints.
- Changing the remaining 9Router node/reverse-proxy transport used by the application itself.
- Rotating on Claude, GPT, weekly quota, or proxy latency.
- Supporting multiple active accounts through a compatibility flag.

## Rotation behavior

The rotator fetches all accounts and current usage from all configured router endpoints in parallel, then makes one global plan. Account identity remains endpoint-qualified when duplicate IDs exist across endpoints.

The plan has account activations and deactivations only; it has no proxy inputs, proxy assignments, or proxy repair actions.

1. With one active account, keep it while fresh Gemini session quota is above its persisted threshold and no fresh account error is present.
2. If the active account is at or below its threshold, or has a fresh account error, find an eligible inactive replacement. A transport failure while reading usage is not proof of an account error or exhausted quota; retain the active account and report unavailable telemetry.
3. An eligible replacement has fresh, finite session quota greater than 20%, no current account error, and valid available quota data. Sort by earliest known valid `resetAt`, then endpoint-qualified account ID; unknown or invalid reset times sort last.
4. Activate one replacement and confirm it enabled through a fresh connection read before deactivating the old account. If activation fails or its outcome is unknown, keep the old account active, report the error, and reconcile remote state before attempting another activation.
5. If no replacement exists, keep the old account active, even if it is at or below threshold. Do not repeatedly deactivate/reactivate it or reroll its threshold.
6. If startup finds multiple active accounts, prefer one with verified healthy quota above its existing threshold, ordered by the same reset-time and ID ordering. If none qualifies, retain one deterministically by endpoint-qualified account ID. Confirm the retained account is still enabled before deactivating extras; then apply the normal replacement rule to that retained account.
7. If no account is active and all configured endpoints were successfully read, activate the first eligible candidate. If none exists, leave the active set empty and report no eligible account; never activate an exhausted account solely to fill the slot.

Each activation receives a threshold sampled uniformly as an integer percentage in `[10, 20]`. Persist it in the existing rotation history, keyed by endpoint-qualified identity, before issuing activation so a process restart or uncertain write cannot reroll it. Reuse it for that active tenure, including across restarts, forced refreshes, and no-successor cycles. A later activation after confirmed deactivation receives a new threshold. An already-active account without a valid persisted threshold receives one once before evaluation. Snapshot/API/UI expose the sampled threshold and telemetry availability, not a configurable cutoff. Invalid persisted thresholds are replaced once with a valid sample and recorded.

The fixed one-account invariant is code-level behavior, not a user setting. Remove `antigravityActiveLimit` from settings, environment examples, UI, validation, and persistence normalization.

## Server architecture and data flow

The server keeps the Antigravity rotator, usage extraction, rotation history, activity logging, backup, authentication, and token telemetry.

`unified-sync-coordinator` retains one maintenance cycle that can run rotation and backup-related maintenance. It no longer depends on pool ranking or proxy intelligence. Proxy pool sync, proxy database reconciliation, Google proxy audit, proxy checks, and proxy-specific scheduled work are removed.

The rotator no longer reads usable proxies, reads or writes `proxyPoolId`, reassigns pools, resets proxies, optimizes proxy speed, repairs proxy routes, or uses proxy ownership/observation state. Account state and API responses omit proxy fields rather than returning stale `null` compatibility fields.

Retain `antigravityRotatorEnabled` and `antigravityRotateMinutes`. Remove proxy-pool settings and checks: `activePoolLimit`, `nineRouterAutoSync`, `nineRouterSyncMinutes`, `checkConcurrency`, `checkTimeoutMs`, `proxyTtlMinutes`, `antigravityActiveLimit`, and `antigravitySessionThreshold`. Rotation remains scheduled by `antigravityRotateMinutes`.

## Repository removal

Delete proxy-only runtime code, routes, database schema/migrations, UI routes/components, API helpers/types, scripts, tests, skills, and documentation. This includes proxy intelligence, pool ranking, proxy checks, proxy parser/core, proxy bindings, proxy import/export/auditor, Telegram proxy refresh, proxy-only benchmarks, and proxy-only smoke tooling.

Remove proxy navigation, command-palette actions, dashboard proxy cards/columns, proxy settings/export controls, and proxy wording from retained screens. Keep product names only where required by repository identity; retained copy must describe account quota control rather than proxy control.

Mixed files such as backup/database infrastructure are retained and simplified only where proxy references are no longer valid. Existing on-disk proxy SQLite files are not deleted automatically by application startup or deployment.

Delete proxy-only historical plans/specs. Keep historical documents only when they describe retained non-proxy behavior; update active README/product/design/deployment documentation to the new scope.

## Live unbind migration

Add a temporary command under `scripts/` with these operations:

- `--dry-run`: list endpoint, account ID, and whether `proxyPoolId` would be removed; perform no writes.
- apply mode: fetch all configured connections, copy `providerSpecificData`, delete only `proxyPoolId`, and call the existing connection update API for changed accounts.
- summarize scanned, changed, skipped, and failed accounts; fail non-zero if any write fails.
- never call pool deletion endpoints.

Run the command once against live 9Router after deploying the code that no longer rebinds accounts. The command is removed after the migration is verified; the migration itself is not part of normal scheduled maintenance.

## Error handling and safety

- Usage fetch failure marks that account unavailable for replacement but must not cause mass deactivation.
- Activation failure leaves the current account active and records the error.
- Deactivation failure is recorded; the next cycle reconciles toward one active account.
- Concurrent rotation calls remain single-flight; a queued rerun observes fresh state.
- Endpoint failures are isolated with `Promise.allSettled`; healthy endpoints still supply telemetry, but an unread endpoint can hide an active account. Suppress new activations until all configured endpoints are readable, or a subsequent successful read proves no conflicting active account exists. Report degraded global reconciliation rather than claiming a one-account guarantee across an unreachable router.
- No code path silently deletes 9Router pools or account records.
- No fallback may reintroduce a proxy assignment.

## Testing

Rewrite rotation tests around observable account behavior:

- one healthy active account remains active;
- quota at the sampled threshold selects a replacement;
- replacement activation occurs before old-account deactivation;
- activation failure preserves the old account;
- no eligible replacement preserves the exhausted account;
- multiple active accounts converge to one deterministically;
- threshold is inclusive 10–20%, stable across restart, forced refresh, and no-successor cycles, and resampled only for a new active tenure;
- empty active sets, unread endpoints, and endpoint-qualified duplicate IDs obey the global activation safety rule;
- migration dry-run makes no writes, apply removes only the binding while preserving other provider data, rerun skips already-unbound accounts, and partial failure returns non-zero without deleting pools.

Update server/API/settings/database contract tests for removed routes, fields, settings, and modules. Delete tests whose only subject is removed proxy behavior. Run the narrow rotation/API tests, then typecheck and the repository test suite during implementation.

## Acceptance criteria

- Every successful global plan selects at most one steady-state active account. Live overlap is allowed only for the approved handoff; failed deactivation or unread endpoints are explicitly reported as degraded, never hidden as success.
- Exhausted active account remains active when no eligible replacement exists.
- No new or scheduled code reads, assigns, or creates proxy pools.
- Live unbind removes only `proxyPoolId`; proxy pools remain on 9Router.
- Build, typecheck, lint, formatting, and relevant tests pass after implementation.
- No obsolete proxy-only plans/specs remain in the repository.
