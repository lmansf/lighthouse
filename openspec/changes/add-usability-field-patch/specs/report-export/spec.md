# report-export — delta

## ADDED Requirements

### Requirement: Report-shaped documents export to self-contained HTML

Every report-shaped document — deep-analysis reports, briefings, evidence packs,
board exports, and Lighthouse Notes/transcripts — SHALL offer an Export menu whose
HTML option produces a single self-contained document: inline styles, tabular
numerals, any charts baked to inline SVG, the light or dark palette chosen at
export, and ZERO external references (no remote scripts, styles, fonts, or
images). The file name SHALL be sanitized and the write SHALL stay local.

#### Scenario: Exported HTML has no external references

- **WHEN** a report is exported to HTML
- **THEN** the produced HTML contains no `http`/`https`/protocol-relative
  references (verified by grep), renders its charts from inline SVG, and opens
  standalone with no network access

#### Scenario: The chosen palette is baked in

- **WHEN** the user exports in light (or dark)
- **THEN** the HTML carries that palette inline, independent of the viewer's OS
  theme

### Requirement: Reports export to markdown and offer a PDF path

The Export menu SHALL also offer raw markdown (copy or save via the existing
in-vault write allowlist) and a PDF path. Because the desktop runtime's direct
print-to-PDF availability must be confirmed on the built app, v1 SHALL ship the
system-print / "Save as PDF" path over the exported HTML and SHALL state honestly
in the release which PDF path shipped. All export writes SHALL stay on the machine.

#### Scenario: Markdown export round-trips

- **WHEN** the user exports a report as markdown
- **THEN** the markdown is the report's own rendered source, saved into the vault
  (or copied), and re-reading it reproduces the report content

#### Scenario: The PDF path is honest about what shipped

- **WHEN** the user chooses PDF
- **THEN** the shipped path (system print over the self-contained HTML in v1) is
  offered, and the release notes state which PDF path shipped rather than implying
  a direct API that was not confirmed

### Requirement: Export adds no egress and no new writable location

Export SHALL reuse the existing in-vault write allowlist (`write_artifact` /
`exportChat` subdirs) or a local browser download; it SHALL NOT introduce a new
network destination or a write outside the vault allowlist, and SHALL sanitize
every file name.

#### Scenario: Export writes only to the allowlisted local locations

- **WHEN** any report is exported
- **THEN** the write lands under the existing allowlisted vault subdirs (or a
  local download), no egress occurs, and the file name is sanitized
