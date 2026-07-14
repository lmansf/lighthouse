# Design — briefings

## Model

```
Briefing { id, title, pinIds[], cadence, lastRunMs?, createdMs }
Cadence  = manual | daily | weekly
BriefingReport  { id, title, generatedMs, sections[] }
BriefingSection { question, markdown, error? }
```

Stored at `state/briefings.json` (`{ briefings: [...] }`), the exact idiom pins
use: load-or-empty on corruption, atomic temp+rename, a store lock serializing
load-modify-save, `id = brief-<sha1(lowercased title)[..12]>` so re-saving the
same title replaces (edit-in-place) instead of duplicating.

## Run = re-run the pins, compose

`run(id)` resolves each `pinId` against `pins::list()`:
- pin found → `analytics::run_direct(pin.sql, pin.file_ids)` (the SAME guarded,
  model-free path Edit-SQL and pin rechecks use) → section carries `res.markdown`.
- pin gone → error section "this pinned question was removed".
- query failed → error section with the engine's reason.

So a briefing inherits the pins trust invariant end to end: no number in a
report was authored by the model. After composing, `run` stamps `lastRunMs` so
the schedule advances.

## Scheduling without a clock in the engine

`due(now) -> [id]` is pure: for each briefing with a non-manual cadence, due iff
never run or `now - lastRunMs >= interval` (day / week). The desktop shell polls
`due(now)` on the timer it already runs for pin rechecks and calls `run` for
each — no scheduler thread inside the engine, so the decision stays unit-testable
and the shell (which can't compile in the dev container) owns only the trivial
"call run for these ids" wiring. That last hop is the one shell-only follow-on;
everything the engine and UI need is here.

## Parity

CRUD + `due` are byte-identical across `briefings.rs` and `src/server/
briefings.ts`. Composition is a declared PARITY divergence, exactly like pin
rechecks: the twin has no DataFusion, so `runBriefing` composes from each pin's
stored `lastSummary` (or a "no computed result yet" note) instead of executing
SQL. The wire shapes are identical, so the one Briefings UI reads either engine.

## UI

A Briefings section in the existing pins dialog: create (title + checkbox-pick
from the current pins + cadence select), list with Run/Remove, and a rendered
report (reusing the chat markdown renderer) when Run is pressed. No new dialog
surface, no new navigation — briefings live where pins already do.
