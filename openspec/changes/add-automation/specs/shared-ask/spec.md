# shared-ask — delta

## ADDED Requirements

### Requirement: A shared headless-ask helper wires the audit + egress chokepoint

The engine SHALL provide ONE helper (`ask::run_headless_ask(question,
included_ids, history, opts)`) that resolves an ask's scope and provider config
through `investigations::resolve_ask_context` over `profile::model_config()`
(or the local config when forced), wraps `audit::AnswerAudit::start` before the
answer stream and `.finish(provider, file_ids, artifacts, cost)` after the final
chunk, and calls `synth::answer_pipeline` in between — the identical sequence the
UI transports (`routes.rs::chat_post`, `commands.rs::chat_ask`) assemble inline.
Every NON-UI ask entry point (the CLI, the MCP `ask_vault` tool) SHALL answer
through this helper, so a headless ask is audited and egress-attributed exactly
as an app ask is, by construction rather than by remembering.

#### Scenario: A headless ask is recorded in the audit + egress ledger

- **WHEN** an ask is answered through `run_headless_ask` with the audit log enabled
- **THEN** the answer is computed by `answer_pipeline`, and one audit record is appended carrying the question, the provider, the files read, and the per-question egress delta — identical in shape to the record an app ask writes, because the same `AnswerAudit::start`/`.finish` wrapper produced it

#### Scenario: A new ask entry cannot silently skip the audit

- **WHEN** a new headless entry point (CLI or MCP) needs to answer a question
- **THEN** it obtains the answer stream from `run_headless_ask`, so it CANNOT reach `answer_pipeline` without the audit + egress + scope/provider wrapper the helper encapsulates — the helper is documented as the canonical path for every new ask entry

### Requirement: The helper honors the same provider posture as the app

The helper SHALL resolve the provider through `resolve_ask_context`, so a
`local-only` investigation swaps the config to the local (device) provider before
any transport exists, and an explicit local flag forces the same local config the
investigation swap uses. Most-restrictive wins: either a local flag OR a
`local-only` investigation forces the device path; local-only-marked scope files
stay readable to the private model. The provenance the caller reports SHALL be
read from the final chunk's engine-emitted `ChunkMeta` stamp (`origin`, `cost`),
never recomputed or model-authored.

#### Scenario: A local-only investigation forces device even without the flag

- **WHEN** `run_headless_ask` runs inside a `local-only` investigation with no explicit local flag
- **THEN** `resolve_ask_context` swaps the config to the local provider, the answer is computed on-device with zero network egress, and the final chunk's `ChunkMeta.origin` is `device`

#### Scenario: The provenance comes from the engine stamp, not the caller

- **WHEN** a headless ask completes and the caller reports where it was answered and what it cost
- **THEN** the caller reads `origin` and the token/cost meter from the final chunk's `ChunkMeta` (the same stamp the app renders), so the provenance is the engine's own account and matches the audit record's provider

### Requirement: A cache replay through the helper computes and attributes nothing new

When the helper replays a cached answer, the new-cost meter SHALL be None (0 new
tokens / $0) so the cumulative audit total never double-counts, exactly as the
app transports behave via `audit::ask_new_cost`.

#### Scenario: A replayed headless ask adds no new cost

- **WHEN** `run_headless_ask` answers a question whose answer is already cached
- **THEN** the replay streams the stored answer, the recorded new cost is 0 / $0, and the cumulative cost total is unchanged from before the replay
