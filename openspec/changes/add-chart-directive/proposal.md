# Chart directive: any model picks the right chart, the engine owns the numbers

## Why

Beam already draws charts, but the *choice* of chart is a shape heuristic
(`chart_spec_from_batches`): column 0 is the label, numeric columns are series,
"looks temporal" picks line/area, else bar. It misfires in known classes — any
4-digit integer label reads as a year (store IDs chart as time series),
float-encoded categories become scatter, identifier columns draw meaningless
24-bar charts, and a single-number result can still produce a trivial chart.
The model narrating the answer can *see* that "1001, 1002…" are store IDs and
that a lone SUM needs no chart — but it has no way to say so.

Function-calling is the obvious tool and the wrong one here: the seven
providers speak different tool protocols, the local 7B's tool-calling is
unreliable, and — decisive — chart data must keep coming from engine batches,
never from model text. What every provider shares is plain text. So the
mechanism is a plain-text **directive**: a compact, versioned **chart card**
teaches the narrating model the available kinds, when each fits, when NONE
fits, and the syntax; the model may emit at most one fenced
`lighthouse-chart-request` block naming a kind and columns; the **engine
validates every named column against the actual result batches and builds the
spec FROM the batches** — a directive can steer, never supply, a number.
Invalid or absent directive → today's deterministic heuristic, unchanged.
The extractive fallback has no model and keeps the heuristic. Where golden
fixtures show the heuristic itself misfiring, it is improved — it remains the
no-model and fallback path.

## What Changes

- **The chart card** — a compact (~200-token), versioned prompt block injected
  into the narration prompt ONLY when an analytics result table is in context
  and its shape could chart: the kinds (bar, line, area), when each fits and
  when none fits (single number, >3 series, unordered long tables, identifier
  columns), the actual result columns by name, the directive syntax, and 3–4
  few-shot examples — unit-tested like the NL→SQL few-shots (a test rejects
  any taught example the engine's validator would not accept).
- **The directive** — the model may emit at most one fenced
  `lighthouse-chart-request` block: `{kind | "none", label_column,
  series_columns (≤3), title?, sort?}`. The engine parses it from the
  narration stream, strips the fence from displayed prose (both surfaces),
  validates the named columns against the real batch schema, and builds the
  `lighthouse-chart` spec from the batches with the directive's choices as
  parameters. Values in the directive are never copied into the chart. `"none"`
  suppresses the auto-chart. Invalid/absent → heuristic fallback, byte-identical
  to today.
- **Awareness** — the 0.11.3 SYSTEM_PROMPT chart lines extend so narration
  references the chart only when the model requested one, keeping "the chart
  below shows…" true.
- **Quality floor** — golden fixtures for the misfire classes (date-ish labels,
  top-N candidates, single-value results, ID columns); directive-validator
  tests (unknown column, 4+ series, fabricated values ignored); a chart
  scorecard (`examples/chart_eval.rs`) beside the 0.11.2 analytics eval so
  prompt/emitter drift is a reviewed diff, wired as a CI floor. Targeted
  heuristic improvements where fixtures demonstrate misfires — with every
  existing bar/line/area fixture unchanged.

## Capabilities

### New Capabilities
- `chart-directive`: a provider-agnostic plain-text mechanism by which the
  narrating model chooses the chart (or none) for a Beam analytics result,
  validated and materialized by the engine exclusively from result batches.

## Impact

- **Engine (Rust-only, like all Beam analytics):**
  `native/crates/lighthouse-core/src/analytics.rs` — the chart card const +
  builder, directive parse/validate, a directed variant of
  `chart_spec_from_batches` (:1422), targeted heuristic improvements
  (`looks_temporal` :1600, the scatter gate :1484); `synth.rs` — card
  injection into the narration ctxs (:605-614 pattern), directive extraction
  from the completed narration, fence-stripped deltas, chart emission
  (:871). `examples/chart_eval.rs` (new) + `.github/workflows/native.yml`
  floor wiring.
- **Shared parsing (PARITY):** `src/lib/chartSpec.ts` — directive
  parse/validate mirror (node-tested) + optional `title` on `ChartSpec`;
  `test/chartSpec.test.mjs`.
- **UI:** `src/features/chat/ChatPanel.tsx` + `src/features/widget/WidgetBar.tsx`
  — strip `lighthouse-chart-request` fences from displayed prose (the widget's
  existing strip regex generalizes; the main window gains one).
- **Prompts:** `src/server/llm.ts:217-219` ⇄ `native/.../llm.rs:146` —
  byte-identical chart-awareness extension.

## Non-goals

- **No per-provider function-calling / tool protocols.** One plain-text
  mechanism for all seven providers; no provider-specific adapters.
- **No model-supplied numbers, labels beyond the title, or data of any kind.**
  The spec is built from batches; the only directive text that reaches the
  chart is a length-capped `title`, and it is display copy, not data.
- **No new chart kinds.** bar / line / area (and the existing scatter/stacked
  behaviors) — the directive selects among what the renderer already draws.
- **No second heuristic.** The deterministic emitter remains THE fallback and
  the extractive/no-model path; the directive parameterizes it, it does not
  fork it.
- **No TS analytics engine.** Beam stays Rust-only; the twin mirrors only the
  pure directive parsing/validation + render rules in `chartSpec.ts`.
- **No retroactive re-charting** of past answers; the directive applies to the
  answer being generated.
