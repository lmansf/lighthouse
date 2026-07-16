# context-manifest — delta

## ADDED Requirements

### Requirement: The context manifest carries metadata only, never context bytes
The final-chunk context manifest SHALL list, per context entry, only
METADATA: `{ name, kind (schema-card | query-result | retrieved-chunk |
join-hints | chart-options | conversation-note), chars, file_id?,
local_only?, score }`. It SHALL NEVER include `Ctx.text`. Copying context
bytes into the manifest would persist private text into `CachedAnswer.text`
and conversation notes — a persistence boundary that `local_only` never
authorized. The actual text SHALL stay behind the device-only file inspector.

#### Scenario: The manifest holds no context text
- **WHEN** the manifest is emitted for an answer whose contexts include a retrieved chunk of private text
- **THEN** the manifest entry carries the chunk's name, kind, char count, file_id, and score, and none of the chunk's actual text bytes

### Requirement: The manifest reflects the gated shareable set and discloses withholding
The manifest SHALL be built from the contexts assembled AFTER the
shareable-subset gate, so it is already the gated set for the ask's posture.
On a cloud ask that dropped files solely because they are local-only, the
manifest SHALL be paired with the already-emitted `local_only_skip_note`, so
the disclosure states both what WENT to the model and what was WITHHELD
because it is private.

#### Scenario: A cloud ask discloses both sent and withheld
- **WHEN** a cloud ask drops one or more local-only files and answers over the shareable subset
- **THEN** the manifest lists only the shared entries, and the skip note states how many private files were withheld

### Requirement: Retrieved chunks are attributed to their source files
Each `retrieved-chunk` manifest entry SHALL carry the `file_id` of its source
file, taken from the already-flowing `references` (`RagReference.file_id`), so
a chunk can be traced to the file it came from.

#### Scenario: A chunk entry names its file
- **WHEN** the manifest includes a retrieved-chunk entry
- **THEN** that entry carries the `file_id` of the file the chunk was retrieved from

### Requirement: The manifest persists with the cached answer
The manifest SHALL be stored on the cached answer so a replay shows the
ORIGINAL manifest, not a blank one — the same persistence the provenance
stamp and cost meter get.

#### Scenario: A replay shows the original manifest
- **WHEN** a cached answer is replayed from the answer cache
- **THEN** the manifest rendered is the one stored with the original answer, not an empty manifest
