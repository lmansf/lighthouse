# Briefings: pinned questions, composed into one report (Phase 2)

## Why

The data analyst already pins the questions they care about — "revenue by
region", "open tickets by team", "spend vs budget" — and the engine re-runs
each pin's SQL when its files change (add-pinned-questions). But pins surface
one at a time, as change alerts. What the analyst actually asks for on Monday
morning is *the whole set, together*: a **briefing**. Today they'd re-open each
pin by hand.

A briefing is a titled, ordered selection of pins that runs as a unit and
composes into one markdown report — each question with its current, verified
result. It reuses the pins substrate wholesale: the numbers come from the same
guarded, model-free `run_direct` path, so a briefing carries the same trust
guarantee (every figure is a computed query result, never model text). An
optional cadence (daily/weekly) lets the shell's existing recheck timer bring a
briefing "due" on its own — the README's promised "scheduled briefings".

## What Changes

- **A briefing groups pins into one report**: a new `briefings.rs` engine module
  stores briefings (`state/briefings.json`, cap 20, atomic writes, title-stable
  id — same idiom as pins) and, on run, re-executes each referenced pin's SQL
  through `analytics::run_direct` and composes a `BriefingReport` (title,
  generation time, one section per question with its result markdown). A removed
  pin or a failed query becomes an error section rather than sinking the report.
- **Optional scheduling, testable without a clock**: a briefing carries a
  `cadence` (`manual`/`daily`/`weekly`). The pure `due(now)` function returns the
  briefings due to regenerate; the desktop shell polls it on the same timer it
  already runs for pin rechecks. `manual` briefings never come due on their own.
- **Wired through every layer**: `listBriefings`/`saveBriefing`/`removeBriefing`/
  `runBriefing` ops on the axum server, desktop `rag_op`, and the `/api/rag`
  dev route; `RagService` contract + real + mock; a Briefings panel in the
  existing pins dialog to create (title + pick pins + cadence), list, run
  (showing the composed report), and remove.

## Capabilities

### New Capabilities
- `briefings`: grouping pinned questions into a titled report that runs as a
  unit, on demand or on a cadence, composed from verified query results.

### Modified Capabilities
<!-- none — briefings consume pins/analytics unchanged -->

## Impact

- New `native/crates/lighthouse-core/src/briefings.rs` (store, CRUD, `due`,
  `run`, `render_markdown`, unit tests); `lib.rs` module registration.
- `lighthouse-server/src/routes.rs` + `lighthouse-desktop/src/commands.rs`: the
  four briefing ops (+ a `parse_cadence` helper).
- TS twin `src/server/briefings.ts` (CRUD + `due` byte-identical; `run` composes
  from pins' last summaries — PARITY, since live SQL is Rust-only) + `app/api/
  rag/route.ts` ops.
- Contracts: `Briefing`/`Cadence`/`BriefingSection`/`BriefingReport` types +
  `RagService` methods + real + mock.
- FE: a Briefings section in the pins dialog (`ChatPanel.tsx`).
- Tests: Rust `briefings::tests` (CRUD, cap, due, missing-pin run, render) +
  `test/briefings.test.mjs` (twin CRUD, due, PARITY compose).

## Non-goals

- **No new SQL or analytics** — a briefing only re-runs pins that already exist.
- **No email/export delivery** — a briefing renders in-app; saving the report as
  a note reuses the existing chat export, not a new channel.
- **No in-engine scheduler thread** — the engine exposes `due(now)`; the shell's
  existing timer owns *when* to poll. (Wiring the shell timer to auto-run due
  briefings is a small shell-only follow-on; the engine and UI are complete.)
- **No cross-pin joins or roll-ups** — sections are independent; a briefing is a
  composition, not a query.
