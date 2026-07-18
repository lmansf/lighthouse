# chat-attachments — delta

## ADDED Requirements

### Requirement: An @-mention picker attaches a file by name

Typing `@` in the ask composer SHALL open an inline fuzzy file picker ranked by
the same matcher quick-open uses (`quickOpenMatches`), and selecting a result
SHALL insert that file as a removable attachment pill and strip the `@fragment`
token from the question text. Multiple `@`-mentions per ask SHALL be supported.
Both regular vault files and linked (external-path) files SHALL be matchable.
Attachment scoping SHALL be unchanged — a pill scopes the question exactly as an
attachment does today.

#### Scenario: Mentioning a file by fragment attaches it

- **WHEN** the user types `@` followed by a fragment of a file name in the ask box
- **THEN** an inline picker shows the fuzzy-ranked matches, and choosing one adds
  a removable attachment pill for that file, removes the `@fragment` text from the
  question, and the subsequent answer is scoped to (and cites) that file

#### Scenario: A linked file is mentionable

- **WHEN** the user `@`-mentions a file that was added by reference (a linked /
  external node)
- **THEN** it matches and attaches exactly like a copied-in vault file (matched on
  being a file node, not on its linked flag)

#### Scenario: Multiple mentions in one ask

- **WHEN** the user `@`-mentions two different files in the same question
- **THEN** both become attachment pills and both scope the question, each
  independently removable

### Requirement: The @-mention affordance does not alter existing attach paths

The `@`-mention picker SHALL reuse the existing attachment state and pill UI, and
SHALL NOT change the button-triggered attach picker, the drag-to-attach behavior,
or the OS-file-drop link-first behavior. Where the widget's ask row does not share
the composer, the `@`-mention SHALL be recorded as a follow-on rather than
silently absent.

#### Scenario: Existing attach + drop behavior is preserved

- **WHEN** the `@`-mention picker ships
- **THEN** the existing "attach" button picker, the internal explorer→chat drag,
  and the OS-file-drop (which links first, uploads only when there is no path) all
  behave exactly as before

#### Scenario: The widget limitation is disclosed, not hidden

- **WHEN** the `@`-mention is added to the main composer
- **THEN** because the widget ask row is a separate input with no attachment
  plumbing, the widget's lack of `@`-mention is recorded as a known follow-on (not
  presented as working)
