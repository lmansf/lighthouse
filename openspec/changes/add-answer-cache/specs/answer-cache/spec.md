# answer-cache — delta

## ADDED Requirements

### Requirement: An unchanged question over unchanged data replays instantly and verbatim
When a question's cache key — normalized question, provider-effective candidate
digest (include flags, local-only marks, per-file index freshness), provider and
model id, attachment set — matches a stored successful answer, the engine SHALL
replay that answer verbatim (text, references, analytics meta, provenance
stamp) without invoking retrieval or any model, and SHALL stamp the final chunk
with the original answer's time.

#### Scenario: Instant re-ask, zero model calls
- **WHEN** the same question is re-asked with an unchanged vault, provider, and attachments
- **THEN** the stored answer replays with no model invocation and carries `cachedAt`

### Requirement: Any input change is a different key
A change to the question (beyond case/whitespace/trailing punctuation), any
included file's content or freshness, any include or local-only flag effective
for the provider, the provider or model id, or the attachment set SHALL produce
a cache miss and a live run.

#### Scenario: Touching a source file invalidates
- **WHEN** a source file is modified after an answer was cached and the question is re-asked
- **THEN** the answer runs live

#### Scenario: Switching provider invalidates
- **WHEN** the same question is re-asked under a different provider
- **THEN** the answer runs live (and is cached under the new key)

### Requirement: The cache line is honest and re-runnable
A replayed answer SHALL be visibly marked as cached with the original answer
time, and SHALL offer a re-run that bypasses the cache, runs live, and
refreshes the entry. The mark SHALL be engine-emitted metadata, never model
text.

#### Scenario: Re-run bypasses
- **WHEN** the user activates Re-run on a cached answer
- **THEN** the pipeline runs live and the entry is replaced

### Requirement: Persistence obeys the chat-history opt-in
The in-memory session cache SHALL always operate. The disk store (install-global
app-state dir, never the vault) SHALL be written only when the request carries
the client's persistence-allowed verdict; when a request carries
persistence-disallowed, the engine SHALL NOT write and SHALL delete any existing
disk cache file. No cache operation SHALL touch the network.

#### Scenario: History off keeps the cache in memory only
- **WHEN** "Save chats on this device" is off and answers are asked and re-asked
- **THEN** re-asks still hit in-session, nothing is written to disk, and any prior disk cache file is removed

### Requirement: Doubt means live
Deserialization failures, envelope-version mismatches, or entries recording
errored/incomplete answers SHALL be treated as misses; the cache SHALL never
degrade an answer relative to a cache-less run.

#### Scenario: Corrupt store self-heals
- **WHEN** the disk cache file is corrupt
- **THEN** the ask runs live as if uncached, and the store is rewritten cleanly on the next allowed insert
