# report-templates — delta

## ADDED Requirements

### Requirement: Templates reshape the SAME verified sections, adding no figure
A report template SHALL reorganize the deterministic `investigate` report's
engine-verified sections into a prescribed structure and add only connective
FRAMING prose; it SHALL introduce no figure the engine did not compute. Every
number in a templated report SHALL trace to a `run_query` cell, exactly as in
the Standard report.

#### Scenario: A template adds structure, never a number
- **WHEN** the same table is investigated as a Standard report and as a template
- **THEN** the set of engine figures (section results and summary headlines) is identical, and the template only adds framing prose around them

#### Scenario: Narration cannot supply a figure
- **WHEN** a template's framing blocks are narrated by a configured model
- **THEN** every figure in the document still traces to a section's query result, and removing every narrated block changes no number

### Requirement: The Standard report is byte-identical to before templates
Rendering a report with the Standard shape SHALL produce output byte-identical
to the pre-templates render. The render split SHALL NOT change the Standard
document's bytes for any report.

#### Scenario: Standard render is unchanged
- **WHEN** a report assembled from a fixed table is rendered as Standard
- **THEN** the bytes match the pre-templates render exactly — the same title, Summary, section headings at `##`, Query-used blocks, and Caveats

#### Scenario: The templated Standard path equals the plain path
- **WHEN** `investigate_templated` is called with the Standard shape and the plain `investigate` is called on the same table with the generation time pinned equal
- **THEN** the two rendered documents are byte-identical

### Requirement: Two built-in shapes — Scientific method (IMRaD) and Business report (BLUF)
The engine SHALL offer a ScientificMethod template rendering
Introduction / Methods / Results / Discussion, and a BusinessReport template
rendering a bottom-line-up-front summary followed by supporting detail in
Minto-pyramid order. The verified analyses SHALL appear as the Results (IMRaD)
or Supporting analysis (BLUF) sections, nested one heading level below the
template's top sections.

#### Scenario: IMRaD skeleton in order
- **WHEN** a table is investigated with the Scientific method template
- **THEN** the document renders Introduction, then Methods, then Results (the verified sections nested beneath it), then Discussion, in that order, with the title marked as the Scientific method report

#### Scenario: BLUF leads with the bottom line
- **WHEN** a table is investigated with the Business report template
- **THEN** the document leads with a Bottom line section, then presents the verified analyses as Supporting analysis, with the title marked as the Business report

### Requirement: A template renders fully with no model configured
A template SHALL render completely when no narration model is available: a
deterministic framing line SHALL stand in for each narrated block, and a
narration that returns empty or over-long SHALL be discarded for that
deterministic fallback. A report SHALL never fail or block on a model.

#### Scenario: No provider still yields a complete templated report
- **WHEN** a template is rendered with no provider configured
- **THEN** the framing blocks show deterministic stand-in prose, the verified sections and caveats render in full, and no model was called

### Requirement: The template selector is unknown-tolerant and Rust-only
The `investigate` op SHALL accept an optional template tag and default to the
Standard report for an absent or unrecognized value. Template execution SHALL
be Rust-only; the TypeScript twin's `investigate` op SHALL remain
`{available:false}`, with the client contract threading the tag for the Rust
engine.

#### Scenario: An unknown tag is the Standard report
- **WHEN** the investigate op receives a template tag it does not recognize
- **THEN** it renders the Standard deterministic report rather than erroring

#### Scenario: The twin does not execute templates
- **WHEN** the investigate op runs under the TypeScript dev twin
- **THEN** it answers `{available:false}` as before, unchanged by the template argument
