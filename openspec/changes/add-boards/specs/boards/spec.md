# boards — delta

## ADDED Requirements

### Requirement: A board persists as ordered pin references, vault-scoped and versioned
A board {id, name, investigationId | global, ordered card refs of
{pinId, size S | M | L}} SHALL persist in `.rag-vault/boards.json` as a
versioned envelope written atomically, with unknown-version or corrupt
files preserved as `.bak-<epochms>` siblings on the next write. One
default board per investigation and a global "My board" SHALL materialize
lazily on first view. Removing a card SHALL never delete or modify the
referenced pin.

#### Scenario: Round trip with order and sizes
- **WHEN** a board gains three cards sized S, M, L, is reordered, and the store is re-read
- **THEN** the board returns with the exact order and sizes preserved

#### Scenario: Card removal never touches the pin
- **WHEN** a card is removed from a board
- **THEN** the pin still exists in pins.json with its stored digest and summary intact

### Requirement: Cards show engine results only — the model is never consulted to refresh
A card SHALL render its pin's latest deterministic result: on the desktop
engine a refresh re-runs the pin's stored SQL through the same guarded
`run_direct` path as pins (chartable results render the chart card; a
single value renders a stat tile with a delta against the previous
summary; tabular results render compact top rows). Refreshing a card
SHALL make zero model calls. The dev twin SHALL return stored pin state
(summary, digest, checked time) marked not-live instead of executing SQL
(PARITY: analytics is Rust-only).

#### Scenario: Watcher update with zero model calls
- **WHEN** a fixture CSV behind a pinned question changes and the watcher recheck runs with a mocked provider observing all model traffic
- **THEN** the board card shows the new result and a diff badge, and the mocked provider records zero calls

#### Scenario: Twin renders last-known state honestly
- **WHEN** the same board is opened on the TS twin
- **THEN** cards render the stored summary with its checked time, marked as stored rather than live, and offer Ask again through the normal ask path

### Requirement: Freshness and change are visible per card
Every card SHALL carry a freshness line (engine footer on live refresh;
"checked …" from stored state otherwise) and SHALL show a diff badge when
the last watcher recheck changed the pin's digest, keyed on the existing
`pins-changed` event payload, cleared when the user views the board.

#### Scenario: Diff badge from the existing recheck
- **WHEN** the watcher recheck reports a changed pin that appears on a board
- **THEN** that card shows a change badge with the before → after summary available, and no new scheduler or event channel exists

### Requirement: Drill-in is the normal ask
Clicking a card SHALL ask the pin's question through the ordinary ask
path — narrated answer, answer cache, provenance stamp all unchanged.

#### Scenario: Drill-in narrates
- **WHEN** the user clicks a card
- **THEN** the chat asks that pin's question and streams a full narrated answer with citations and stamp

### Requirement: Layout is a responsive grid with three sizes, reordered accessibly
The board SHALL lay cards out on a responsive grid with sizes S, M, and L
and support reordering keyboard-first (move controls), with pointer drag
as enhancement only. Free-form placement SHALL NOT exist.

#### Scenario: Keyboard reorder
- **WHEN** the user activates "Move up" on the third card
- **THEN** it becomes the second card, the order persists, and no pointer was required

### Requirement: Export composes one self-contained file through the artifacts machinery
"Export board" SHALL write a single evidence-pack-style HTML — title,
cards as tables and inline-SVG charts, freshness stamps, and a SQL
appendix listing every card's query and engine footer — through the
existing `exportChat` artifact path into `Lighthouse Results`, with no
network access.

#### Scenario: Export produces the file
- **WHEN** the user exports a board with a chart card and a table card
- **THEN** one HTML file lands in Lighthouse Results containing both cards, their freshness stamps, and the SQL appendix, and it renders offline
