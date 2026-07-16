# answer-cost — delta

## ADDED Requirements

### Requirement: Token counts are provider-reported, never estimated
An answer's cost meter SHALL report the input, output, and total token counts
as PROVIDED by the model provider, summed across every model call the ask made
(plan calls, corrective retries, and narration). When a provider reports no
usage, the meter SHALL show "not reported" for that ask — it SHALL NEVER
substitute a `chars/4` (or any other) estimate. The `chars/4` heuristic
remains prompt-sizing only; surfacing it as a user-facing token count would
violate the "every number engine-computed / provider-honest" invariant.

#### Scenario: Reported usage is summed honestly
- **WHEN** an ask makes three model calls against a provider that reports usage
- **THEN** the meter shows the summed provider-reported input/output/total tokens across all three calls

#### Scenario: An unreported provider shows "not reported", never a guess
- **WHEN** an ask runs against a provider that does not report token usage
- **THEN** the meter shows "not reported" for tokens, and never a `chars/4` or other estimated number

### Requirement: The dollar figure is a labeled estimate, never a charge
The cost meter's dollar figure SHALL be derived as provider-reported tokens ×
a shipped per-model price constant and SHALL be LABELLED as an estimate (e.g.
"estimated at $X/Mtok") — never presented as an authoritative charge. Tokens
are honest (provider-reported); the dollar value is derived. A local/loopback
answer SHALL report its tokens with a cost of $0.00 (loopback is not egress).

#### Scenario: A cloud answer's dollars are marked estimated
- **WHEN** a cloud answer's cost meter renders a dollar figure
- **THEN** the figure is explicitly labeled as an estimate at the per-model rate, never shown as a billed or authoritative charge

#### Scenario: A local answer costs $0.00
- **WHEN** an answer is computed on the local/loopback model
- **THEN** the meter shows the provider-reported tokens with a cost of $0.00

### Requirement: A cached replay reports zero new cost
The cost meter SHALL persist with the cached answer, and replaying a cached
answer SHALL report 0 NEW tokens and $0 new cost — consistent with the
`cachedAt` stamp meaning the replay computed nothing. The stored meter SHALL
still carry the original answer's figures as the historical record.

#### Scenario: Replaying a cached answer computes nothing
- **WHEN** a previously answered question is served from the answer cache
- **THEN** the meter reports 0 new tokens and $0 new cost for the replay, alongside the original answer's stored figures

### Requirement: Costs accumulate across asks
The engine SHALL maintain a cumulative token/cost total across asks, surfaced
beside the audit record, so the user sees the running total, not only the
per-ask figure.

#### Scenario: The running total sums two asks
- **WHEN** two billable asks complete in a session
- **THEN** the cumulative total beside the audit record equals the sum of the two asks' provider-reported tokens (and their labeled-estimate dollars)
