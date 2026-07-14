# Local audit log: answer the security-review question (IT security director, S2)

## Why

The exact question a security review asks — "what did the AI read, and what
left the machine, and when?" — has no answer today. The egress panel (S3)
shows the current session live but keeps nothing; there is no durable,
reviewable record. An IT security director evaluating a pilot needs a
tamper-evident local log they can point their own auditors at, off by default
(privacy-first) but flippable by preference or org policy.

This builds directly on the two prior S-track pieces: the managed policy layer
(`auditLog: "on"` forces it), and the egress registry (each record's egress
field comes from it).

## What Changes

- **An append-only JSONL audit log** in the app-state dir
  (`audit/audit-<YYYY-MM>.jsonl`, 0600, atomic appends), **one record per
  answered question**, written at the single transport choke point every
  answer passes through (so the widget, main window, and headless server are
  all covered).
- **Each record**: `ts` (epoch ms), `questionSha256` (the verbatim text only
  when a policy/pref key `auditVerbatim` is set — privacy default is the hash),
  `fileIds` (files cited/read), `provider` (the model provider used, or
  `local`/`none`), `egress` (`none` or the list of hosts contacted for that
  question, from the S3 registry delta), `artifacts` (saved CSVs/notes written
  during the answer), and a **per-record HMAC chained to the previous record's
  HMAC** (key from the existing secrets store) so any deletion or edit of a
  middle record is detectable.
- **Off by default.** Enabled by a Preferences toggle or forced by the S1
  policy key `auditLog: "on"` (which locks the toggle on).
- **A viewer** under the settings gear (recent records, with a tamper-check
  indicator) and **CSV export**.
- **TS twin**: the same record shape at the same choke point, **without the
  HMAC chain** (PARITY — the dev twin is not a security surface; noted in
  code).

## Capabilities

### New Capabilities
- `audit-log`: a tamper-evident, local-only, append-only record of answered
  questions — files read, provider used, egress, artifacts — for security
  review.

### Modified Capabilities
<!-- none — answering behavior is unchanged; the record is written after the
     answer completes and never blocks or alters it -->

## Impact

- New `native/crates/lighthouse-core/src/audit.rs` (record shape, HMAC chain
  over the secrets-store key, gated append) + `audit.ts` twin.
- Choke point: `routes.rs` `chat_post` + `commands.rs` `chat_ask` (Rust),
  `app/api/chat` route (TS) — snapshot egress before the answer, assemble and
  append the record when the stream completes.
- Ops to list/export via `rag_op`/routes + a settings preference
  (`auditLog` bool) alongside the existing settings toggles; policy
  `auditLog: "on"` consulted (already exposed by add-managed-policy).
- UI: a viewer dialog under the settings gear (SettingsMenu) + CSV export;
  the Preferences audit toggle with the managed-lock state.

## Non-goals

- **No remote shipping** of the log — it is local-only, for the machine's own
  administrator to collect via their existing tooling.
- **No retention automation in v1** — monthly files; manual rotation
  documented. (A retention policy key is a noted follow-on.)
- **No blocking or altering** of answers — the log is written after the fact
  and a failure to write never fails a question.
- **No per-question network capture** beyond the host list the S3 registry
  already records (never content).
