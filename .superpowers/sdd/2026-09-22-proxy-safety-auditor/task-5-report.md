# Task 5 Report: Scoring, Explainable Risk Factors & Overall Verdict

Date: 2026-09-22

## Scope

Implemented weighted scoring, structured risk explanations, recommendations, and verdict precedence for auditor evidence.

## TDD evidence

1. Wrote `tests/auditor/scoring.test.ts` before production scoring modules.
2. RED run:

```text
Error: Cannot find module '../../src/auditor/scoring/scores.js'
```

3. Added implementation in:
   - `src/auditor/scoring/scores.ts`
   - `src/auditor/scoring/explanations.ts`
   - `src/auditor/scoring/verdict.ts`
4. Final focused run:

```text
node --import tsx --test tests/auditor/scoring.test.ts
```

Result: 15 passed, 0 failed.

## Scoring behavior

- Transport Security weight: 35%.
- Privacy weight: 30%.
- Reputation weight: 20%.
- Reliability weight: 15%.
- Missing required category evidence returns `null` for that category and `overallSafety`; missing data never becomes a safe score.
- Overall score rounds to nearest integer after weighted aggregation.

## Verdict behavior

Critical failures always return `FAIL`, regardless of numeric score:

- `SSRF_VIOLATION`
- `CONNECTION_FAILED`
- `TLS_CERTIFICATE_INVALID`
- `SPKI_MISMATCH`
- `CONTENT_TAMPERING`
- `ORIGIN_IP_EXPOSED`

Insufficient evidence returns `UNKNOWN`. Operational or reputation factors return `WARN`. Fully measured evidence with no warnings returns `PASS`.

## Explainability

Each generated factor includes stable uppercase `code`, severity, title, description, message, category, evidence, and actionable recommendations. Recommendations are deduplicated while preserving deterministic order.

Warning factors cover high latency, abuse history, unstable exit IP, DNS leaks, header leaks, datacenter/VPN egress, and declared-exit mismatch. Informational factors cover VPN egress where observed. Incomplete probe groups produce `INSUFFICIENT_EVIDENCE`.

## Consistency and scope checks

- Searched scoring call sites and duplicate weight/factor definitions. New scoring API has only intended test consumers; no stale duplicate implementation exists.
- Diff contains only requested scoring modules, focused tests, and this report.
- Full `tsc` was attempted. It reports seven unrelated pre-existing errors in `tests/auditor/probes.test.ts`, `tests/auditor/fixtures/mock-proxies.ts`, and `tests/auditor/transport.test.ts`. Scoring-only type check passed with Node types enabled.

## Commit

Required commit message:

```text
feat(auditor): implement scoring engine, risk explanations, and verdict logic
```
