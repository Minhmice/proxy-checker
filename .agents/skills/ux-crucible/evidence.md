# UX Evidence Collection Reference

## Objective
Collect and record concrete runtime evidence from UX test executions, reproduction probes, and browser smoke runs, providing empirical proof for all defect claims and verified fixes.

## Evidence Artifact Categories

1. **DOM & Accessibility Tree State**:
   - Element attributes: `aria-busy`, `role="alert"`, `disabled`, `aria-invalid`, `aria-describedby`.
   - Focus state: active element document path before and after modal/dialog interactions.
   - Text values: verified presence of user input values after error triggers (Zero Data Loss).

2. **Network Interception & Timing**:
   - Request counts during rapid button clicking to verify debounce/disable effectiveness.
   - Verified triggering of `AbortController` when navigation or search input changes rapidly.
   - Simulated status codes and latency boundaries.

3. **Console & Unhandled Rejection Audit**:
   - Capture `console.error` and `console.warn` occurrences.
   - Identify unmounted component state updates (`Can't perform a React state update on an unmounted component`), unhandled promise rejections, or memory leaks.

4. **Visual & Interaction Proof**:
   - Screenshot captures for visual feedback, layout overflow, or modal overlays.
   - Browser interaction logs during keyboard or click sequences.

## Required Evidence Record Schema
Every executed UX probe or test must output a structured record:
- `evidenceId`: unique identifier (e.g. `UX-EVID-SAVE-01`).
- `scenarioId`: linked scenario ID from `what-if.md`.
- `actionMode`: `"CREATE"` | `"REVIEW_FIX"`.
- `targetFlow`: UI component, route, or feature under test.
- `framework`: test framework used or `"browser-smoke"`.
- `command`: raw command or script executed.
- `runnerResult`: `"PASS"` | `"FAIL"` | `"TIMEOUT"`.
- `verdict`:
  - `"reproduced"`: failure occurred as predicted on target code.
  - `"not-reproduced"`: invariant held under fault injection.
  - `"inconclusive"`: probe timed out without clear observation.
  - `"harness-error"`: test harness or fixture setup failed.
- `confidence`: `"hypothesis"` | `"likely"` | `"confirmed"`.
  - Promoted to `"confirmed"` ONLY when verdict is `"reproduced"`.
- `scenarioTrace`: the full executed user sequence.
- `debateDecision`: reference to the debate resolution that authorized this check.
- `domSnapshot`: stringified excerpt of relevant DOM/a11y tree (if applicable).
- `networkTrace`: count and status of intercepted requests (if applicable).
- `consoleAudit`: captured console errors or warnings (must be clean for successful verification).
- `visualArtifact`: file path or reference to captured screenshot/trace (if applicable).
- `remainingGap`: documented limitations of the automated harness.

## Fundamental Evidence Rules
- Web research or code inspection alone cannot promote a defect hypothesis to `confirmed`.
- Static inspection alone cannot verify that an interface is resilient.
- Runtime evidence interacting with real DOM nodes, component symbols, or browser instances is mandatory.
