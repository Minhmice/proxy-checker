# Final Change Review Reference

## Objective
Act as an independent reviewer checking code modifications, test proof, and scope safety before declaring work complete.

## Three Review Gates
1. **Consistency**:
   - Verify every caller and duplicate pattern across the repository has been updated.
   - Ensure exported symbol changes match consumer expectations.
2. **Scope**:
   - Confirm changes remain strictly inside the authorized boundary.
   - Ensure no unrelated code, user files, or existing failing tests were modified or suppressed.
3. **Verification**:
   - Require execution of full affected test modules, not only single isolated assertions.
   - Exercise the real runtime path and inspect raw command output.

## Review Output Schema
- `status`: "approved" | "changes-requested" | "blocked".
- `consistency`: findings regarding callers, re-exports, and duplicate call sites.
- `scope`: verification that only target files were touched.
- `verification`: test commands executed and raw passing results.
- `remainingRisks`: documented known edge cases or platform limitations.
