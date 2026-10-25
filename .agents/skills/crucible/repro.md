# Reproduction Experiments Reference

## Objective
Design and execute deterministic, isolated test probes that prove or disprove whether a suspected defect reproduces against real target symbols.

## Core Invariant: Exercise Real Code
Every reproduction probe MUST directly invoke the production symbol under test. Generic socket, HTTP, or synthetic script demos that do not exercise target code are rejected as `harness-error`.

## Probe Structure & Lifecycle
1. **Preconditions**: Verify target dependencies and test environments are clean.
2. **Healthy Baseline**: Confirm that without the fault/concurrency trigger, the target succeeds.
3. **Fault Injection**: Apply minimal bounded fault at external boundary (e.g. mock fetch timeout or concurrent invoke).
4. **Watchdog**: Set strict execution timeout (e.g. 500ms - 2000ms) to prevent hanging tests.
5. **Oracle**: Assert on consumer-visible safety or liveness invariant.
6. **Cleanup**: Always release sockets, listeners, timers, and database handles in `finally` blocks.

## Verdict Schema
Test runner exit codes do not equal bug verdicts. Always report both:
- `targetSymbol`: function or method under test.
- `runnerResult`: "PASS" | "FAIL" | "TIMEOUT".
- `verdict`:
  - `reproduced`: the failure occurred exactly as predicted, confirming the bug.
  - `not-reproduced`: the target remained safe and the invariant held.
  - `inconclusive`: probe timed out without observation or test setup failed.
  - `harness-error`: probe crashed due to fixture bug, not target defect.
- `rawCommand`: command executed.
- `rawOutput`: terminal stdout and stderr.
- `watchdog`: timeout limit applied.
- `cleanup`: resources verified released.
