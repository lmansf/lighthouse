# add-report-templates — design

## Context

`reports::investigate` already produces a deterministic `Report` — a pure
model (`SubAnalysis`/`ReportSection`/`Report` + `assemble` + `render_markdown`)
fed by an impure engine that runs the `recipes::BUILTINS` battery through the
model-free `analytics::run_query`. Every figure is a `run_query` cell; the
render is byte-stable and pinned by `reports_test.rs`. Templates must NOT
weaken any of that — they add SHAPE and FRAMING, never a number.

## The shape selector

`ReportTemplate` is a `Copy` enum with a `Default` of `Standard`, parsed from
the wire by `from_wire(Option<&str>)`:
- `"imrad"` / `"scientific"` → `ScientificMethod`
- `"bluf"` / `"business"` → `BusinessReport`
- anything else (incl. `None`) → `Standard`

Unknown-tolerant parsing keeps a stale client, or a typo, on the safe
deterministic default rather than erroring.

## Byte-stable render split

`render_markdown` becomes a dispatcher over `report.template`. The Standard
arm (`render_standard`) is the OLD body verbatim, refactored onto three shared
helpers so the templates reuse them without copy-paste:
- `report_header` — the `# {title}` + `_Generated … _` stamp (identical bytes).
- `push_section(out, section, level)` — one analysis at `##` (Standard) or
  `###` (nested under a template's Results). It gates the "Query used" block on
  a non-empty `sql`, so a narrated framing block (empty sql) omits it; a real
  engine section (always non-empty sql) renders identically to before.
- `render_caveats(out, caveats, level)` — the `## Caveats` block.

Because a Standard section always carries a real SQL string, the sql-gate is
always taken for Standard — so `render_standard` is byte-identical to the
pre-split render. `reports_test.rs` proves it two ways: the existing
byte-stability tests, plus a new `templated_standard_is_byte_identical_to_
investigate` test.

## Framing narration, fallback-first

`investigate_templated` runs the UNCHANGED `investigate`, returns it as-is for
`Standard`, and otherwise:
1. stamps `report.template` and appends `template.title_suffix()` to the title;
2. if the report has sections AND a provider is configured, narrates the two
   framing blocks with `narrate(prompt, ctx, cfg)` — a stream-collect over
   `llm::stream_answer` with the verified findings as the ONLY context
   (`report_findings_ctx`: the summary headlines + each section's result
   table, as one ground-truth block). The grounded SYSTEM_PROMPT forbids any
   figure not present there.

`narrate` returns `None` for an empty OR over-long (`> NARRATION_CHAR_CAP`)
result, so a runaway/error response falls back to deterministic framing. The
renderers (`render_imrad`/`render_bluf`) use `report.intro`/`report.discussion`
when present and a fixed deterministic line otherwise — so with no provider,
or a discarded narration, the template still renders in full.

## Why this is safe

- No number is ever narrated: the framing prompts ask for prose only and the
  grounding context is the engine's own findings; removing every narrated
  block changes no figure.
- No new egress path: narration rides the already-configured provider exactly
  like an ask (the core report is still computed model-free on-device).
- Rust-only: analytics/reports never run in the twin; the client contract just
  threads the tag for the Rust engine, and the twin's `investigate` op stays
  `{available:false}`.
