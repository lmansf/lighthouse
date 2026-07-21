# add-report-templates — tasks

## 1. Engine (reports.rs)

- [x] 1.1 `ReportTemplate` enum (`Standard`/`ScientificMethod`/`BusinessReport`,
  `Default = Standard`) + `from_wire` + `title_suffix`.
- [x] 1.2 `Report` gains `template`, `intro`, `discussion`; `assemble` defaults
  them (`Standard`/`None`/`None`).
- [x] 1.3 Split `render_markdown` into a dispatcher + `render_standard`
  (byte-identical) over shared `report_header`/`push_section`/`render_caveats`
  helpers (sql-gated Query-used block).
- [x] 1.4 `render_imrad` (Introduction/Methods/Results `###`/Discussion) and
  `render_bluf` (Bottom line/Key findings/Supporting analysis `###`/What this
  means), with deterministic framing fallbacks.
- [x] 1.5 `investigate_templated` + `report_findings_ctx` + `narrate`
  (stream-collect over `llm::stream_answer`, `None` on empty/over-long) + four
  narration prompt constants + `NARRATION_CHAR_CAP`.

## 2. Dispatch (commands.rs ↔ routes.rs, identical arms)

- [x] 2.1 Read `body["template"]` → `ReportTemplate::from_wire`.
- [x] 2.2 Build the model config once; derive `is_cloud` from it; call
  `investigate_templated` (Standard path byte-identical).

## 3. Contract + UI

- [x] 3.1 `ReportTemplate = "imrad" | "bluf"` type; `RagService.investigate`
  grows an optional `template`.
- [x] 3.2 Real posts `template`; mock mirrors the engine's title suffix.
- [x] 3.3 `CapabilityNav` Investigate becomes a menu: Standard report /
  Scientific method / Business report.

## 4. Tests

- [x] 4.1 `reports_test.rs`: IMRaD structure, BLUF structure, and a
  Standard-byte-identity test — all zero-network (empty `ModelCfg`).
- [x] 4.2 `capabilityNavUi.test.mjs`: the three-shape menu + wire tags + the
  mock's suffixed note names.

## 5. Release

- [x] 5.1 Seven-stamp version bump (0.13.6 → 0.13.7).
- [x] 5.2 Gates: cargo test (lighthouse-core), node tests, tsc/lint (CI),
  desktop byte-identical grep-check.
