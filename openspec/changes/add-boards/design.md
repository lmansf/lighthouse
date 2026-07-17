# add-boards — design

## The object

```
Board {
  id: string             // engine-minted, stable
  name: string           // unique case-insensitively within its scope
  investigationId: string | null   // null = global (mirrors Pin.investigationId)
  cards: [{ pinId: string, size: "S" | "M" | "L" }]  // ordered
  createdMs: i64
}
```

Envelope `{v: 1, boards: [...]}` in `state_dir()/boards.json` — the
investigations idiom verbatim (only v1 loads; unknown/corrupt preserved as
`.bak-<epochms>` on next write). Boards are pure references: removing a card
never touches the pin; a deleted pin renders as a tombstone card ("pin
removed") until its card is removed.

**Defaults, lazily.** "One default board per investigation plus a global
'My board'" materializes on FIRST VIEW (list op returns a virtual default
when none exists for the requested scope; the first mutation persists it).
No migration, no eager writes.

## Cards render engine results, and where the rows come from

The recheck loop persists only `last_digest` + a ≤3-row `last_summary` —
rows and chart specs never touch disk (pins.rs write-back). Therefore:

- **Desktop (Rust)**: a `boards.refreshCards` op takes pin ids and re-runs
  each pin's stored SQL through `run_direct` (the SAME guard as Edit SQL /
  pins), returning per-pin `{markdown, chart, footer, resultDigest}` —
  deterministic, model-free, DataFusion-only. The UI renders:
  - chartable → `AnalyticsChart` from `parseChartSpec(chart)`;
  - single row+column → a stat tile (large `tabular-nums` numeral; delta
    computed against the pin's previous summary via `pinChart.ts` parsing);
  - else → compact top rows from the row-capped markdown table.
- **Twin (TS)**: `run_direct` is Rust-only (PARITY, as pins.ts). The twin's
  `refreshCards` returns each pin's STORED state (`lastSummary`,
  `lastDigest`, `lastRunMs`, `staleReason`) and the UI renders the
  last-known snapshot: mini-chart via `pinChart.ts` when the summary
  parses, else the summary text — plus an "Ask again" affordance through
  the normal ask path. Byte-compatible op shape; a `live: bool` field on
  the response distinguishes computed-now from stored-state so the card
  can label freshness honestly.

**Freshness + diff.** Every card shows the engine freshness line (from the
`run_direct` footer on desktop; `checked <relative lastRunMs>` from stored
state on the twin). The diff badge keys on the existing `pins-changed`
payload (`ChangedPin {id, before, after}`) relayed as
`lighthouse:pins-changed`: a board listening to that event marks matching
cards changed (before→after available for the stat delta) until the user
views them. No new events.

**Drill-in** = the normal ask path with the pin's question (the exact
existing `askPinned` flow) — narrated answer, answer cache, provenance
stamp all apply unchanged.

## Refresh triggers (no scheduler)

1. Watcher recheck (existing loop) → `pins-changed` → cards update their
   digest/diff state; a visible board follows with a `refreshCards` call
   for changed pins only.
2. Manual "Refresh all" → one `refreshCards` for the board's pins.
3. Opening a board → `refreshCards` for its pins (desktop), stored state
   (twin).

Power-conserve: SQL re-runs are model-free and independent of the
suspended llama supervisor — exactly the recheck loop's existing posture —
so no conserve gating. Drill-in is an ordinary ask and inherits ordinary
behavior. The board takes NO wakeups of its own: rendering happens when
the board is visible; background changes accumulate as diff badges.

## Layout

Responsive CSS grid (auto-fill, minmax by size: S = 1 column, M = 2, L =
full row on narrow). Reorder: keyboard-first "Move up/down" controls on
each card (accessible, zero-dep — the codebase has no dnd library and
Fluent v9 ships none) plus HTML5 `draggable` as progressive enhancement
(the FileExplorer drag pattern). Sizes cycle S→M→L from a card menu.
0.12.0 treatment: radius 10 card, hairline + ambient shadow, tabular
numerals, quiet chrome; both themes via tokens only.

## Export

`composeBoardPack(input)` added beside `composeEvidencePack` in
`src/lib/evidencePack.ts`: title + per-card sections (rendered table HTML
via `answerMarkdownToHtml`, inline SVG chart via the existing
`standaloneChartSvg` capture of the live card, freshness stamp) + one SQL
appendix (each pin's SQL + engine footer verbatim). Saved through
`exportChat(title, html, {subdir: "Lighthouse Results", ext: "html"})` —
the existing allowlisted, collision-suffixed artifact writer. No new
engine op; no network; the pack stays self-contained offline.

## Rust/TS parity

- `boards.rs` ⇄ `boards.ts`: byte-compatible envelope + CRUD + validation
  (name uniqueness per scope, size enum, pin-id existence NOT enforced at
  write — tombstones render instead, so a pin deleted later can't corrupt
  a board).
- `refreshCards`: desktop computes live via `run_direct`; twin returns
  stored pin state with `live: false` (PARITY comment; the pins.ts
  precedent). Response shape identical.
- UI is client-shared; the widget is untouched.

## Failure & degradation

- Pin deleted → tombstone card, remove affordance; board never blocks.
- `run_direct` error (file gone, schema drift) → the card shows the pin's
  `staleReason` posture: the error text in the card body, freshness line
  kept — same honesty as the pins dialog.
- Unknown envelope version / corrupt boards.json → session-empty +
  bak-on-write (never clobber), as investigations.
- A board scoped to an archived investigation stays functional (archive
  hides the investigation from the nav, never its data).
- 6144-token window: irrelevant — cards never touch the model.
