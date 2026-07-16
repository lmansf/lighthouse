# add-boards

## Why

Pinned questions already re-check themselves when the watched files change,
but their results are read one alert at a time. Analysts keep a handful of
numbers they glance at daily — the shape of that need is a dashboard, not a
chat transcript. Boards arrange existing pins as a living, local dashboard:
every card is an engine-computed result, refreshed by the machinery that
already exists, never by the model.

## What Changes

- A new store `.rag-vault/boards.json` (versioned envelope, the
  investigations idiom with bak-on-write) holding boards: {id, name,
  investigationId | global, ordered card refs}, card ref = {pinId, size:
  S | M | L}. One default board per investigation plus a global "My board";
  defaults materialize lazily on first view.
- Cards render the pin's latest DETERMINISTIC result: on desktop a card
  re-runs the pin's stored SQL through the existing `run_direct` guard at
  render/refresh time (rechecks persist only digest + summary — never rows),
  yielding the real chart card, a stat tile (large tabular numeral + delta
  vs the previous digest's summary), or compact top rows; every card carries
  the freshness line and a diff badge when the last watcher recheck changed
  the digest. Click drills into the full narrated answer through the normal
  ask path (answer cache applies).
- Refresh: NO new scheduler. Boards subscribe to the existing
  watcher-driven pin recheck (`pins-changed` → the relayed DOM event); a
  manual "Refresh all" re-runs the board's pins' stored SQL through the
  guard. SQL re-runs are model-free and follow the recheck loop's own
  posture — power-conserve gates only model-touching actions (drill-in),
  which already behave like every other ask.
- Layout: a responsive grid with three card sizes and reordering —
  keyboard-first (move controls) with HTML5 drag as progressive
  enhancement. 0.12.0 Beam card treatment; both themes.
- Sharing: "Export board" composes ONE evidence-pack-style HTML (title,
  cards as tables/charts with baked SVG, freshness stamps, SQL appendix)
  through the existing artifacts machinery (`exportChat` →
  `write_artifact("Lighthouse Results", …, "html")`).

## Capabilities

### New Capabilities

- `boards`: pin-backed local dashboards — the object and store, card
  rendering from engine results, watcher-subscribed freshness with diff
  badges, drill-in, layout, and export.

## Non-goals

- **No free-form canvas.** A responsive grid with three sizes and ordering
  — no x/y coordinates, no resizable-anything, no overlapping cards.
- **The model is never consulted to refresh a card.** Cards are engine
  results only; narration exists solely behind drill-in, which is an
  ordinary ask.
- **No new scheduler or cadence.** The watcher-driven recheck loop and a
  manual refresh are the only triggers; no timers, no background jobs.
- **No cross-vault or shared boards.** boards.json is vault-scoped local
  state; export produces a file, not a link.
- **No pin editing from the board.** Cards reference pins; managing the
  pin (SQL, watched files, deletion) stays in the pins dialog. Removing a
  card never deletes the pin.
- **Twin executes nothing.** The TS twin gets CRUD + layout + last-known
  snapshots (stored summary/digest via the shared pins.json shape) + an
  Ask-again affordance through the normal ask path; `run_direct` remains
  Rust-only (PARITY).

## Impact

- Engine: NEW `native/crates/lighthouse-core/src/boards.rs` ⇄
  `src/server/boards.ts` (store, CRUD, card-refresh op that wraps
  `run_direct` per pin on desktop; twin returns stored state). Dispatch
  `op: "boards"` in `routes.rs` / `commands.rs` / `app/api/rag/route.ts`.
- Contracts/UI: `Board` types + RagService methods (+ real/mock);
  NEW `src/features/boards/BoardPanel.tsx` (+ card components reusing
  `AnalyticsChart`, `chartSpec.ts`, `pinChart.ts`); nav entry; export
  composer extension in `src/lib/evidencePack.ts` (`composeBoardPack`,
  reusing `answerMarkdownToHtml` + `PACK_CSS` + `standaloneChartSvg`).
- `docs/data-flows.md` MUST NOT grow (no new egress).
