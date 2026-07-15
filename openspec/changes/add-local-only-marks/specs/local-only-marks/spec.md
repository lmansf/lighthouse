# local-only-marks — delta

## ADDED Requirements

### Requirement: A node can be marked local-only, persisted and ancestor-wins
The vault SHALL support a per-node `localOnly` flag distinct from inclusion,
persisted in `state.json` alongside `included` and readable from old state files
as unset. A node SHALL be *effectively* local-only when it OR any ancestor
carries an explicit local-only mark. Marking SHALL be migration-safe with no
loss of existing inclusion state.

#### Scenario: Marking a folder privatizes its subtree
- **WHEN** a folder is marked local-only
- **THEN** every file beneath it is effectively local-only, even those with no explicit mark of their own

#### Scenario: Old state files load cleanly
- **WHEN** a `state.json` written before this change (no `localOnly` key) is loaded
- **THEN** no node is local-only and all existing inclusion is preserved

### Requirement: With a cloud provider active, local-only content is withheld
When the active provider is a cloud vendor, the engine SHALL exclude
effectively-local-only nodes from every context a provider could receive:
retrieval candidates, explicitly attached files, doc-focus/named-file text,
Beam analytics table registration (schema cards and sample rows), the column
catalog, and catalog/metadata answers. A local-only node's file content and
column names SHALL NOT appear in the outbound prompt.

#### Scenario: A marked file never reaches the cloud prompt
- **WHEN** a file is marked local-only, a cloud provider is selected, and the user asks a question its content would match
- **THEN** none of that file's text or column names appears in the request sent to the vendor

#### Scenario: Attachments and doc-focus are filtered too
- **WHEN** the user attaches a local-only file (or names it for a whole-document answer) while a cloud provider is active
- **THEN** the attachment/doc-focus is dropped from the prompt, not silently sent

#### Scenario: Analytics does not register a private table
- **WHEN** a tabular file is marked local-only and a cloud provider is active
- **THEN** its columns and sample rows are not registered into the analytics context and do not appear in any schema card

### Requirement: On-device answers are unaffected by local-only marks
When the active provider is the on-device model or the extractive fallback, the
engine SHALL treat local-only marks as inert: effectively-local-only nodes
participate in retrieval, attachments, analytics, and meta answers exactly as
they would without the mark.

#### Scenario: The private model still reads private files
- **WHEN** files are marked local-only and the on-device (private) model is selected
- **THEN** those files participate in the answer normally, with no exclusion and no skip note

### Requirement: Exclusions are disclosed honestly in the answer
When a cloud answer omits one or more files solely because they are local-only,
the engine SHALL append a plain-language note stating how many files were
skipped and that switching to the private model would include them. The note
SHALL be engine-emitted, not model-generated.

#### Scenario: The answer says what it left out
- **WHEN** a cloud answer would have used two local-only files had they been shareable
- **THEN** the answer includes a note that two files were skipped because they are marked private, and that the private model would include them

### Requirement: Both engines resolve the same shareable candidate set
For the retrieval path exercised by both engines, the Rust engine and the TS
twin SHALL compute identical candidate file sets from the same vault state and
the same cloud provider selection, so local-only enforcement cannot drift
between them.

#### Scenario: Parity under a cloud provider
- **WHEN** the same fixture vault with the same local-only marks is queried under a cloud provider in each engine
- **THEN** the retrieval candidate file ids are identical across the two engines

### Requirement: The explorer exposes a lock control distinct from visibility
The file explorer SHALL provide a local-only ("lock") toggle that is visually
distinct from the visibility (eye) toggle, available on individual rows and in
selection/multiselect mode, and reflecting effective local-only state.

#### Scenario: Locking a file in the explorer
- **WHEN** the user activates the lock control on a row
- **THEN** that node becomes local-only and the control reflects the marked state, independently of its visibility state
