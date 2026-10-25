# Root-Cause Patch Reference

## Objective
Implement the minimal, surgical fix that resolves the confirmed root cause of a reproduced failure without causing regressions.

## Prerequisite Gate
A fix MUST NOT be attempted unless:
1. The failure has a verdict of `reproduced` from `repro.md`; OR
2. The user has explicitly authorized a fix based on static code evidence.

## Fix Workflow
1. **Single Hypothesis**: State clearly: "I hypothesize X causes Y because Z".
2. **Causal Trace**: Trace from the symptom back to the root trigger line.
3. **Minimal Implementation**: Change only what is strictly necessary. Never bundle speculative refactoring, extra retry loops, or unrequested abstractions.
4. **Regression Test**: Convert the reproduction probe into a deterministic permanent or regression test (`regressionTest`).
5. **Verify**: Ensure the reproduction test now passes, and run the entire affected module suite to verify no siblings broke.
