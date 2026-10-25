# User Simulation, Falsification & Multi-Agent Debate Reference

## Objective
Systematically simulate complete user interaction sequences, challenge hypotheses through multi-agent peer debate and falsification, and distinguish design risks from confirmed runtime defects.

## Multi-Agent Slicing & Peer Exchange Protocol

### 1. Independent Analysis Phase
The coordinator allocates between 6 and 15 subagents (`agent: "scout"`) across distinct risk dimensions:
- **Dimension 1 (User Goal & Discoverability)**: Validates if the user can find the entry point, understand next actions, and complete primary tasks without friction.
- **Dimension 2 (Interruption & Abandonment)**: Simulates order errors, back/forward history navigation, tab closing, modal dismissal mid-flight, and repeated triggers.
- **Dimension 3 (Temporal & Spam)**: Tests rapid repetitive clicks, network latency spikes, out-of-order responses, and debounce mechanics.
- **Dimension 4 (Feedback & Recovery)**: Evaluates pending/loading indicators, inline recovery from network drops, 4xx/5xx API errors, and empty views.
- **Dimension 5 (Data Integrity & Zero Data Loss)**: Tests double-submit protection, typing during active search requests, and draft preservation under submission failure.
- **Dimension 6 (Accessibility & Boundary Content)**: Checks keyboard navigation (Tab/Shift-Tab/Escape), focus preservation, dynamic ARIA alerts, long text, and boundary inputs.
- **Dimension 7 (Falsification & Existing Mitigations)**: Actively searches for existing guards, debounces, cached drafts, or valid alternate user models that disprove proposed defects.

Each worker operates independently without seeing sibling outputs initially to prevent premature groupthink.

### 2. Peer Counterclaims & Debate Phase
1. **Coordinator Aggregation**: Coordinator ingests all findings, deduplicates overlapping issues, and identifies contradictory claims (e.g. Worker 2 claims double-submit causes data duplication, but Worker 6 identifies an existing `isSubmitting` disable guard).
2. **Targeted Counterclaims**: Coordinator messages specific workers with opposing evidence:
   - Worker A claims defect X; Worker B (falsifier) presents mitigation Y.
   - Worker A must either provide evidence why mitigation Y fails or concede.
3. **Bounded Two-Round Debate**:
   - **Round 1**: Challenge assumptions, present counterexamples or existing code guards.
   - **Round 2**: Resolve remaining critical conflicts or specify a concrete runtime probe to settle the dispute.
   - Debate closes after Round 2. Coordinator records accepted decision, supporting evidence, rejected alternatives, and any remaining dissent.

## Complete Interaction Trace Specification

Every scenario simulated by a worker MUST follow a complete behavioral sequence:
```text
precondition
  → user action
  → observed or predicted UI state
  → user next action
  → next state
  → expected outcome
```

### Trace Constraints
- States must describe observable UI outputs (DOM elements, text changes, disability states, focus location).
- Do not speculate on private internal user emotions; focus on observable actions.
- In `CREATE` mode, all pre-implementation findings are classified as **design risks**, never confirmed bugs.
- In `REVIEW_FIX` mode, pre-test findings are classified as **hypotheses** until verified against the live target.

## Finding Output Schema

Every scenario finding reported by workers must include:
- `scenarioId`: unique identifier (e.g. `UX-SCENARIO-DRAFT-01`).
- `whatIfQuestion`: hypothetical scenario question exploring the risk.
- `userBehaviorTrigger`: specific user action causing the trigger.
- `actionMode`: `"CREATE"` | `"REVIEW_FIX"`.
- `category`: risk dimension name.
- `precondition`: initial setup and route/component state.
- `steps`: array of interaction steps:
  - `userAction`: concrete input, click, keypress, or navigation.
  - `observedOrPredictedUIState`: observable interface reaction (labeled as predicted if pre-implementation).
  - `userNextAction`: what the user attempts next based on the interface state.
  - `nextState`: subsequent interface state.
- `expectedOutcome`: desired contract-compliant behavior.
- `uxInvariantViolated`: specific guarantee broken or at risk.
- `severity`: `"Critical"` | `"High"` | `"Medium"` | `"Low"`.
- `confidence`: `"hypothesis"` | `"likely"` | `"confirmed"`.
  - `hypothesis`: initial theoretical claim from static review.
  - `likely`: supported by static code evidence or caller tracing.
  - `confirmed`: strictly reserved for defects reproduced by automated runtime execution.
- `falsificationExperiment`: concrete check that could disprove this finding.

## Debate Record Schema

Every debated topic recorded by the coordinator must include:
- `debateId`: unique identifier (e.g. `UX-DEBATE-SAVE-01`).
- `issueId`: linked scenario finding ID.
- `round`: `1` | `2`.
- `counterclaims`: arguments raised by falsification or peer workers.
- `existingMitigations`: discovered guards, debounces, or handlers.
- `acceptedDecision`: coordinator's final ruling on the requirement or defect hypothesis.
- `rejectedAlternatives`: options considered and discarded with rationale.
- `dissent`: summary of unresolved non-critical disagreements.
- `resolution`: `"accepted"` | `"probe-required"` | `"blocked"`.

## Boundaries & Non-Negotiable Rules
- Workers MUST NOT alter production code or test files during the scenario/debate wave.
- Majority vote NEVER substitutes for runtime execution evidence.
- A finding remains a hypothesis until a real-target probe produces a verdict of `reproduced`.
