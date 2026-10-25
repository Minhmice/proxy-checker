# UX Test Generation, Reproduction & Regression Reference

## Objective
Design and execute deterministic, isolated automated tests and probes that verify user interaction sequences, reproduce confirmed UX defects against real target code, and establish permanent regression tests.

## Native Test Harness Discovery
Never mandate a specific third-party test framework if absent from the repository:
1. Detect existing repository test runners (e.g. `node:test`, Vitest, Jest, Playwright, Cypress).
2. Discover existing component testing conventions (React/Vue/Svelte testing utilities, browser automation tools, or custom harness scripts).
3. Align newly generated tests with the discovered conventions. For temporary smoke testing, standard HTML/JS fixtures and browser tools are used.

## Mode Execution Workflows

### 1. `CREATE` Workflow Execution
1. **Derive Acceptance Probes**: Before writing implementation code, translate each approved `AC-<ID>` into an executable probe or assertion suite.
2. **Minimal Implementation**: Implement the minimal component, route, or hook code strictly necessary to fulfill the approved UX contract.
3. **Execute Post-Create REVIEW_FIX Loop**:
   - Immediately audit the newly built UI through the `REVIEW_FIX` loop.
   - Run the full scenario suite against the live implementation.
   - Any failure discovered here is treated under the standard reproduction and patch workflow.

### 2. `REVIEW_FIX` Workflow Execution
1. **Hypothesis Prioritization**: Rank scenario findings by severity and confidence.
2. **Deterministic Reproduction Probe**:
   - Each probe MUST exercise the actual production component, hook, or route.
   - Mocks are applied ONLY at external boundaries (e.g. HTTP fetch, network timer, browser offline status).
3. **Verdict Determination**: Record test runner status and assign an autonomous verdict:
   - `reproduced` / `vulnerable`: The failure occurred exactly as predicted, proving the UX defect.
   - `not-reproduced` / `resilient`: The target handled the input or disruption gracefully; invariant held.
   - `inconclusive`: Watchdog expired without conclusive observation; harness retry needed.
   - `harness-error`: Fixture or mock crashed; repair the test setup, not production code.

## Deterministic Test Execution Lifecycle

Every generated test or reproduction probe must implement this six-stage lifecycle:

```text
[1. PRECONDITIONS] → [2. HEALTHY BASELINE] → [3. FAULT INJECTION]
        │
        ▼
[4. WATCHDOG TIMER] → [5. CONSUMER ORACLE] → [6. CLEANUP (FINALLY)]
```

1. **Preconditions**: Specify targetFlow, ensure isolated test container, pristine storage, and initialized mocks.
2. **Healthy Baseline**: Execute the happy path without chaos; confirm that normal user actions succeed.
3. **Fault Injection**: Apply bounded external trigger (e.g. inject 500 error, delay response by 1000ms, simulate rapid double-click, or send Escape key).
4. **Watchdog Timer**: Enforce a strict timeout (1000ms to 3000ms) to abort hanging tests.
5. **Consumer Oracle**: Assert strictly on user-visible or assistive-technology state:
   - Button disabled state or pending indicator.
   - Error banner or inline validation message (`role="alert"`).
   - Preservation of user-entered input values (Zero Data Loss).
   - Focus location.
6. **Cleanup**: Guarantee that DOM containers, mock handlers, timers, and browser tabs are cleanly released in `finally` blocks.

## Root-Cause Patching & Regression Testing

### Patch Prerequisite Gate
A code patch MUST NOT be attempted unless:
1. The failure has a verified verdict of `reproduced` from an executed probe; OR
2. The operator explicitly authorizes an intervention based on unambiguous static evidence.

### Patch Rules
- **Single Causal Trace**: Trace from the observable UI symptom directly back to the root cause (e.g. missing `disabled` attribute, state reset in `catch` block, missing `AbortController`).
- **Minimal Surgical Diff**: Modify only the code necessary to satisfy the broken invariant. Do not introduce unrequested refactorings or speculative helpers.
- **Permanent Regression Test**: Retain the reproduction probe as a permanent regression test with passing assertions.
- **Full Module Verification**: Execute the full affected test module to verify that no adjacent functionality broke.
