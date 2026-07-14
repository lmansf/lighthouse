# Design — add-audit-log

## Decisions

### D1. The choke point is the transport boundary, not each synth branch
`synth::answer_pipeline` has eight terminal branches (analytics, multi-doc,
doc-focus full/sweep, single-shot, meta, …), several inside `spawn_blocking`
closures. Instrumenting each would be eight fragile sites that a new answer
path could silently miss. Instead the record is written at the **single point
every answered question passes through**: the transport consumer that drives
the stream to its `done: true` chunk —

- Rust: `commands.rs::chat_ask` (the widget AND the main window both invoke
  this) and `routes.rs::chat_post` (headless/web).
- TS: the `app/api/chat` route.

This is the honest reading of "one record per answered question": a question
is *answered* when its stream completes at the boundary. The roadmap's
"synth choke point" language is about coverage (widget + main window), which
this satisfies — both go through `chat_ask`. A `PARITY`/design note records
this so a future reader doesn't expect the write inside `synth.rs`.

### D2. Fields assembled from data already at the boundary
- `questionSha256`: sha256 of the verbatim question (already in scope at the
  boundary). Verbatim text is included ONLY when `auditVerbatim` is set
  (pref or policy) — the privacy default is hash-only, so the log itself
  can't leak the questions it records.
- `fileIds`: the `fileId`s of the final chunk's references (what the answer
  actually cited/read).
- `provider`: `cfg.provider_id` (`local` / `anthropic` / … / `none`).
- `egress`: a **delta** of the S3 registry — snapshot the set of
  (host,count) before driving the stream, diff after; `none` when unchanged,
  else the hosts newly contacted for this question. This reuses the registry
  that already exists rather than re-instrumenting HTTP.
- `artifacts`: saved CSV/note ids written during the answer (analytics
  save-as, chat export) — captured from the final chunk's analytics meta +
  any artifact the pipeline reports. Empty for a plain answer.

### D3. HMAC chain for tamper-evidence
Each record carries `prevHmac` (the previous record's `hmac`, or a fixed
genesis for the first) and `hmac = HMAC-SHA256(key, canonical(record without
hmac) || prevHmac)`. The key is derived from the existing per-install secrets
store (`secrets::machine_secret`) via a domain-separated label
(`"lighthouse-audit-hmac-v1"`) so it is distinct from the sealing key. A
verifier walks the file recomputing the chain; a deleted or edited middle
record breaks every subsequent link. `sha2`/`hmac` crates are already in the
tree (secrets uses them). This detects tampering; it does not prevent a root
user from rewriting the whole chain (they own the key) — stated in the doc,
same posture as the policy layer.

### D4. Append is atomic-ish and never blocks the answer
Records append to `audit/audit-<YYYY-MM>.jsonl` (one line each). The write is
best-effort and happens after the final chunk is emitted to the user — a
failed or slow disk never delays or fails a question. Monthly file rollover
keeps any single file bounded without a rotation daemon.

### D5. Gating
Written only when `settings.audit_enabled == Some(true)` OR
`policy::audit_forced_on()`. The policy force also locks the Preferences
toggle on (the lock state is already carried by the S1 snapshot's
`locks.auditLogOn`). Off by default (absent setting = off).

### D6. TS twin scope (PARITY)
`audit.ts` writes the same record shape at the `app/api/chat` route, WITHOUT
the HMAC chain (the dev twin is not a security surface, and the secrets store
there is file-based). The `prevHmac`/`hmac` fields are omitted; a PARITY
comment on both sides states this. The viewer/export read whichever fields
are present.

## Threat model (for the reviewer)
Detects post-hoc tampering with the local log by a non-root user or a process
that doesn't hold the HMAC key. Does NOT defend against a local administrator
(who owns the secrets store and can recompute the chain), or prevent the log
being deleted wholesale (a deleted file is self-evidently absent). This is a
detective control for review, consistent with the managed-policy posture.

## Follow-ons (not v1)
Retention/rotation policy keys; signed (not just HMAC'd) records for
cross-machine verification; shipping the log to a SIEM via an explicit,
documented, opt-in egress.
