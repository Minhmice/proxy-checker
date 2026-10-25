# UX Scope Extraction Reference

## Objective
Establish the technical and interaction boundary of the targeted UI component, form, page, or interactive flow before dispatching the 6–15 scenario subagents.

## Scope Extraction Workflow by Mode

### For `CREATE` (New Feature / Flow)
1. Read the feature brief, user goals, and design constraints from the incoming context.
2. Define intended entry points (route, navigation link, button trigger, initial modal).
3. Enumerate expected user actions across the proposed journey.
4. Establish core UX invariants for the new feature:
   - Clear system status during asynchronous operations.
   - User data preservation on validation failure or network drop.
   - Actionable recovery paths and idempotency on trigger actions.
   - Standard keyboard navigation and focus management.
5. Identify technical integration points (state stores, APIs, hooks) to be created or connected.
6. Explicitly define what is out of scope for the new feature.

### For `REVIEW_FIX` (Existing Flow / Defect Audit)
1. Identify the existing component, route, modal, or hook from `targetFlow` and `changedFiles`.
2. Trace upstream navigation triggers, callers, and downstream side effects.
3. Enumerate all user-executable actions in the existing flow.
4. Document the reported defect or suspected UX flaw if provided in context.
5. Catalogue existing mitigations (e.g. disabled buttons, debounce wrappers, validation checks).
6. Document untouched modules as `excludedScope` to prevent collateral diff expansion.

## Complexity Classification & Worker Allocation

The coordinator evaluates the interaction footprint to select the scenario team size:

| Complexity Class | Interaction Footprint | Subagent Allocation |
|---|---|---:|
| **`simple`** | Pure visual component, static dialog, single-action trigger | **6** |
| **`form-async`** | Input form, search input with remote fetch, mutation trigger | **8–10** |
| **`multi-step`** | Multi-screen wizard, shopping checkout, tabbed workspace | **11–13** |
| **`realtime`** | Collaborative editor, optimistic update with sync, live feeds | **14–15** |

Complexity governs worker partitioning across independent risk slices; it does not reduce testing rigor.

## Required Scope Output Schema
The scope artifact MUST contain the following fields:
- `targetFlow`: string naming the component, route, or feature under test.
- `actionMode`: `"CREATE"` | `"REVIEW_FIX"`.
- `entryPoints`: string[] of entry triggers, URLs, or navigation paths.
- `userActions`: string[] of all user-executable actions in the flow.
- `criticalJourneys`: string[] of primary intended user journeys.
- `uxInvariants`: string[] of guarantees that must never be violated.
- `riskDimensions`: string[] of relevant chaos dimensions.
- `targetFiles`: string[] of component, hook, style, or test files in scope.
- `excludedScope`: string[] of adjacent files or features explicitly untouched.
- `complexity`: `"simple"` | `"form-async"` | `"multi-step"` | `"realtime"`.
- `workerBudget`: number between 6 and 15 representing scenario subagents.
- `openQuestions`: string[] of unresolved product or technical questions.

## Stopping Gates
- If `targetFlow` (for `REVIEW_FIX`) or `brief` (for `CREATE`) cannot be determined from context, STOP with a routing blocker (`BLOCKED`).
- **Autonomous Resolution**: Routine details (button debounce duration, loading spinner placement, inline error copy) MUST be derived from repository conventions and documented as assumptions. Do NOT ask the operator.
- **Irreducible Blocker**: STOP and ask the human operator ONLY when a missing requirement alters the core product contract, permissions, target identity, or triggers an irreversible destructive action.
