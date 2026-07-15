# Design — briefing note

## Non-Goals (pinned)

1. No model in the note — deterministic string formatting over verified pin
   summaries only. No summarization, ranking, or generated prose.
2. No new scheduler — the note rides the existing pin-recheck task; the only new
   logic is a pure daily due-gate.
3. The note file is ALWAYS written; only the OS notification is gated (setting +
   hidden-app suppression).
4. One file overwritten in place — no dated history, no append.
5. No arithmetic, no cross-file recompute — the note reports pins' own
   before/after.
6. No `CACHE_VERSION` bump; extraction is untouched.

## The load-bearing constraints

### C1 — "Every value is verified, never model text" ⇒ the composer is pure
`compose_briefing_note` takes the exact `ChangedPin { question, before, after }`
records the pin recheck already produced (each `after` is a re-run, guarded,
model-free SQL summary; each `before` is the prior such summary). It emits one
GFM before→after table per pin, escaping only the pipe (the sole char that can
break a table row), then a footer. There is NO call to the model anywhere on the
path. The honesty line ("Every value is computed directly from your files — no
AI.") is literal and always present, empty set included.

### C2 — Byte-identical twins ⇒ a shared golden string
Analytics is Rust-only, but the note composer is simple enough to mirror, and the
web/dev path (`app/api/rag/route.ts`) needs it. So Rust `compose_briefing_note`
and TS `composeBriefingNote` are KEEP-BYTE-IDENTICAL. The footer stamp uses UTC
(`%Y-%m-%d %H:%M UTC` in Rust; `getUTC*` in TS) so it is timezone-independent and
byte-reproducible. Both engines assert the SAME golden output for the SAME
`(changed, now_ms)` — the Rust `compose_note_renders_...` test and the Node
`composeBriefingNote matches the Rust golden output byte-for-byte` test share the
input `now_ms = 1_784_106_180_000` (2026-07-15 09:03 UTC) and the same expected
bytes.

## Decisions

### D1 — `note_due` is a pure LOCAL-day gate
`note_due(last_note_ms, now_ms, hour)` returns true iff the LOCAL hour is ≥ the
user's `hour` AND the note has not been written yet today (never written, or last
written on an earlier local day, compared by `(year, ordinal)`). `chrono::Local`
so "9" means the user's 9am, not UTC. It is pure — the desktop timer passes the
clock — so `note_due_gates_on_hour_and_day` tests it without a real clock across
four cases (before hour, never-written-after-hour, same-day, prior-day).

### D2 — The daily stamp lives engine-side, not in settings
`last_note_ms` / `mark_note_run` persist to `state/briefing-note.json` (atomic
temp+rename, like the pins/briefings stores). Keeping it engine-side (not in the
desktop settings file) means the daily gate is fully in-container testable
(`note_state_round_trips`) and the shell stays a thin caller.

### D3 — Accumulate changes across recheck passes, keyed by pin id
The desktop recheck task fires more often than daily. A pin can change several
times before a note is due. The task accumulates into a `HashMap<id, ChangedPin>`
that keeps the EARLIEST `before` and updates to the LATEST `after` (`.entry(id)
.and_modify(|e| e.after = ...).or_insert(...)`), so the note reads a true
"since the last note" delta, not just the final pass. This map clears only when
a note is written — independent of the `pending` alert buffer, which clears on
each toast emit. The composed set is sorted by id for deterministic output.

### D4 — Notification is gated twice; the write never is
`maybe_notify` returns early when `briefingNotify == false` OR the Supervisor
reports suspended (hidden to tray / idle-suspended under background-conserve —
the established "never wake from hidden" rule). The note refresh + `mark_note_run`
happen BEFORE `maybe_notify`, so suppressing the nudge never suppresses the file.
The on-demand dialog op composes and writes but calls no notification at all.

### D5 — `refresh_artifact`: in-place, escape-proof, no duplicates
`write_artifact` collision-suffixes to avoid overwriting a user's file; that's
wrong for a note meant to be a single updating file. `refresh_artifact` shares
the exact sanitize (control/slash → `-`, 80-char cap, trim, `.`-strip, non-empty
fallback) and the `safe_abs` escape guard, but does a truncating `fs::write` at
the fixed `{subdir}/{clean}.{ext}` path — so `Lighthouse Notes/Lighthouse
Briefing.md` updates in place. The walk cache is invalidated so the explorer sees
the change.

### D6 — `briefingNoteHour` is validated at the writer, defaulted at the read
The writer stores the hour only when it is in `0..=23`; a nonsense value is
dropped and the reader falls back to 9. This keeps a bad client value from
stranding the schedule and needs no migration.

## Degradation

- Notification plugin unavailable / show() fails ⇒ `let _ =` swallows it; the
  note is still written. A nudge is best-effort, the record is not.
- A read-only vault location ⇒ `refresh_artifact` returns an error surfaced to
  the dialog op; the scheduled path `let _`-ignores it and retries next due day.
- No pins changed since the last note ⇒ the scheduled path does not fire (guarded
  on a non-empty change set); the on-demand path writes a coherent "nothing
  changed" note so the user gets explicit confirmation, not silence.
- A corrupt `briefing-note.json` ⇒ reads as "never written" ⇒ at worst one extra
  refresh, never a crash.

## Test plan

- Rust (`briefings.rs`): `compose_briefing_note` golden (two pins, one with no
  prior `before` → "—"), empty-set coherence, `note_due` four-case gate,
  `note_state` round-trip. (`vault.rs`/`vault_test.rs`): `refresh_artifact`
  overwrites in place and stays inside the vault. (`settings_test.rs`): the two
  new fields round-trip through the no-`..` exhaustiveness tripwire and the
  positional writer.
- Node (`briefings.test.mjs`): `composeBriefingNote` byte-parity against the Rust
  golden, and the empty-set shape.
- `cargo test -p lighthouse-core -p lighthouse-server`, `tsc --noEmit`,
  `next lint`, `node --test test/*.test.mjs` all green.
- `node scripts/openspec-validate.mjs add-briefing-note` green.
- CI-only (`desktop-release.yml` / `release-smoke.yml`): the desktop crate builds
  with the notification plugin (`--locked`); the scheduled write + notification
  and the two Preferences controls are DOM/OS — manual/visual QA. The settings
  round-trip smoke covers the two new fields via the compile tripwire.
