# Design — add-answer-artifacts

## Context

`analyticsSql` (added by `add-analytics-refinement`) already re-executes an answer's SQL deterministically. The vault has write operations (newFolder/rename/move) and a reveal command; the watcher ingests new files automatically and default-inclusion rules decide AI visibility. Charts render client-side as SVG from engine-built specs.

## Goals / Non-Goals

**Goals:**
- Saved artifacts are ordinary vault files: visible in the explorer, watched, inclusion-ruled, immediately usable as inputs.
- Full-fidelity CSV (not the 200-row narration cap) without letting a runaway query fill the disk.
- Zero server round-trip for chart images.

**Non-Goals:**
- XLSX/Parquet output; templated report generation; scheduled exports.
- Editing exported notes inside Lighthouse (they're plain files; the OS editor is fine).
- Saving non-analytics answers as CSV.

## Decisions

1. **Save re-executes with its own cap.** `saveAs` runs the same guarded SQL with `SAVE_MAX_ROWS = 100_000` (separate from the narration caps) and streams rows to CSV via a plain RFC-4180 writer (quote-doubling; no dependency). Rationale: the displayed result is narration-capped; analysts saving data want all of it, bounded sanely.
2. **Artifacts land in named vault folders.** `Lighthouse Results/<name>.csv` and `Lighthouse Notes/<title>.md`; helper `vault::write_artifact(dir, name, ext, bytes)` sanitizes names (same rules as rename), creates the folder, and suffixes ` (2)`, ` (3)` on collision — never overwrites. Files inherit default-inclusion behavior like any new file (a saved result the user queries next is the point).
3. **Chart PNG is client-side SVG rasterization.** Serialize the rendered SVG, draw to a canvas at 2× for crispness, paint the theme background first (dark-mode charts must not export transparent-on-dark), `toBlob("image/png")`, anchor-download. Works in WebView2/WKWebView (canvas + blob URLs are supported); no engine involvement.
4. **Chat export is client-assembled, engine-written.** The client owns the transcript (including which messages are visible after edits), so it renders the markdown — question/answer pairs, reference lists, analytics footers — and posts `{ title, markdown }` to `exportChat`, which writes the note and returns the file id; the UI then calls the existing reveal op. Alternative — engine-side transcript from chat history — rejected: history persistence is opt-in and expires.

**Parity:** `exportChat` is implemented in BOTH engines (both can write files into the vault); `saveAs` follows `analyticsSql`'s PARITY (desktop-only). KEEP IN SYNC on the name-sanitization helper.

**Degradation:** save/export failures return `{ error }` and surface as a toast — the answer in chat is untouched. Unwritable vault (read-only dir) reads as a clear error, not a crash. No model involvement anywhere, so the 6144-token window is irrelevant.

## Risks / Trade-offs

- [Saved results pile up] → they're ordinary files in one folder — visible, sortable, deletable with existing tools; no hidden store to manage.
- [Saved CSV immediately re-included changes analytics candidates] → that's the feature (results compound); the `Lighthouse Results/` name makes provenance obvious, and union grouping won't merge them with source families (different stem).
- [SVG → canvas taint] → chart SVG contains no external references (engine-built spec, inline styles), so the canvas stays clean for `toBlob`.
