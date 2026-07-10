# Answer artifacts: results, charts, and findings you can keep

## Why

Analysts produce artifacts, not just answers. Today an analytics result can only be copied as CSV text; charts can't leave the chat; a good investigation evaporates when the conversation ends. Closing the loop — result → file, chart → image, conversation → note — makes each answer compound into the next piece of work.

## What Changes

- **Save result as CSV into the vault**: the `analyticsSql` op (from `add-analytics-refinement`) gains `saveAs`; the engine re-runs the answer's SQL with a higher row cap and writes an RFC-4180 CSV under `Lighthouse Results/` inside the vault — where the watcher picks it up and it becomes queryable input like any other file. A "Save as CSV" chip appears on analytics answers.
- **Export chart as PNG**: a button on rendered charts serializes the SVG to a theme-correct PNG download. Client-only.
- **Export chat to a vault note**: a chat menu action writes the transcript (with citations and footers) as markdown under `Lighthouse Notes/` via a new `exportChat` op, then reveals it.

## Capabilities

### New Capabilities
- `answer-artifacts`: persisting analytics results, charts, and conversations as files.

### Modified Capabilities
<!-- none -->

## Impact

- `native/crates/lighthouse-core/src/analytics.rs` (save path on direct execution), new small vault-write helper (sanitized names, collision suffixes), `routes.rs`/`commands.rs` (`saveAs` on `analyticsSql`, new `exportChat`).
- `src/features/chat/ChatPanel.tsx` (chip + menu action + toasts), `src/features/chat/AnalyticsChart.tsx` (PNG export), contracts service.
- TS twin: `exportChat` implemented (walk/write exist); `saveAs` PARITY-errors like `analyticsSql`.
