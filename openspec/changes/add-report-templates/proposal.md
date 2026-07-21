# add-report-templates

## Why

"Investigate {table}" already produces a rigorous, deterministic document —
a Summary of engine-verified findings, one section per analysis with its
exact SQL, and honest caveats. But the SHAPE it lands in is the same every
time, and the two audiences an analyst most often writes for expect a
familiar structure the raw report doesn't match: a **scientist** expects
IMRaD (Introduction / Methods / Results / Discussion); a **decision-maker**
expects BLUF — the bottom line first, then supporting detail in Minto-pyramid
order. Today the analyst reshapes the report by hand.

Report templates make those two shapes one click. The deterministic engine
still computes EVERY number — the templates only reorganize the same verified
sections and add connective FRAMING prose (an Introduction, a Discussion, a
bottom line) that the configured model narrates over the findings as ground
truth. No template introduces a figure the engine didn't compute, and with no
model configured a deterministic framing line stands in — so a templated
report is never blocked on, or falsified by, a model.

## What Changes

- **`ReportTemplate`.** A three-valued shape selector — `Standard` (today's
  document, byte-identical), `ScientificMethod` (IMRaD), `BusinessReport`
  (BLUF + Minto) — parsed from an optional `template` wire tag
  (`"imrad"`/`"scientific"` → scientific; `"bluf"`/`"business"` → business;
  absent/unknown → Standard, the safe default).
- **`investigate_templated`.** Runs the UNCHANGED deterministic `investigate`
  battery, then, for a template, renders the SAME sections in the template's
  skeleton. The framing blocks (IMRaD Introduction/Discussion; BLUF bottom
  line / "What this means") are narrated by the configured model over a
  ground-truth context built from the verified findings — and ONLY when a
  provider is configured; otherwise a deterministic framing line is used. A
  narration that comes back empty or over-long is discarded for the
  deterministic fallback. Standard returns the report unchanged.
- **Render split, byte-stable.** `render_markdown` dispatches on the template.
  `render_standard` is byte-identical to the pre-templates render (the
  `reports_test.rs` byte-stability contract still holds); `render_imrad` and
  `render_bluf` reuse the same section/caveat helpers, nesting the verified
  sections at `###` under Results / Supporting analysis.
- **Threaded end to end.** The `investigate` op (commands.rs ↔ routes.rs,
  identical arms) reads the optional `template`, builds the model config once,
  and calls `investigate_templated`. The client contract's `investigate`
  grows an optional `template` argument; the CapabilityNav "Investigate"
  affordance becomes a menu offering Standard report / Scientific method /
  Business report.

## Capabilities

### New Capabilities

- `report-templates`: the structured-report shapes (Standard / IMRaD / BLUF),
  their deterministic render, and the model-narrated FRAMING over
  engine-verified findings (with a deterministic fallback), threaded through
  the investigate op, contract, and capability surface.

## Non-goals

- **No new figures, ever.** A template reorganizes the SAME engine-verified
  sections and adds only framing prose; every number still traces to a
  `run_query` cell. The model narrates structure, never a figure — the
  grounded SYSTEM_PROMPT already forbids inventing one.
- **Standard is untouched.** The default report is byte-identical to before;
  the render split preserves it exactly (proven by the byte-stability test).
- **No model dependency.** A template renders fully with no provider
  configured — deterministic framing lines stand in for the narrated blocks,
  so a report never fails or waits on a model.
- **Rust-only, like the whole report engine.** The TS twin's `investigate`
  op stays `{available:false}`; the client contract threads the tag for the
  desktop/server Rust engine (the analytics-branch precedent).
- **No user-authored templates v1.** Two built-in shapes; the `ReportTemplate`
  enum is the extension seam, not a creation UI.

## Impact

- Engine: `native/crates/lighthouse-core/src/reports.rs` — `ReportTemplate`
  enum + `from_wire`; three new `Report` fields (`template`, `intro`,
  `discussion`); `render_markdown` split into a dispatcher +
  `render_standard`/`render_imrad`/`render_bluf` over shared `report_header`/
  `push_section`/`render_caveats` helpers; `investigate_templated` +
  `report_findings_ctx` + `narrate` (stream-collect over `llm::stream_answer`,
  no UI sink); four Rust-side narration prompt constants. `reports_test.rs`
  gains IMRaD/BLUF structure tests + a Standard byte-identity test, all
  zero-network (no provider).
- Dispatch: the `investigate` arm in `lighthouse-desktop/src/commands.rs` and
  `lighthouse-server/src/routes.rs` (identical) reads `template`, builds the
  model config once, calls `investigate_templated`.
- Contracts/UI: `RagService.investigate` grows an optional `template`
  (`ReportTemplate = "imrad" | "bluf"`); real posts it, mock mirrors the
  engine's title suffix; `CapabilityNav.tsx` Investigate becomes a
  three-item menu. `capabilityNavUi.test.mjs` covers the menu + tags.
- `docs/data-flows.md` MUST NOT grow: templated narration rides the
  already-configured provider exactly like an ask; the core report is still
  planned and computed model-free with no new egress.
