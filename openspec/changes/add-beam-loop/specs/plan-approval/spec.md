# plan-approval — delta

## ADDED Requirements

### Requirement: Plan approval is two-phase because the ask transport is one-shot
Because a chat ask is ONE-SHOT and UNIDIRECTIONAL — all input is taken up
front and `ChatChunk`s stream out through a one-way channel with no handle to
receive a mid-flight client signal — approval SHALL be TWO-PHASE, never a
mid-stream pause. Phase 1: a `plan_only` flag on the ask (an optional
parameter mirroring the existing `bypass_cache`/`persist_allowed`) runs
step-1 planning, returns a PLAN chunk carrying the intended VERBATIM SQL and
the context it would use, then STOPS.

#### Scenario: plan_only returns the plan and executes nothing
- **WHEN** an ask is issued with `plan_only` set
- **THEN** the engine returns a plan chunk with the verbatim intended SQL and the context it would use, and executes no query

### Requirement: Declining a plan runs and egresses nothing
When a returned plan is NOT approved (the client simply does not re-issue),
the engine SHALL have executed no query and sent nothing to any cloud model.
Approval gates execution and egress.

#### Scenario: A declined plan performs no work
- **WHEN** a plan is returned by a `plan_only` ask and the user declines it
- **THEN** no SQL is executed and nothing is egressed to a cloud model — the decline runs and sends nothing

### Requirement: Approval executes the exact plan the user saw, and caches on the approved ask
Phase 2: on approve, the client re-issues the ask echoing back the
`approved_plan`; the engine SHALL execute that exact plan and SKIP re-planning
step 1 — the plan the user saw is the plan that runs (trust, and no double
plan cost). The answer cache SHALL key on the APPROVED ask, not the
`plan_only` operation.

#### Scenario: Approve runs the shown plan without re-planning
- **WHEN** the user approves and the ask is re-issued with `approved_plan`
- **THEN** the engine executes the SQL the user saw and does not repeat step-1 planning

#### Scenario: Only the approved ask is cached
- **WHEN** a `plan_only` op is followed by an approved re-issue of the same question
- **THEN** the `plan_only` op leaves the answer cache unchanged and the approved ask populates it
