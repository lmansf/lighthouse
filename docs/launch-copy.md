# Beam — launch copy (draft)

Draft for the 0.12 Beam release — site and release announcement; trim per
surface. Tone: plain, specific, honest — no superlatives.

## One-liner

**Private analytics on your own machine.** Ask your spreadsheets a question;
Beam, the built-in analytics engine, writes the SQL, runs it on your device,
and shows both the numbers and the query. Nothing leaves unless you choose.

## How Beam works (four beats)

1. **Ask.** The model reads only the shape of your tables — names, columns, a
   few sample rows — and writes one read-only SQL SELECT.
2. **Execute.** An embedded query engine runs that SQL on your machine. The
   model never does arithmetic; every number comes from the engine.
3. **Verify.** The answer leads with the figure, shows the exact result table
   and a chart drawn from those same verified rows, and prints the SQL it ran —
   plus which files it read and how fresh they were.
4. **Keep.** Save the result as a CSV back into your vault, or as an evidence
   pack — one self-contained HTML file: question, narrative, table, chart, SQL,
   provenance. Pin the question; Lighthouse re-checks it when the files change.

## Why you can trust it

- **Always unlocked.** No account, no license, no sign-in — none of it exists.
- **No telemetry.** Only three kinds of request ever leave the machine: asks to
  a cloud model you configure, an update check, and downloads you click.
- **Provenance on every answer.** A stamp says the answer was computed on this
  device — or names the vendor that saw excerpts. A session badge counts
  exactly what left the machine, and to where.
- **Local-only marks.** Lock a file to this device: the private model still
  reads it; a cloud model never will.
- **The inspector.** "What the AI sees" shows the exact text extracted from any
  file, chunk by chunk, and can test what a question would retrieve.
- **Honest edges.** Truncated results, skipped files, and cached replays say so
  in fixed, engine-written footers the model can't reword. Limits are real: the
  private model (Mistral 7B, a one-time ~4.2 GB download) runs in a modest
  context window, so one ask carries only a few tables' schemas — and the
  answer discloses when files were left out.

## The time-savers, briefly

A repeated ask replays instantly from a visibly marked cache, with a one-click
re-run. Type-ahead suggests past questions and pins; ↑ recalls your last ask.
Citations open the exact passage in the inspector. Ctrl/Cmd+P finds any file.
Per-folder rules curate whole folders, including files that arrive later. And
switching models is one click in the chat header — the provenance stamp follows.

## The identity

Beam is also how Lighthouse looks: ink and paper with a single amber beam, in
light and dark — one accent, quiet surfaces, the content is the interface.

## Availability

Windows, macOS, and Linux — download at **lhvault.app**. *(Unsigned builds
today — SmartScreen/Gatekeeper may warn on first launch; docs/signing.md.)*
