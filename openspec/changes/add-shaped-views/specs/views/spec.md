# views — delta

## ADDED Requirements

### Requirement: A view persists as a named, guarded SELECT — sources stay immutable
A view {id, name (sanitized identifier, unique case-insensitively among
views, never shadowing a file table), sql (exactly ONE read-only SELECT,
validated by the same guard as every executed query), reads (dependencies
resolved at save), provenance-labeled summary, createdMs} SHALL persist in
`.rag-vault/views.json` as a versioned envelope written atomically, with
unknown-version or corrupt files preserved as `.bak-<epochms>` siblings on
the next write. Saving, resolving, or deleting a view SHALL never write to
any source file.

#### Scenario: The guard runs at save
- **WHEN** a view is saved with a definition that is not a single read-only SELECT (e.g. an UPDATE, or two statements)
- **THEN** the save is refused with the guard's reason and nothing is persisted

#### Scenario: Round trip preserves the record and the source bytes
- **WHEN** a view over a CSV is saved and the store is re-read
- **THEN** the identical record returns (name, sql, reads, labeled summary) and the CSV's bytes are unchanged

### Requirement: Views resolve virtually at ask time and count against table slots
A view SHALL register into the ask's session context only when all its
transitive source files are registered for that ask, by executing its
stored definition against those tables (re-guarded first) and registering
the result as a virtual table — no rows are ever materialized to disk.
Each registered view SHALL consume one slot under the existing table caps,
with over-cap or failing views skipped deterministically rather than
failing the ask. Results SHALL always reflect the sources' current bytes,
and provenance SHALL keep naming the underlying files.

#### Scenario: An ask against a view returns engine numbers from current bytes
- **WHEN** a guarded SELECT names a saved view over a fixture CSV, the query runs, the CSV is then modified, and the query runs again
- **THEN** both runs return rows computed by the engine from the CSV's bytes at that moment, with no cached rows on disk between them

#### Scenario: A broken view never blocks the ask
- **WHEN** a view's source file has been deleted and an ask proceeds over other files
- **THEN** the view is simply not registered and the ask completes normally

### Requirement: View-over-view forms a DAG with a small depth cap
A view definition MAY reference other views; a definition that would
create a cycle or exceed the depth cap SHALL be rejected at save with a
reason naming the offense.

#### Scenario: Cycle refused at save
- **WHEN** view B reads view A and a new definition for a view read by A attempts to read B
- **THEN** the save is refused as a cycle and the store is unchanged

#### Scenario: Depth beyond the cap refused at save
- **WHEN** a chain of views at the depth cap exists and a definition references the deepest one
- **THEN** the save is refused with the depth reason

### Requirement: Creation shows engine-rendered evidence and persists nothing without an explicit save
Views SHALL be creatable two ways: a "Save as view" chip on any answer
carrying analytics SQL (summary recorded from the asked question and
labeled as such), and a shaping ask in which the model proposes exactly
ONE transform SELECT that the engine validates with the guard and
evidences with before/after samples (first rows of the source and of the
result, engine-rendered). Nothing SHALL persist until the user explicitly
saves, and no flow SHALL modify a source file.

#### Scenario: Shaping ask renders before/after and waits
- **WHEN** the user asks to shape a messy table and the model proposes a SELECT
- **THEN** the user sees the SQL plus engine-rendered before and after sample rows, nothing is written until Save is clicked, and the source file's bytes are identical afterward

#### Scenario: Save as view from a Beam answer
- **WHEN** the user clicks "Save as view" on an answer whose meta carries SQL and names the view
- **THEN** the view persists with that SQL, dependencies resolved at save, and a summary recorded from the asked question labeled as question-derived

### Requirement: Views are visible and inspectable wherever tables are
A saved view SHALL appear in the catalog and table cards (marked as a
view, carrying its summary), in a Library section of the navigation, and
in suggested asks; the inspector SHALL open on a view and show its
definition SQL, its provenance-labeled summary, the sources it reads, and
freshness derived from those sources' saved times.

#### Scenario: Inspector on a view
- **WHEN** the user inspects a saved view
- **THEN** they see the exact SELECT, the summary with its provenance label (question-derived or model-stated), the source files it reads, and freshness from those sources

### Requirement: Local-only marks propagate to views transitively
A view SHALL be treated as effectively local-only when any transitive
source file carries a local-only mark: excluded from cloud asks and
cloud-visible surfaces exactly like the file, and shaping over it SHALL
force the local path.

#### Scenario: A view over a marked file never reaches the cloud
- **WHEN** a source file is marked local-only and a cloud-provider ask runs
- **THEN** the view over it is not registered and not present in any prompt content, while a local ask may use it normally

### Requirement: Lifecycle protects dependents and never touches sources
Rename SHALL be refused while dependent views exist, returning the
dependent list. Delete SHALL be refused while dependents exist unless the
user explicitly confirms a cascade shown with the full transitive list;
cascade deletes views only. No lifecycle operation SHALL write to any
source file.

#### Scenario: Rename with dependents refuses with the list
- **WHEN** the user renames a view that another view reads
- **THEN** the rename is refused and the dependent view's name is reported

#### Scenario: Cascade delete is explicit and leaves sources byte-identical
- **WHEN** the user deletes a view with dependents, confirms the cascade after seeing the transitive list
- **THEN** the view and its dependents are removed from views.json, and every source file's bytes are identical to before
