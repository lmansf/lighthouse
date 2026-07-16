# investigations — delta

## ADDED Requirements

### Requirement: An investigation persists structure vault-scoped, versioned, atomically
An investigation {id, name, created, archived, scope file ids, provider
policy, conversation refs} SHALL persist in `.rag-vault/investigations.json`
as a versioned envelope written atomically (temp + fsync + rename). Pin and
note membership SHALL be derived (pins via `Pin.investigationId`; notes via
the investigation's folder under `Lighthouse Notes/`), never duplicated on
the record.

#### Scenario: Round trip
- **WHEN** an investigation "Q3 audit" is created with two scope files and policy local-only, and the store is re-read
- **THEN** the record returns byte-stable with id, name, created, empty conversation refs, both scope ids, and policy local-only

#### Scenario: Unknown envelope version never clobbers silently
- **WHEN** investigations.json carries envelope version 99 and a new investigation is created
- **THEN** the session loads empty, the unreadable file is preserved as a `.bak-<epoch>` sibling, and the new record is written in a fresh v1 envelope

### Requirement: Chat-history posture wins over conversation refs
Conversation-ref writes SHALL be accepted only when the request's
`persistAllowed` is true AND the managed policy allows history; otherwise the
write SHALL be a no-op while structure fields (name, scope, policy, archived)
persist regardless.

#### Scenario: Save-chats off keeps structure, never transcripts
- **WHEN** "Save chats on this device" is off and a conversation ref write arrives with persistAllowed=false for an investigation whose name and scope were just saved
- **THEN** the investigation persists with name and scope intact and zero conversation refs

### Requirement: An investigation's scope scopes every ask in it via the attachment machinery
An ask carrying an `investigationId` whose scope is non-empty SHALL resolve
candidate selection over exactly the scope's file ids through the existing
attachment path (bypassing the global included set); an empty scope SHALL
mean the whole vault; explicit per-ask attachments SHALL override scope
(most-specific wins). Local-only file marks SHALL keep applying within scope
per provider.

#### Scenario: Scoped ask cites only scope files
- **WHEN** an investigation is scoped to files A and B in a vault that also contains C, and an ask runs inside it with no attachments
- **THEN** retrieval candidates and citations come only from A and B

#### Scenario: Explicit attachment overrides scope
- **WHEN** the same investigation is active and the user attaches file C to one ask
- **THEN** that ask is scoped to C alone, and the next ask returns to the investigation's scope

#### Scenario: Parity of candidate sets
- **WHEN** the same fixture vault and the same scoped ask run through the Rust engine and the TS twin
- **THEN** both produce identical candidate sets

### Requirement: A local-only investigation forces the private path at the model-config chokepoint
When an ask carries a `local-only` investigation, the engine SHALL swap the
resolved model config to the local provider at the same resolution point the
managed policy layer participates in — before any cloud transport is
constructed — even when the profile's active provider is cloud. The
provenance stamp SHALL therefore report on-device truthfully.

#### Scenario: Cloud profile, local-only investigation
- **WHEN** the active provider is a (mocked) cloud vendor and an ask runs inside a local-only investigation
- **THEN** no cloud request is made, the answer takes the private path, and the final chunk's meta.origin is "device"

### Requirement: Belonging — pins, notes, and recall prefer the investigation
Pins SHALL carry an optional `investigationId` (existing pins remain
uncategorized). `exportChat` SHALL write under
`Lighthouse Notes/<investigation name>/` when an investigation is current.
Conversation-recall SHALL rank the current investigation's conversation
notes ahead of global ones while still surfacing global notes.

#### Scenario: Pin belongs to the investigation
- **WHEN** an analytics answer is pinned while an investigation is current
- **THEN** the stored pin carries that investigation's id and pre-existing pins remain uncategorized

#### Scenario: Recall prefers the investigation's notes
- **WHEN** two saved conversation notes match a recall-cued ask equally and only one belongs to the current investigation
- **THEN** the investigation's note ranks first and the global note still appears

### Requirement: Archive hides, never deletes
Archiving an investigation SHALL set a visibility flag only: the record, its
pins, notes, conversations, and scope SHALL remain on disk unchanged, and
unarchiving SHALL restore it fully.

#### Scenario: Archive is non-destructive
- **WHEN** an investigation with one pin and one exported note is archived
- **THEN** investigations.json still contains the record (archived=true), the pin and the note file are untouched, and the nav no longer lists it

### Requirement: The UI carries investigations end to end
The left nav SHALL list investigations with create, rename, and archive;
switching SHALL swap the chat conversation context, the scope pill on the
ask box, and the provider enforcement; "New chat" SHALL stay within the
current investigation; a compact header SHALL show name · scope size ·
policy badge.

#### Scenario: Switching switches context
- **WHEN** the user switches from investigation X (scoped, local-only) to investigation Y (whole vault, default)
- **THEN** the conversation list shows Y's chats, the scope pill shows Y's scope, and the local-only badge disappears

### Requirement: Answers read from the top
When an answer begins streaming in the main-window transcript, the top of
that assistant message SHALL anchor to the top of the chat viewport and hold
there while it streams; any manual scroll SHALL cancel the hold for that
answer; reduced-motion preferences SHALL yield instant jumps; reference
cards SHALL render below the answer text without displacing the anchored
start. The widget pill SHALL be unaffected.

#### Scenario: Long answer with many references starts readable
- **WHEN** an answer citing many files finishes streaming
- **THEN** the first line of the answer is visible at the top of the viewport, not scrolled past

#### Scenario: The user wins over the hold
- **WHEN** the user scrolls the transcript while an answer is still streaming
- **THEN** no further automatic scrolling occurs for that answer
