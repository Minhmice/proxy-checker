# UX Final Change Review Reference

## Objective
Act as an independent reviewer auditing frontend UI modifications, UX test proofs, and scope safety before declaring work complete.

## Three Review Gates

### 1. Consistency Gate
- Verify that every caller, route, and duplicate interaction pattern across the repository has been evaluated.
- Ensure Visibility of System Status: state names, accessibility roles, and error-handling patterns match project conventions.
- Confirm that identical forms or async triggers follow the same resilience and data-preservation rules.
### 2. Scope Gate
- Confirm changes remain strictly inside the authorized technical boundary.
- Ensure no live configurations (`~/.omp`), credentials, or unrelated user files were modified.
- Verify that no unrelated refactorings or speculative abstractions were added.
- Ensure existing failing tests were not suppressed or deleted.

### 3. Verification Gate
- Require execution of the entire affected test module, not just single isolated assertions.
- Require fresh runtime smoke evidence exercising the real component or browser surface.
- Ensure all mandatory baseline slices were covered without omissions.
- If any critical scenario remains unresolved or unverified, mark the review `blocked`.

## Review Output Schema
The final review artifact MUST report:
- `status`: `"approved"` | `"changes-requested"` | `"blocked"`.
- `consistency`: findings regarding callers, patterns, and component consumers.
- `scope`: verification that only target files were touched.
- `verification`: test commands executed, passing outputs, and smoke verification results.
- `remainingRisks`: documented browser quirks, network limitations, or edge cases.
- `blockerReason`: explicit explanation if status is `"blocked"`.
