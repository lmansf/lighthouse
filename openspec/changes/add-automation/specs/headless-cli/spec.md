# headless-cli — delta

## ADDED Requirements

### Requirement: The `lighthouse` CLI answers a question headlessly and prints provenance

The engine SHALL ship a `lighthouse` binary (a non-Tauri workspace crate) whose
`ask "<question>"` subcommand answers through `ask::run_headless_ask` — the first
ask path that calls the engine directly, with no webview and no loopback HTTP —
streaming the answer to stdout and ALWAYS emitting a provenance line derived from
the final chunk's `ChunkMeta`: where the answer was computed (`origin` — `device`
or the provider id), the provider-reported token/dollar meter (or "not reported"
for a silent provider, `$0.00` for device), and the egress verdict. The provenance
SHALL be present whether output is human-readable or JSON.

#### Scenario: An ask streams an answer and a provenance line

- **WHEN** `lighthouse ask "what is the Q3 revenue target?"` is run against a vault containing the answer
- **THEN** the answer text is written to stdout and, after it, a provenance line naming the origin (device or provider), the token/cost meter, and the egress verdict — read from the engine's `ChunkMeta` stamp, never model text

#### Scenario: JSON output carries the answer and the provenance together

- **WHEN** `lighthouse ask "…" --json` is run
- **THEN** a single JSON object is emitted carrying `answer`, a `provenance` object (origin, token counts, reported flag, dollar estimate, source-file count), `references`, and `analytics` when the answer is analytical — so a script consumes the answer and its provenance as one structured result

### Requirement: The CLI honors local-only posture and never bumps a version

`--local` SHALL force the local (device) provider — zero network — using the same
local config a `local-only` investigation swaps to; a scope or investigation marked
local-only SHALL force the device path automatically via `resolve_ask_context`, with
no flag required. Every `ask` SHALL be written to the audit ledger through the shared
helper. The CLI SHALL introduce no persisted setting and SHALL NOT move the version
stamps or `CACHE_VERSION` — it calls the existing answer pipeline unchanged.

#### Scenario: `--local` forces a zero-network answer

- **WHEN** `lighthouse ask "…" --local` is run
- **THEN** the answer is computed on-device with no network egress, the provenance shows origin `device` and `$0.00`, and the audit record's provider is the local/none provider

#### Scenario: A local-only investigation forces device without the flag

- **WHEN** `lighthouse ask "…" --investigation <id>` names a `local-only` investigation and no `--local` flag is passed
- **THEN** `resolve_ask_context` forces the device provider, and the ask egresses nothing — the engine, not the flag, enforces the posture

### Requirement: The CLI exposes vault selection, scope, and branch/export subcommands

`--vault <path>` SHALL point the engine at a vault directory before its first read;
`--investigation <id>` and `--include <file-id>` SHALL pass through to the helper as
the investigation context and explicit attachments. The CLI SHALL provide `fork
<id> --name "<new name>"` and `export <id>` subcommands that drive the corresponding
engine functions, with a non-zero exit code on engine failure so the CLI is scriptable.

#### Scenario: Fork and export are scriptable subcommands

- **WHEN** `lighthouse fork <id> --name "Q3 deep dive"` then `lighthouse export <id>` are run
- **THEN** the first mints a branched investigation and the second writes the investigation's markdown artifact into the vault, each exiting 0 on success and non-zero (with a human-readable message) on failure

#### Scenario: A failed ask exits non-zero

- **WHEN** `lighthouse ask "…"` cannot produce an answer (no answer settles, or the engine reports a failure)
- **THEN** the process exits with a non-zero status, so a calling script can detect the failure rather than treating empty output as success
