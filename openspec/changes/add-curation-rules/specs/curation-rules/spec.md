# curation-rules — delta

## ADDED Requirements

### Requirement: A per-folder rule resolves matching files, present and future
A rule {scope folder, predicate: kind | extension list | glob, action: include
| exclude | local-only | clear} SHALL apply to every matching file under its
scope at resolution time, including files that arrive after the rule was
created, with no per-node writes.

#### Scenario: A future arrival gets the rule's flags
- **WHEN** a rule "spreadsheets in /reports → include" exists and a new .xlsx lands in /reports
- **THEN** the new file resolves as included on its first appearance, with no user action

### Requirement: Explicit user state always beats rules
An explicit per-node toggle SHALL win over any matching rule, and explicit
ancestor-exclusion SHALL never be overridden by a rule. A local-only rule SHALL
never remove an explicit local-only mark.

#### Scenario: A hand-excluded file stays excluded
- **WHEN** a file was explicitly hidden and an include rule matching it is added
- **THEN** the file remains excluded

#### Scenario: Rules cannot resurrect an excluded subtree
- **WHEN** a folder is explicitly excluded and a rule scoped inside it says include
- **THEN** every descendant remains excluded

### Requirement: Precedence among rules is deterministic
When multiple rules match a node, the deepest scope SHALL win; within one
scope, the last-defined rule SHALL win; a `clear` action SHALL yield the global
default and mask shallower rules. The same fixtures SHALL resolve identically
in both engines.

#### Scenario: Deeper scope wins
- **WHEN** a vault-root rule excludes images and a /design rule includes images
- **THEN** images under /design are included; images elsewhere are excluded

### Requirement: Removing a rule reverts only what the rule decided
Deleting a rule SHALL restore every node it was deciding to the next resolution
layer (other rules, then the global default) and SHALL NOT alter any explicit
per-node flag.

#### Scenario: Removal is non-surprising
- **WHEN** the include rule for /reports is deleted
- **THEN** un-toggled files in /reports revert to the default; hand-toggled files keep their state

### Requirement: Rule decisions are legible
The inspector's plain-language state SHALL say when a rule set the effective
flag, naming the rule (e.g. "included by rule 'spreadsheets in /reports'"), and
the explorer SHALL reflect rule-resolved state in its normal eye/lock marks.

#### Scenario: The inspector names the rule
- **WHEN** a file is included solely because a rule matched it
- **THEN** the inspector's status line names that rule

### Requirement: Rules are manageable from the folder and from Preferences
Folder rows SHALL offer "Rules for this folder…" (list + create for that
scope); Preferences SHALL list all rules with their scopes and allow removal.

#### Scenario: Creating a rule from the folder
- **WHEN** the user opens "Rules for this folder…" on /reports and adds "extension xlsx → include"
- **THEN** the rule appears scoped to /reports and matching files resolve immediately
