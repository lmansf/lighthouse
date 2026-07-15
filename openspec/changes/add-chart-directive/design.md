# Design — chart directive

## Why this shape (pinned)

**No per-provider function-calling.** The seven providers speak different tool
protocols (Anthropic tools vs OpenAI-compatible function calls vs none), the
local 7B's tool-calling is unreliable, and chart data must keep coming from
engine batches, never model text. A plain-text fenced block is the one
mechanism every provider — including the local model — shares; the extractive
fallback has no model at all and keeps the deterministic heuristic. This also
preserves the house invariant: **every number shown to users is
engine-computed.** The directive can only *steer* the existing batch-driven
emitter; it cannot inject a value.

## The chart card (the guidance "skill")

A versioned const in `analytics.rs` (`CHART_CARD_VERSION = "v1"`, full text
snapshot-pinned so any edit is a reviewed diff), rendered per-answer with the
**actual result columns** (name + numeric/text) interpolated. Content: the
three kinds and when each fits; when **none** fits (a single number, more than
3 series, unordered long tables, identifier-like columns); the fence syntax;
3–4 few-shot examples (tiny result table → directive). Budget: ~200 tokens,
asserted by a `chart_card_stays_inside_budget` test in the style of
`step_prompt_stays_inside_budget` (analytics.rs:1944). Injection: a dedicated
narration `Ctx` block (the same mechanism as join hints, synth.rs:605-614),
added ONLY when the analytics branch ran, the result was not truncated
(truncated results never chart — run_query :1373), and the batch shape passes
the loose chartable gate (2..=24 rows, ≥1 numeric column) — otherwise the 200
tokens are not spent and no doomed directive is invited.

**Few-shot integrity test (copies analytics.rs:1838-1850):** every example
directive taught by the card must be ACCEPTED by the engine's own validator
against its example table — `every_chart_card_example_validates` panics naming
the offender, so a card edit can't teach syntax the engine rejects.

## The directive (the universal "tool")

At most one fenced block in the narration:

    ```lighthouse-chart-request
    {"kind":"bar","label_column":"region","series_columns":["total"],"title":"Revenue by region","sort":"desc"}
    ```

- `kind`: `bar | line | area | none`. `"none"` suppresses the auto-chart.
- `label_column`: must name a real result column (exact, case-sensitive match
  against the batch schema).
- `series_columns`: 1..=3 names; each must exist and be numeric in the batches.
- `title` (optional): the ONE directive string that reaches the spec — display
  copy, length-capped (~80 chars), control characters stripped. Never data.
- `sort` (optional): `asc | desc` — the engine sorts batch rows by the first
  series column before building the spec; row count still bounded by
  `CHART_MAX_POINTS`.

**Stream mechanics.** Narration streams; the engine scans the accumulating
text for the fence, withholds fence bytes from forwarded deltas (the fence
never reaches displayed prose), and on completion parses the FIRST directive
(later ones ignored). Belt-and-braces: both surfaces also strip any residual
`lighthouse-chart-request` fence — the widget's existing regex
(WidgetBar.tsx:988-991) generalizes; ChatPanel gains the same strip for
displayed prose.

**Validation → materialization.** A valid directive parameterizes a directed
variant of `chart_spec_from_batches` (label/series/sort/title as parameters,
values read from batches exactly as today). Any violation — unknown column,
non-numeric series, >3 series, malformed JSON, fabricated `x`/`values` keys
(ignored wholesale: only the five fields are read) — falls back to the
UNCHANGED heuristic, so a bad directive can never do worse than today.
`"none"` returns no chart even when the heuristic would have drawn one.

## Awareness (SYSTEM_PROMPT extension)

The 0.11.3 chart lines (llm.ts:217-219 ⇄ llm.rs:146, byte-identical) extend:
reference the chart in prose only when you are including a chart request in
this answer; if you request none, don't describe one. Residual accepted case,
mitigated by the card and few-shots: a model that references a chart but emits
an invalid directive still usually gets the heuristic fallback chart; the
truly-lying case (invalid directive AND unchartable shape) requires the model
to both ignore the card's "when none fits" guidance and name unreal columns —
covered in the scorecard, not guaranteed impossible.

## Heuristic improvements (fixture-driven, fallback-preserving)

Only where golden fixtures demonstrate a misfire, and with **every existing
bar/line/area fixture byte-unchanged** (the byte-lock test analytics.rs:2065
and the kind tests :2011-2220 all stay green):

- `looks_temporal` (:1600): a bare 4-digit integer counts as a year only in a
  plausible range (1900..=2100) — store IDs 1001..1024 stop charting as time;
  the `bare_year_x_stays_area` fixture (2019..2021) stays green.
- Scatter gate (:1484): integral-valued float columns (1.0, 2.0, 3.0) are
  treated as categorical keys (bar), matching the existing integer-key rule;
  scatter remains for genuinely continuous x.
- Identifier labels: a label column whose name matches an id-pattern
  (`(^|_)(id|sku|code)s?$`, case-insensitive) makes the heuristic decline
  (None) rather than draw a meaningless bar row per identifier.

## Rust/TS parity

Beam analytics is Rust-only (established divergence). What mirrors:
- `src/lib/chartSpec.ts` gains `parseChartDirective` + `validateDirective(cols)`
  — the same parse/validate rules, node-tested against the same fixtures, so
  the directive grammar cannot drift from the Rust engine (`PARITY:` notes both
  sides).
- `ChartSpec` gains optional `title?` (renderer draws it when present);
  `parseChartSpec` accepts it; heuristic output without a directive carries no
  title, so all existing spec fixtures remain byte-identical.
- The SYSTEM_PROMPT extension is byte-identical in both engines (parity rule 2).

## Failure & degradation

- **Every failure lands on today's behavior.** Malformed/invalid/missing
  directive → unchanged heuristic; heuristic declines → no chart (as today);
  fence-stripping failure → the UI strip catches the residue.
- **No model / extractive fallback:** no narration call happens, so no card, no
  directive — the heuristic path runs exactly as today.
- **6144 window:** the card is ~200 tokens, injected only on chartable
  analytics answers, budget-asserted; narration table clipping
  (`NARRATE_MAX_ROWS/CHARS`) is untouched.
- **Truncated results** never chart today and still never chart — no card, no
  directive honored.
