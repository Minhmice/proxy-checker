# Failure Scenario & Stress Analysis Reference

## Objective
Analyze potential failure modes across independent risk dimensions without modifying production code.

## Delegation and Slicing Rules
1. Dispatch parallel workers according to the complexity budget defined by `scope.md`.
2. Assign each worker (`agent: "scout"`) a distinct, non-overlapping slice:
   - Network & Transport (socket, timeout, TLS, DNS)
   - Authentication & Session (expiry, 401 retry, token race)
   - Concurrency & Deadlock (locks, reentrancy, queues)
   - State Consistency & Drift (split-brain, partial failure, reconciliation)
   - Data Validation & Parsing (malformed input, edge types)
   - Resource & Collision (proxies, ports, database unique keys)
3. For non-trivial waves (3+ workers), MUST assign at least one independent **falsification** worker. The falsification worker actively attempts to disprove proposed failure hypotheses and finds conditions where the failure will NOT occur.

## Required Finding Schema
Every finding reported by workers must include:
- `findingId`: unique identifier (e.g. STRESS-NET-01).
- `category`: failure dimension name.
- `claim`: concise statement of the defect.
- `trigger`: exact runtime preconditions.
- `executionFlow`: step-by-step trace leading to failure.
- `codeEvidence`: specific file, function, and line references.
- `invariant`: the system guarantee violated.
- `impact`: concrete observable result on consumers or system.
- `severity`: "Critical" | "High" | "Medium" | "Low".
- `confidence`: "confirmed" | "likely" | "hypothesis".
- `falsificationExperiment`: minimal check that would prove or disprove the claim.
- `assumptions`: external or unverified premises.

## Boundaries
- Workers MUST NOT modify production code or tests.
- Workers MUST NOT declare a hypothesis "confirmed" without runtime execution evidence.
