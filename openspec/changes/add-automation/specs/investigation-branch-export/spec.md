# investigation-branch-export — delta

## ADDED Requirements

### Requirement: Fork branches a line of inquiry by copying structure only

`investigations::fork(id, new_name)` SHALL mint a FRESH investigation that copies
ONLY the parent's structure — `scope_file_ids`, `provider_policy`, and
`conversation_refs` — minting its own stable id, its own sanitized notes folder,
and its own creation time, under the same case-insensitively-unique, non-empty
name rule as `create`. Derived membership SHALL NOT be duplicated: pins (which
carry a single `investigationId`) and notes (whose membership is their folder
location) are NOT copied, because a fork is a new line seeded with the parent's
scope + conversation context, not a clone of another investigation's members. The
fork SHALL be mirrored byte-compatibly in the TS twin.

#### Scenario: A fork seeds scope, policy, and conversation refs but no members

- **WHEN** `fork("inv-parent", "Q3 deep dive")` runs against a parent with a scope, a `local-only` policy, and two conversation refs
- **THEN** a new investigation is created with a fresh id and empty notes folder, carrying a copy of the parent's `scope_file_ids`, `provider_policy` (still `local-only`), and `conversation_refs`, while the parent's pins and notes remain the parent's alone (none are re-pointed or duplicated)

#### Scenario: A fork name must be unique and non-empty

- **WHEN** `fork` is called with a blank name, or a name that collides case-insensitively with an existing investigation (archived records included)
- **THEN** the fork is refused with a human-readable reason and nothing is persisted, exactly as `create` refuses

### Requirement: Export renders an investigation to an in-vault markdown artifact

`investigations::export_markdown(id)` SHALL render an investigation's STRUCTURE and
DERIVED membership — name, created time, archive state, provider policy, scope files
(or "whole vault" when empty), conversation refs, the derived pin list, and the
derived note list — to a standalone markdown document reusing the
`briefings::render_markdown` idiom. The export SHALL be WRITTEN into the vault only
through the `exportChat` precedent — `investigations::notes_subdir(id)` (the
write-artifact allowlist, re-validated at use) plus `vault::write_artifact` — a
non-egress in-vault write, never an arbitrary path. The render SHALL be mirrored
byte-identically in the TS twin.

#### Scenario: Export writes a structure-and-membership artifact into the vault

- **WHEN** an investigation with a scope, conversation refs, pins, and notes is exported
- **THEN** a markdown document listing its structure and derived membership is written under `Lighthouse Notes/<the investigation's folder>/` via the write-artifact allowlist, and the saved artifact's id and name are returned

#### Scenario: Export of an unusable folder or unknown id is refused

- **WHEN** `export` targets an unknown investigation id, or one whose stored folder name is not a usable segment
- **THEN** `notes_subdir` returns a human-readable error, nothing is written, and no egress occurs

### Requirement: Export references conversations but never embeds transcripts

The exported markdown SHALL reference conversations by their opaque id (rendering
`title (id)` only when a caller supplies an optional id→title map), and SHALL NEVER
embed transcript text, because the engine deliberately never stores transcripts. A
conversation ref in the export is a pointer, not content.

#### Scenario: Conversation refs appear as ids, not transcripts

- **WHEN** an investigation carrying conversation refs is exported with no title map
- **THEN** each conversation is listed by its id alone, with no transcript text, so the artifact discloses which conversations belong to the investigation without reproducing any conversation content

#### Scenario: A caller-supplied title map only adds legibility

- **WHEN** the export is rendered with an id→title map that the calling client holds
- **THEN** each conversation is listed as `title (id)` for readability, still with no transcript text embedded
