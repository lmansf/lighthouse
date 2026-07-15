# conversation-recall — delta

## ADDED Requirements

### Requirement: A saved conversation is auto-exported as an indexed vault note
When "Save chats on this device" is enabled, the app SHALL export each settled
conversation to `Lighthouse Notes/Chats/` as a markdown note carrying YAML
frontmatter (date, title, provider, and the union of cited file ids) followed by
the conversation transcript. The export SHALL be idempotent per conversation: a
single current note is kept and overwritten in place on each turn, never
accreting collision-suffixed duplicates, and a note left under a previous title
SHALL be removed when the title changes. The note SHALL be an ordinary vault
file — walked, indexed, and retrievable exactly like any other document.

#### Scenario: A settled conversation becomes a note
- **WHEN** history saving is on and a conversation produces a real assistant answer
- **THEN** a markdown note for that conversation appears under `Lighthouse Notes/Chats/` and updates in place as the conversation continues

#### Scenario: One current note per conversation
- **WHEN** the same conversation settles a second turn
- **THEN** its single note is overwritten with the fuller transcript, with no second suffixed copy

#### Scenario: Renaming the chat does not orphan the old note
- **WHEN** a conversation's title changes and it is exported again
- **THEN** the prior-title note is removed and exactly one current note remains

### Requirement: Retrieved conversation chunks carry a conversation source kind
Every retrieved reference SHALL carry a source kind that is `conversation` for a
node under `Lighthouse Notes/Chats/` and `file` otherwise, determined
deterministically from the node's vault-relative path. The classification SHALL
be exact — a sibling path that merely shares the prefix without the trailing
`Chats/` segment is a `file`. In synthesis, a conversation-kind context SHALL be
labeled to the model as the user's own past conversation rather than a source
document. In the UI, a conversation-kind reference SHALL render with a chat glyph
(not a document glyph) and open the note. A reference with no kind SHALL be
treated as a file.

#### Scenario: A cited past chat shows a chat glyph
- **WHEN** an answer cites a note under `Lighthouse Notes/Chats/`
- **THEN** that reference renders with a chat glyph and opening it opens the note

#### Scenario: The model is told a block is a past conversation
- **WHEN** a retrieved context is a conversation note
- **THEN** the block the model reads is labeled "from your past Lighthouse conversation", not the raw file name

#### Scenario: Classification is path-exact
- **WHEN** a node id is `Lighthouse Notes/Chatsz/x.md` (no trailing `Chats/` segment)
- **THEN** its kind is `file`, not `conversation`

### Requirement: A recall cue biases retrieval toward past conversations without short-circuiting
The engine SHALL detect a recall meta-cue — an anchored self-referential question
about what the user previously asked, said, concluded, decided, or found — and
when present SHALL scale conversation-kind candidates by a constant boost before
ranking, so past-conversation notes are lifted into the retrieved set. The cue
SHALL be a pure function of the question, anchored to specific frames so ordinary
questions never trigger, and byte-identical between the two engines. Unlike the
model-free meta cues, the recall cue SHALL NOT short-circuit to a canned answer —
full grounded synthesis still runs. The bias SHALL only scale existing
candidates; it SHALL never fabricate a candidate or ask the model to rank.

#### Scenario: A recall question surfaces past chats
- **WHEN** the user asks "what did I conclude about churn last month?"
- **THEN** conversation-kind candidates are boosted into the top-k and synthesis draws on them, with the answer still produced by normal grounded synthesis

#### Scenario: An ordinary question is unaffected
- **WHEN** the user asks "what is our churn rate?"
- **THEN** no conversation boost is applied and retrieval ranks as before

### Requirement: Conversation export is fail-closed and reversible
No conversation note SHALL be written while history saving is off or is locked
off by managed policy — the export SHALL share the single persistence gate, so
zero notes exist when saving is disabled. Export failures SHALL be swallowed and
never block or error the chat. Turning history saving off SHALL purge the
auto-exported notes, removing the `Chats/` folder so none of the user's
conversations remain on disk.

#### Scenario: History off writes nothing
- **WHEN** "Save chats on this device" is off (or managed-locked off)
- **THEN** no conversation note is ever written

#### Scenario: Opting out purges existing notes
- **WHEN** the user turns "Save chats on this device" off
- **THEN** the auto-exported `Chats/` notes are deleted

#### Scenario: An export failure is silent
- **WHEN** writing a conversation note fails (e.g. a read-only vault)
- **THEN** the chat continues normally and no error is surfaced to the user
