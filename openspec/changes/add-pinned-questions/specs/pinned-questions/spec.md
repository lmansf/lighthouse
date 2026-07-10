# pinned-questions — delta

## ADDED Requirements

### Requirement: Analytics answers can be pinned
An analytics answer SHALL be pinnable, capturing its question, executed SQL, and file ids; pins persist across restarts in the state directory with a cap of 20 (an attempt beyond the cap SHALL explain the limit).

#### Scenario: Pin from an answer
- **WHEN** the user pins "open tickets by priority"
- **THEN** the pin appears in the pins dialog with its question and last result summary

### Requirement: Vault changes recheck pins without a model
When watched files change (after a quiet debounce), the desktop engine SHALL re-run each pin's stored SQL through the existing guard and compare a result digest; only digest changes SHALL raise an alert carrying compact before/after summaries.

#### Scenario: The number moved
- **WHEN** Tickets.xlsx changes and the pinned result differs
- **THEN** a "pins changed" event fires with the pin's before/after summary and the chat shows an alert banner

#### Scenario: Irrelevant change
- **WHEN** files change but the pinned query's result is identical
- **THEN** no alert fires

### Requirement: Clicking an alert re-asks the question
Activating a changed pin SHALL submit its original question through the normal ask path, producing a fresh narrated, cited answer.

#### Scenario: Drill-down
- **WHEN** the user clicks the changed pin banner
- **THEN** the question is asked again and the new full answer streams into the chat

### Requirement: Pins degrade visibly, never noisily
A recheck failure (missing file, schema drift, guard rejection) SHALL mark the pin stale with the engine's reason, suppress its alerts, and leave other pins unaffected; a corrupt pin store SHALL reset to empty without blocking startup.

#### Scenario: Column renamed
- **WHEN** a pinned query's column no longer exists
- **THEN** the pin shows "stale: <engine reason>" in the dialog and raises no further alerts
