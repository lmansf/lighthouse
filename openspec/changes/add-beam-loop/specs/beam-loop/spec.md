# beam-loop — delta

## ADDED Requirements

### Requirement: The analytics loop is bounded by a budget, not a hardcoded count
The multi-step analytics executor SHALL run under an explicit BUDGET —
`max_steps` (a config default, ~5–6), a wall-clock deadline, a no-progress
guard (a step whose SQL repeats a prior step's, or two consecutive
non-advancing replies), and a token ceiling — rather than the current bare
`steps.len() < 3` guard. The former hardcoded "3" SHALL be removed from the
loop guard, the step-planning prompt (`step_question`), and the progress
label; each SHALL read the budget. The loop SHALL keep the single COMBINED
plan+decide model call per iteration — no separate reflection turn.

#### Scenario: The loop stops at max_steps
- **WHEN** the model keeps requesting another query past the configured `max_steps`
- **THEN** the loop halts at `max_steps`, narrates over the steps already run, and the progress labels and prompt reflect the configured budget rather than a hardcoded 3

#### Scenario: The no-progress guard halts a stuck loop
- **WHEN** a planned step repeats the exact SQL of a prior step (or the model returns two consecutive non-advancing replies)
- **THEN** the loop stops early instead of spending the remaining budget on a query that cannot advance the answer

### Requirement: Token-ceiling bounding degrades safely when usage is unreported
The token ceiling SHALL be enforced from provider-reported usage accumulated
across every model call in the ask. When a provider reports no usage, the
token budget SHALL stay zero and the loop SHALL fall back to `max_steps` and
the deadline — it SHALL NEVER run unbounded because a token count is missing.

#### Scenario: A provider that reports no usage still terminates
- **WHEN** the loop runs against a provider that does not report token usage
- **THEN** the token ceiling cannot bind, and the loop still terminates at `max_steps` or the wall-clock deadline, never looping without a bound

### Requirement: Every loop figure is engine-computed, never model-authored
Every value in a loop answer SHALL come from executing a guarded SELECT
against the vault's own bytes. The model SHALL only plan/decide the next step
and, at the end, narrate over already-verified step results — it SHALL author
no number.

#### Scenario: Removing narration changes no figure
- **WHEN** the loop runs on a cloud provider and the model narrates the combined result
- **THEN** every figure in the answer traces to a step's query result, and removing the narration text changes no number in the answer

### Requirement: The loop stays remote-keyed; local keeps the single-query path
The multi-step loop SHALL run only on keyed remote providers (the existing
`remote_keyed` gate). A local provider (whose 6144-token window cannot carry
`STEP_RESULT_CAP × N` accumulated context) and the extractive fallback SHALL
keep today's single-query analytics path.

#### Scenario: A local ask does not enter the loop
- **WHEN** an ask carrying a multi-step cue is answered by the local provider
- **THEN** it takes the single-query analytics path, not the loop, exactly as before this change
