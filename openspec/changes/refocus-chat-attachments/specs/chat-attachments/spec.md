# chat-attachments — delta

## ADDED Requirements

### Requirement: A conversation's corpus is its attachments, one to ten
The engine SHALL answer only over the files attached to the conversation
(1–10 files, 25 MB each). Attaching an eleventh file SHALL be refused with
a message naming the cap; a conversation with no attachments SHALL prompt
for files instead of retrieving from any ambient corpus.

#### Scenario: The cap refuses attachment eleven
- **WHEN** a conversation has 10 attachments and another file is attached
- **THEN** the attach is refused, the existing 10 are untouched, and the message says to remove one first

#### Scenario: No ambient corpus
- **WHEN** a question is asked in a conversation with zero attachments
- **THEN** the answer is the attach-files nudge — no retrieval, no model call

### Requirement: Attach is the moment of work
On attach the engine SHALL ingest eagerly — extraction, table profile,
column catalog, chunk index — keyed by content hash, so an ask never
re-pays ingestion for unchanged bytes, in this conversation or any other.

#### Scenario: Re-attached bytes are instant
- **WHEN** a file already ingested in another conversation is attached again
- **THEN** the attachment is ready without re-running extraction or profiling

#### Scenario: An ask during ingestion waits only for what it needs
- **WHEN** a question arrives while an attachment is still ingesting
- **THEN** the answer awaits only the artifacts its branch reads, and a failed ingest degrades the answer honestly instead of failing it

### Requirement: Attachment identity is content-derived and engine-minted
Attachment ids SHALL be minted by the engine from the content hash and
name — never a filesystem path — and every provenance and freshness claim
SHALL be keyed by content hash, so "same data" is exact.

#### Scenario: Identical re-asks replay from cache across conversations
- **WHEN** the same question is asked over byte-identical attachments in a new conversation
- **THEN** the cached answer replays with its stamp; any changed byte misses
