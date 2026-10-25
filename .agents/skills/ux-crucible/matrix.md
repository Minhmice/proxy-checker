# UX State Machine, Contract & Acceptance Criteria Reference

## Objective
Map user interaction flows into formal state transitions, establish contract invariants specific to the target flow, and define testable acceptance criteria for `CREATE` and `REVIEW_FIX` modes.

## Formal UX State Machine

```text
       [USER INPUT]
IDLE ---------------> DIRTY
  │                      │
  │                      │ [SUBMIT TRIGGER]
  │                      ▼
  │                  PENDING / IN_FLIGHT
  │                      │
  │          ┌───────────┴───────────┐
  │          │ [SUCCESS]             │ [FAILURE]
  │          ▼                       ▼
  │       SUCCESS            RECOVERABLE_ERROR
  │          │                       │
  │          │ [DISMISS/NAV]         │ [USER RETRY / EDIT]
  └──────────┴───────────────────────┘
                                     │
                             [CRITICAL BREAK]
                                     ▼
                                FATAL_ERROR
```

## State Definitions & Contract Invariants

States and transitions are applied where appropriate to the target flow's architecture rather than forced as arbitrary boilerplate:

| State | Entry Trigger | Observable Feedback | Interaction Constraint | Data Invariant |
|---|---|---|---|---|
| **IDLE** | Component mounted, route loaded | Clean view, default values, placeheld inputs | All primary controls operable | Baseline clean state; no dirty indicators |
| **DIRTY** | User modifies field, selects option | Visual indicator of unsaved changes where appropriate | Submit enabled if valid, or clear validation cues | In-memory draft tracked; edits preserved |
| **PENDING** | Action initiated, async mutation started | Visible in-flight indicator (spinner, progress bar, or label change); `aria-busy="true"` | Trigger disabled or debounced to prevent duplicate requests | Inputs locked or read-only during submission; NEVER cleared |
| **SUCCESS** | API returns 2xx, mutation succeeds | Confirmation notification, toast, badge, or route navigation | Clear dirty indicator; reset inputs only if creating new record | Transaction committed; local state synchronized |
| **RECOVERABLE_ERROR** | API returns 4xx/5xx, network drops | Inline message next to invalid field or prominent error banner | Primary action re-enabled; retry action available | **Zero Data Loss**: User-authored text MUST NOT be wiped on submission failure |
| **FATAL_ERROR** | Uncaught exception, app state corruption | Error boundary card with plain-language message | Broken component isolated; "Reload" or "Go Back" action provided | Session state safely contained |
| **DEGRADED_OFFLINE** | Offline connection or severe latency | Status banner or icon indicating offline/degraded operation | Destructive actions gated; local edits queued or safely stored | Local draft preserved until connection recovers |

## Core UX Invariants by Dimension

1. **System Status & Immediate Feedback**:
   - Provide clear, prompt visual feedback on asynchronous operations. Avoid leaving the user uncertain whether an action registered.
   - Contrast and visible states must conform to applicable design system conventions.

2. **Zero Data Loss (User-Authored Content)**:
   - When an async submission or validation fails, user-authored inputs (drafts, notes, form fields) must NEVER be discarded.
   - Sensitive fields (such as passwords or payment CVVs) may be cleared per security standards; non-sensitive inputs must be retained for correction and retry.

3. **Idempotency & Duplicate-Action Guards**:
   - Critical triggers (placing an order, saving a document, deleting a record) must guard against rapid repeated clicks via button disabling or debounce mechanisms.

4. **Actionable Recovery**:
   - Error messages must explain what went wrong in plain language and provide a direct recovery path (e.g. "Retry", "Check connection", "Correct highlighted field"). Avoid cryptic raw HTTP status codes.

5. **Accessibility & Modality Invariants**:
   - Full keyboard navigation (Tab, Shift-Tab, Enter, Space, Escape) must be preserved.
   - Focus must not be lost into the document body on error; move focus to the first invalid field or error banner.
   - Modals must trap focus while open and restore focus to the trigger element upon dismissal.
   - Dynamic error announcements must use `role="alert"` or `aria-live` regions.

## `CREATE` Mode Acceptance Criteria Format

In `CREATE` mode, the agreed UX contract is translated into concrete, testable acceptance criteria prior to implementation:

```text
AC-<ID>: Given <precondition>,
         When <user interaction sequence>,
         Then <observable interface outcome>;
         Verify with: <specific test assertion or DOM check>.
```

### Example Acceptance Criteria
- **`AC-DRAFT-01`**: Given a user with unsaved text in the editor, when the user clicks "Save" and the network fails, then an error banner appears, the "Retry" button is enabled, and the editor retains the exact entered text.
- **`AC-DRAFT-02`**: Given an open confirmation dialog, when the user presses `Escape`, then the dialog closes and focus returns to the "Delete" trigger button.
- **`AC-DRAFT-03`**: Given a pending save operation, when the user repeatedly clicks "Save", then only one network request is dispatched and the button remains disabled until settlement.

## `CREATE` Contract Approval Gate
The coordinator grants internal approval for the `CREATE` contract only when:
- Every critical scenario identified during the simulation wave maps to an explicit `AC-<ID>`.
- Acceptance criteria specify observable outcomes rather than unverified internal state.
- All critical debate counterclaims have been addressed with consensus or an empirical probe.
