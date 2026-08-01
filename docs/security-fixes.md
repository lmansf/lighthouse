# Security fixes log

A running record of security-relevant fixes, most recent first. Each entry notes
the issue, its pre-fix severity, the fix, and where it landed. Severities are
calibrated for a single-user local-first desktop app (an attacker who already
controls the user's machine is discounted; another device on the network, or the
vendor's cloud, counts as a real boundary crossed).

---

## 2026-08-01 — iOS: the sealing secret and the store it seals leave the backup

- **`secret.key` and `secrets.json` were both inside the device backup** —
  _Medium._ `secrets.rs` seals provider API keys — and via `provider_auth.rs`
  the OAuth access/refresh tokens — with AES-256-GCM under a per-install secret
  that, with the `keychain` feature off (the shipping default), lives as
  `secret.key` **right beside** the `secrets.json` it decrypts: both under
  `app_state_dir()`, which on iOS is the app's Application Support container.
  Application Support is inside the iCloud/Finder device backup, so a single
  backup carried the ciphertext AND its key — every stored key and token
  recoverable in cleartext with **no device access and no malware**, squarely
  inside the threat model `secrets.rs` itself documents ("casual disk/backup/
  cloud-sync inspection"). The control was specified —
  `openspec/changes/add-mobile-apps/tasks.md` §3.2, "`isExcludedFromBackup` on
  vault/state/`secret.key`" — but only ever implemented for the regenerable
  extraction cache (`state_home::mark_cache_no_backup`).
  **Fix:** `mark_cache_no_backup` is generalized into a pure, platform-neutral
  `state_home::no_backup_targets(new_home, app_state)` (the house verdict-fn
  shape, so *which* paths are excluded is a unit test on every platform) plus a
  thin iOS `mark_no_backup(paths)` that applies `NSURLIsExcludedFromBackupKey`
  to each target that exists, via the unchanged §41 ObjC-runtime idiom.
  `bootstrap_env` calls it right after publishing `LIGHTHOUSE_APP_STATE_DIR`
  and before any engine call. The target set is the **container itself** plus
  `secret.key`, `secrets.json`, and the cache. The container entry is the
  load-bearing one, deliberately: a file-level mark alone cannot hold, because
  the attribute only applies to a path that already exists and `secret.key` is
  created **later**, on first use (`machine_secret`), and because it is an
  xattr on the inode that `config::write_atomic`'s temp+rename drops on every
  `secrets.json` rewrite. iOS propagates a directory's exclusion to files
  created after the mark, so the container covers both cases; the file entries
  are defense in depth, re-applied on every launch. Engine state under the
  container is excluded with it (superseding §41's narrower "state.json and the
  index stay backed up"); the vault's documents live in `Documents/` and are
  untouched. Proven by
  `native/crates/lighthouse-shell/tests/no_backup_pin.rs` — a real unit test on
  the target set, plus source pins on the two call sites that cannot run in a
  container (the desktop crate has no container-checkable build, and the
  fresh-key ordering is an iOS runtime property), each asserting the safe
  property rather than the presence of code.
  _Residual, accepted — this fix is **not retroactive**._ Any device that
  already ran an iOS build and synced has `secret.key` + `secrets.json` sitting
  in **existing** iCloud/Finder backups, permanently. The patch marks the
  container going forward; it does not regenerate the sealing secret or re-seal,
  so a pre-patch backup stays fully decryptable and every provider API key and
  OAuth refresh token in it stays valid until rotated. **Any credential entered
  on an iOS build before this release should be treated as exposed and rotated
  provider-side.** Second residual: the ObjC glue is silent-no-op by design (six
  early returns on a null class/selector, and `setResourceValue:forKey:error:`'s
  result discarded), and the attribute can only be observed on a device — so a
  missing class, a failed set, and a never-reached call are indistinguishable in
  CI. The call site now writes one `shell.log` line recording how many targets
  it attempted, which distinguishes "never ran" from "ran"; it does **not**
  prove the attribute landed. In steady state the container mark is the only
  thing protecting either file (`secret.key` does not exist at first boot so it
  is skipped, and `secrets.json` loses its xattr on every `set_provider_key`),
  with no fallback if directory propagation ever does not hold.
  _Owner-visible consequence:_ excluding the container means an iOS
  restore-to-new-device **loses investigations, boards, pins, chat history and
  the signed-in profile**. That is what `add-mobile-apps/design.md:104-107`
  specified, but it should be stated plainly in the release note.

## 2026-08-01 — Updater: identity binding + a staging path the manifest can't pick

- **An update signature bound bytes but not identity — forced downgrade** —
  _High._ `update_now` installed anything whose BYTES verified under the pinned
  key. Every artifact this project has ever shipped stays validly signed
  forever, so whoever can write the release channel (CI `GITHUB_TOKEN`, a
  maintainer PAT, compromised CI — the adversary
  `docs/auto-updater-design.md` §2 already names, **no key compromise needed**)
  could re-upload v0.10.0's installer with its own genuine `.sig` under a tag
  reading `v9.9.9`: it verified perfectly, silently re-arming every bug fixed
  since, while the banner read the higher version. `check_for_updates` did
  compare versions — but against the release **tag**, an attacker-chosen string
  bound to nothing, and `update_now` never re-asserted it.
  **Fix:** the release's **signed** manifest is the identity binding.
  `lighthouse_core::updates::authorize_update` requires `latest.json` +
  `latest.json.sig` to verify under the pinned key, its version to be strictly
  newer than the RUNNING build (re-asserted at install, `env!("CARGO_PKG_VERSION")`,
  not only at check time) and not below a persisted monotonic floor
  (`<app-data>/updates/install-floor.json`), and the manifest to NAME the asset
  being installed — the bytes are then verified against the signature that
  manifest attests. `desktop-release.yml`'s `updater-manifest` job now signs the
  manifest and uploads `latest.json.sig`; a release without it is notify-only.
  Proven by `native/crates/lighthouse-core/tests/updater_downgrade_test.rs`
  (the gate) and `test/updaterAuthorizesVersion.test.mjs` (the shell wiring —
  the desktop crate has no container-checkable build, so the call site is a
  source pin). Docs: `docs/signing.md` "Release manifest — the identity
  binding", `docs/auto-updater-design.md`, `docs/data-flows.md` §3a.
  _Residual, accepted:_ a monotonic-version scheme with no manifest freshness
  still permits a **freeze** — replaying a genuine intermediate release while
  withholding the newest — which is only marginally stronger than withholding
  updates outright, something no client-side check can prevent. The banner also
  still shows the attacker-chosen tag until the refusal fires. A local write to
  `install-floor.json` is a quiet update DoS (a huge floor blocks every future
  release), which is the already-discounted local-attacker class.

- **The manifest's asset name was used verbatim as the staging path** —
  _High._ `let dest = dir.join(&name);` then `File::create(&dest)` — the one
  filesystem write an unverified, remote-controlled document influenced, because
  it necessarily runs BEFORE the minisign gate (you cannot verify bytes you have
  not written). `pick_update_asset` is no defence: it constrains only the
  SUFFIX, so `/etc/cron.d/lighthouse.exe` and `../../../x.AppImage` are perfectly
  valid "assets" — an absolute name discards the staging dir outright and a `..`
  walks out of it, turning "download to app-data" into create-truncate (and, on
  the failure arms, `remove_file`) of any path the user can write, with **no
  signing key required**.
  **Fix:** `lighthouse_core::updates::staging_path` derives the path locally —
  the manifest may contribute at most one plain filename (no separator of either
  flavour, no NUL, exactly one `Component::Normal`, so `RootDir`/`Prefix`/
  `ParentDir`/`CurDir` are all refused). Anything else is `None` and
  `update_now` degrades to notify-only like every other failure arm. Note a
  lexical `starts_with` on the JOINED path is not a fix — `<dir>/../x` does
  start with `<dir>`; the component rule is the gate. Proven by
  `native/crates/lighthouse-core/tests/update_staging_test.rs` (which
  demonstrates the pre-fix write escaping a sandbox as a control) and
  `test/updateStagingPath.test.mjs` (the call site).
  _Residuals, advisory:_ (a) a symlink pre-planted inside `<app-data>/updates`
  under the exact asset name is still followed by `File::create` — that needs
  the user's own privileges, the discounted local-attacker class, and nothing
  remote can plant one there; (b) on Windows, names with trailing dots/spaces
  (`".. "`, `"x.exe."`) are accepted by the rule but Win32 resolves them to the
  staging dir's parent, a directory — `File::create`/`DeleteFileW`/read all
  fail, so the signature gate never passes and it degrades to the page;
  (c) DOS device names (`NUL`, `CON`, `LPT1`) open the device, read back empty,
  and fail verification. All three fail closed.

## 2026-08-01 — External-open seam: scheme allowlist + provenance (v0.14.20)

- **Answer links reached the OS browser with no scheme or host allowlist, no
  destination shown, and no egress record** — _High._ `src/lib/openExternal.ts`
  forwarded any string to `plugin:opener|open_url`. `ANSWER_HTML_SCHEMA` drops
  the remote-LOADING tags but leaves `a[href]` navigable, and ChatPanel forwards
  every non-citation href to the seam, so prompt-injected document content could
  render an ordinary-looking link whose query string carried figures out of
  OTHER files in the same context — one click, no cloud provider involved, and
  local-only marks did not cover it. The device-code sign-in hand-off
  (`SettingsMenu.tsx:680`) fed the seam a `verificationUri` straight out of a
  remote response, so a hostile/MITM reply chose the scheme.
  **Fix:** the seam parses the URL and serves `https:` and `mailto:` only
  (refusing `javascript:`/`data:`/`file:`/`blob:`/scheme-relative/unparseable
  BEFORE a transport is chosen, so the window.open fallback cannot carry them),
  hands the transports the string it validated (`url = parsed.href`, closing the
  WHATWG-vs-RFC-3986 authority differential — a raw `https://github.com\@evil.example/`
  is host `github.com` to `new URL` and host `evil.example` to every OS-side
  opener, so the prompt would name one host and the browser open another),
  and takes provenance as an argument: `"app"` opens directly; anything else —
  the default a forgetful call site gets — is `https:` only and must first clear
  a prompt NAMING THE HOST. Proven by `test/openExternal.test.mjs`.
  _Scope, stated plainly:_ (a) the allowlist is narrower than the sanitizer, so
  `http:`, `mailto:` and the other sanitizer-permitted schemes appearing in an
  answer now go **silently inert in-shell** — the click does nothing and the
  user sees no signal; (b) React `onClick` does not fire on middle-click (that
  is `auxclick`), and the answer anchor keeps `href` + `target="_blank"`, which
  the desktop shell routes to the OS browser — so a **middle-clicked answer
  link still bypasses the seam entirely**; closing that means editing ChatPanel
  and breaking the pinned `openExternal(href);` shape, so it is deferred;
  (c) on plain web ChatPanel never calls the seam at all
  (`if (href && isDesktopShell())`); (d) known remaining seam bypasses, all
  app-authored constants rather than answer content:
  `SettingsMenu.tsx:1823` (lhvault.app), `SettingsMenu.tsx:716` and
  `OnboardingPanel.tsx:460` (`provider.apiKeyUrl` via `<Link target="_blank">`),
  and `UpdateNotice.tsx:181` (the releases page). Line numbers are post-fix.
  _Follow-up (deferred, unproven in-container): record the destination in the
  egress registry under its own purpose — needs a new wire op in all three
  dispatchers plus the Rust twin — and consider dropping non-relative `href`
  from `ANSWER_HTML_SCHEMA` so answer links render inert with the host shown._

---

## 2026-08-01 — Analytics SQL surface: guard caps, keyword offsets, card cost

Three findings from the same red-team sweep, all on `analytics.rs` — the door
every executed query goes through. Each is proven by a test that fails (or
SIGABRTs) on the pre-fix tree.

- **`guard_sql`'s read-only walk was unbounded-recursive** — _High._
  sqlparser parses `a UNION b UNION c …` as a LEFT-DEEP `SetExpr::SetOperation`
  spine in a **loop** (`parse_remaining_set_exprs`), so its own recursion counter
  (`DEFAULT_REMAINING_DEPTH` = 50, the thing that stops `((((SELECT 1))))`) never
  fires; `set_expr_is_read_only` then walked that spine with no depth bound, so
  the model's byte count picked our stack depth. A stack overflow is **not** a
  catchable panic — the runtime SIGABRTs the whole process before the query ever
  executes, with nothing surfaced and nothing `catch_unwind` can hold. Reachable
  from the model's `NEXT_SQL:` reply, a saved view, a semantic metric, and the
  MCP `run_analytics_sql` tool (an MCP client's raw SQL).
  **Fix:** `MAX_SQL_BYTES` (64 KiB) refused **before** the parse — the AST's drop
  glue is recursive too, so a spine that exists at all must be freed one frame at
  a time — and `MAX_QUERY_DEPTH` (64) threaded through `query_is_read_only` /
  `set_expr_is_read_only`. `views::collect_table_names`' dependency walk spends
  the SAME constant (query / set-expr / **table-factor**, the last a second
  unbounded spine `guard_sql` never descends into) and **fails closed** on a
  truncated pass: a partial `reads` list would save a view with an invisible
  dependency. Proven by `tests/sql_depth_guard_test.rs` (SIGABRT pre-fix) and
  `views::tests::table_walk_refuses_a_chain_deeper_than_the_budget`.
  _Twin:_ `views.ts::guardViewSql` mirrors the byte cap only (same value, same
  refusal string, `Buffer.byteLength` so both engines measure the same bytes,
  placed first as it is in Rust); the depth cap has no twin because the TS guard
  and `collectTableNames` are iterative scans with nothing to overflow. Without
  the mirror the TS engine would store a definition the Rust engine then refuses
  at registration — a saved view that silently never resolves.
  _Also closed:_ `propose_metric` was the one remaining `DFParser::parse_sql` on
  this surface that never passed the guard, and it **clones** the parsed body
  (`answer_select`) — a recursive clone plus two recursive drops. It now takes
  the same byte cap (measured: 5.7 MB of `UNION ALL` SIGABRTed with the rest of
  this patch already applied).
  _Residual, measured, NOT closed — the abort class is narrowed, not shut:_
  **expression-operator chains are bounded by neither cap.** `parse_subexpr`
  builds infix chains in a loop just like set operations, and `+1` costs **2
  bytes per AST level** where ` UNION ALL SELECT 1` costs ~19 — so 64 KiB still
  admits a ~32k-deep `Expr::BinaryOp` spine that overflows on **drop**, before
  any walk. Measured on a 2 MiB thread (debug), post-fix: `SELECT 1` + `+1`×16,384
  (32,776 B) returns `Ok`; ×32,762 (65,532 B) SIGABRTs. Lowering `MAX_SQL_BYTES`
  cannot fix this — the data-quality recipe's own worst case is ~25 KB, so any
  value safe on the 512 KiB iOS secondary thread would break a shipped recipe.
  The real fix is a depth-bounded parse or a non-recursive drop, deferred.
  _Also noted:_ the two walks share the constant but not the spend rate (views.rs
  descends three node kinds, `guard_sql` two), so in a narrow band near the
  ceiling a chain can pass the guard and still be refused at save.

- **`extract_sql` sliced the original string on an offset computed from an
  uppercased copy** — _Medium._ `str::to_uppercase` is the full Unicode mapping
  and is **not** byte-length preserving in either direction (`ﬁ`→`FI` shrinks 3
  bytes to 2; `ΐ`→`Ϊ́` grows 2 to 6), so `upper.find("SELECT")` returned an
  offset into a *different* string than `body[at..]` indexes. Measured pre-fix:
  `"Cash ﬂow ﬁgures 📊\n…"` **panicked** (the backward shift landed inside the
  4-byte emoji), killing the ask task with nothing surfaced; `"Identiﬁed proﬁt
  rows:\n…"` silently returned `":\nSELECT a FROM t"`; `"…ανΐ…"` returned
  `"CT a FROM t"`. This is not exotic input — PDF text extraction emits the
  U+FB01/U+FB02 ligatures verbatim in words like "identified", "profit",
  "cash flow", and prose ahead of the SELECT is the norm.
  **Fix:** `body.to_ascii_uppercase()`. Only ASCII bytes move, both keywords are
  ASCII, so `at` is a char boundary in `body` by construction. Fails **closed**:
  it matches a strict subset of what `to_uppercase` matched. Proven by the
  extended `sql_extraction_handles_fences_and_prose`.
  _Behaviour delta, recorded honestly:_ a keyword spelled with a letter whose
  Unicode uppercase is ASCII (`ſelect`, `ıf`) no longer matches. For
  `"ſELECT a FROM t WHERE x=1 UNION SELECT b FROM u"` that moves the result from
  unparseable garbage (guard refused) to `Some("SELECT b FROM u")`, which
  **executes** — still a suffix of the model's own reply starting at a real
  keyword, still inside the untouched read-only `guard_sql` boundary, but it is
  a widening of what runs and should not be recorded as "rejection either way".

- **Uncapped, untimed `COUNT(*)` per registered view** — _Medium._ `table_card`
  runs for EVERY registered table on EVERY analytics ask, and a saved view can be
  arbitrarily expensive while passing every guard we have (`guard_sql` rejects
  writes, not cost — a CROSS JOIN is a perfectly legal read-only definition).
  Both of the card's collects were unbounded.
  **Fix:** a `table_card_within(ctx, table, budget)` seam (production enters
  through the unchanged `table_card`, so no call site moved); both collects take
  the executed path's budget and a miss **skips** the card — every caller already
  degrades on `None`. The count is taken through `.limit(0, Some(MAX_CARD_ROWS+1))`
  and rendered as a floor (`"1,000,000+"`), never a total the engine stopped
  short of. Proven by `table_card_row_counts_stop_at_the_cap` and
  `table_cards_give_up_when_a_view_blows_the_budget`.
  _Scope, stated plainly — this bounds less than it looks like it bounds:_
  (a) `tokio::time::timeout` can only observe its deadline when the wrapped
  future returns `Pending`, and `EnsureCooperative` (`ensure_coop.rs:111`) wraps
  **only leaf or exchange nodes** — verified: no `poll_proceed`/`consume_budget`
  anywhere under `physical-plan/src/joins/` or `/aggregates/`, so `CrossJoinExec`
  and `AggregateExec` consume their whole input inside one non-yielding poll;
  (b) on a `target_partitions == 1` plan there is no `RepartitionExec`/
  `CoalescePartitionsExec` spawn, so that grind runs **inline** in the very task
  `timeout` wraps and the hole is untouched — the fix is a no-op on a 1-vCPU
  host; (c) on multi-core the ask does unblock, but `SpawnedTask::drop`'s
  `abort()` (`common.rs:110`) only lands at an await point, so a timed-out card
  leaves a core pegged — "hangs every later ask" becomes "leaks a runaway grind
  per ask", the same unusable end state, slower; (d) the `LIMIT` cap short-
  circuits a **sequential scan** only, never a blocking aggregate/sort/join;
  (e) `register_group` returning `None` now also fires on timeout, and the
  members fall back into `singles` (`analytics.rs`), where each pays another
  card — worst case ~200 s of added latency per ask before any SQL is planned.
  Left at `QUERY_TIMEOUT_SECS` deliberately (a shorter card-only budget would cut
  that, but risks refusing honest cards on large files); revisit with (a)/(b).

---

## 2026-07-30 — Red-team sweep, Tier A: the nine stated guarantees (v0.14.18)

First run of the `/red-team quick` harness (`.claude/skills/red-team/SKILL.md`).
Method: one adversarial agent per invariant claimed in `SECURITY.md` §"Security
posture", each briefed to falsify it; every finding then faced three independent
skeptics (reachability / existing-control / trust-boundary) prompted to REFUTE,
surviving only on ≥2-of-3 non-refutation. 24 findings proposed, **15 refuted, 9
surviving**. Code under test: `39aac04`, identical to `origin/main` @ 0.14.18.

**NOTHING IN THIS ENTRY IS PATCHED.** This was a report-only run, stopped before
Phase 3 (proof) and Phase 4 (patch) by operator instruction. Every item below is
an open advisory. Provability notes say whether a failing test can be written
in-container.

Baseline honesty: the Rust suites were green (all five container-checkable
crates). The JS suite could **not** be gated — `rehype-raw`/`rehype-sanitize`
were declared but uninstalled at session start, and a subsequent `npm ci`
(which wipes `node_modules` first) failed on a **403 from `cdn.sheetjs.com`**,
where `xlsx` is sourced from a vendor CDN rather than the npm registry. That
host is blocked by egress policy and the tarball is not in the local npm cache,
so `node_modules` could not be restored in that session. JS/TS-side findings
here are therefore **unproven by suite**, not test-backed.

### Confirmed (unanimous — no skeptic could refute)

- **Answer links reach the OS browser with no scheme or host allowlist, no
  destination shown, and no egress record** — High, `src/lib/openExternal.ts:20`
  (control evaded: `src/lib/answerHtml.ts:31`). Adversary: malicious model
  output chained from malicious file content; there is also a deterministic
  sub-case needing no model at all, because the extractive fallback emits
  document passages verbatim into answer markdown. `ANSWER_HTML_SCHEMA` strips
  `img`/`picture`/`source` but leaves `a[href]` navigable; `ChatPanel.tsx:2330`
  treats any non-citation href as external and forwards the raw string to the
  opener, which validates nothing. Impact: one click inside a trusted answer
  can carry chunk text, table data, filenames and figures — **including files
  marked "Private — this device only"**, since that mark only governs what
  reaches a *cloud provider* — to an arbitrary host the user never configured.
  Nothing records the transfer, so the shield still reads "All local" and the
  per-answer audit record attests to zero egress, actively misleading review.
  Works with no cloud provider configured. Notably the zero-click `<img src>`
  variant of exactly this threat was already reasoned about and closed
  (`answerHtml.ts:14-18`), and the offline export path is stricter than the live
  one — the one-click variant is the gap. Fix: allowlist schemes at the single
  `openExternal` choke point, distinguish app-authored from answer-origin hrefs
  and confirm the latter showing the host, record the destination in the egress
  registry, and consider rendering remote answer links as inert text with the
  host displayed. Not provable in-container (JS suite unavailable this run).

- **Update-manifest asset name is used verbatim as the staging path** — High,
  `native/crates/lighthouse-desktop/src/desktop/supervise.rs:802`. Adversary:
  hostile/spoofed update-check response. An absolute path or `..` in the asset
  name yields an arbitrary-file **write**, plus truncate-and-delete of an
  arbitrary user-writable file — both strictly **before** the signature check,
  i.e. entirely outside what the pinned-key gate protects. Escalates toward code
  execution as the user where the cleanup delete is skipped. Fix: never let the
  manifest choose a path — derive the staging filename locally, or reduce to
  `file_name()` and require exactly one `Component::Normal` (the pattern already
  used at `vault.rs:228-244`), asserting the destination stays inside the
  staging dir. Provable in-container.

### Plausible (survived 2-of-3)

- **Audit-log tail truncation and wholesale deletion verify as INTACT** — High,
  `audit.rs:262`. `verify()` has no length or tail anchor and fails **open** on
  a missing file, so dropping the newest N records — or the whole month — is
  certified as intact. This **directly contradicts the written guarantee** that
  deleting a record causes verification to fail. Adversary: synced filesystem /
  backup. Fix: anchor chain length and head outside the log (atomic 0600
  `head.json` carrying `{month, count, last_hmac}`) and fail when the log is
  short, mismatched, or absent while `count > 0`. Provable in-container.

- **Signature binds bytes but not identity — forced downgrade** — High,
  `supervise.rs:725-728`. No version↔artifact binding and no rollback floor, so
  anyone who can publish or edit a release can walk an install back to an older
  *validly signed* build, re-arming everything fixed since, while the UI shows a
  higher version. Adversary: supply chain. Fix: sign a manifest binding version
  + per-asset digest + filename and verify that, or require the minisign trusted
  comment to carry the version and refuse anything not strictly greater than the
  running build; re-assert the comparison inside `update_now`. Provable
  in-container.

- **`guard_sql`'s read-only walk recurses without a depth bound** — High,
  `analytics.rs:1630` (control: `:1602`). A chained-set-operation SELECT
  overflows the stack and aborts the process **before execution** — an
  uncatchable, zero-interaction kill from provider-controlled bytes. Fix:
  flatten the `SetOperation` spine into a work-list or thread an explicit depth
  cap, and refuse over-long SQL up front. Provable in-container.

- **Orphaned curation rule silently re-targets an unrelated folder** — High,
  `vault.rs:1855` (control: `:640`). When an `extN` reference id is recycled, a
  stale rule re-binds to the new folder and implicitly includes every matching
  file, with no per-node flag written and nothing rendering as orphaned — so
  content the user never included becomes searchable and is sent to the
  configured provider as retrieval context. Adversary: synced filesystem. Fix:
  treat reference ids as non-reusable and drop rules scoped to a removed id (the
  mirror of the existing `remap_rule_scopes`). Provable in-container.

- **`extract_sql` slices on an index computed from an uppercased copy** —
  Medium, `analytics.rs:1587`. Non-ASCII text before the SELECT lands on a
  non-char-boundary byte index and panics the ask task, with no error surfaced;
  PDF extraction routinely yields such text. Availability only. Fix: search
  case-insensitively over the original, or use `to_ascii_uppercase` (length
  preserving). Provable in-container.

- **Uncapped `COUNT(*)` per registered view, with no timeout** — Medium,
  `analytics.rs:1323`. One saved model-proposed view (a CROSS JOIN or WITH
  RECURSIVE, both accepted by `guard_sql`) makes *every subsequent ask* hang or
  OOM, opaquely, re-registering on each attempt. Fix: apply the same query
  timeout executed queries get and bound the count via a subquery limit.

- **iOS: sealing secret and sealed store are both inside the device backup** —
  Medium, `lighthouse-desktop/src/lib.rs:367` (control: `state_home.rs:330`).
  The spec'd backup exclusion for `secret.key` was never implemented, so
  provider keys and stored OAuth tokens are recoverable in cleartext from an
  iCloud/Finder backup — no device access, no malware — which is squarely inside
  the documented threat model (casual disk/backup/sync inspection). **Fixed
  2026-08-01** — see the entry at the top of this file. The shipped shape
  differs from what was prescribed here: marking `secret.key` immediately after
  `machine_secret()` creates it does NOT hold on its own, because the attribute
  is an xattr on the inode and `write_atomic`'s temp+rename drops it on every
  rewrite of `secrets.json`. The exclusion is applied to the **app-state
  container** (plus the two files, as defense in depth), which covers both a key
  created later and a file replaced by rename. Not retroactive: credentials
  entered on a pre-fix iOS build are already in existing backups and must be
  rotated provider-side.

### `SECURITY.md` accuracy corrections needed (owner decision — not yet edited)

The sweep found two places where the document claims more than the code
delivers. Left unedited deliberately: public claims about security posture are
the owner's call, and these should land with the fixes.

- §"Security posture" says every non-provider destination is "individually
  disableable". The **update check is not disableable** by any setting, policy
  key, or `force_local_only` — it runs at boot and every 6 hours
  (`desktop/mod.rs:430-438`). This was refuted 0-3 as an *attack* (no adversary
  input reaches it) but stands as a documentation inaccuracy. The in-app privacy
  copy (`SettingsMenu.tsx:1813-1816`) has the same problem, and a clicked answer
  link is an unlisted fourth egress kind.
- The preamble says these invariants are "covered by tests". **Guarantee 8
  (atomic 0600 writes) has no test at all** — no assertion of mode, atomicity,
  or durability exists in `test/*.mjs`, `e2e/`, or `native/crates/*/tests/`. The
  property currently holds (verified on disk in-container: `secrets.json` and
  `secret.key` both 0600, all writers funnelling through one atomic helper) — it
  is simply unpinned. Guarantee 7's only tamper test covers edits, not
  truncation, which is how the audit finding above survived.

### Rejected (15 — refuted; recorded so later runs do not re-litigate)

Kept deliberately terse; each was refuted with code evidence.

- **G1** Update check not disableable — real, but no adversary-controlled input
  reaches it; reclassified above as a doc-accuracy issue, not a vulnerability.
- **G2** Path-keyed include flag never pruned — mechanics confirmed, but the
  described exposure requires the user to re-create a file at a previously
  included path; no adversary entry point.
- **G4** Pre-0.11 plaintext key orphaned in in-vault `profile.json` — the
  history claim is false; no code path, current or historical, produces it.
- **G4** CLI `--vault` drags the key store into the vault — the override is
  idempotent for the only reachable caller; the store never moves.
- **G5/G6** (×4) Unreadable policy fails open; Windows `%ProgramData%`
  re-pointing voids policy — behaviours accurately described, but every actor
  who can supply the input already holds a strictly better primitive by
  executing code as the user, which `SECURITY.md` §Scope excludes.
- **G5** TS-twin policy accepts wrong-typed keys as active — the module is not
  in any shipped artifact (only `app/api/**` route handlers import it).
- **G6** Answer-cache mirror and auto-exported note ignore `history_allowed()` —
  code observation accurate, no reachable adversary entry point of its own.
- **G7** Month rollover restarts the chain at a constant genesis — factually
  correct, but an existing control makes it non-exploitable as stated.
- **G7** CSV export silently drops records the verifier flags — no adversary can
  produce a non-parsing line.
- **G8** Audit append is two write syscalls; 0600 not re-asserted on an existing
  file — both mechanisms verified real (one empirically under `strace`), neither
  reachable by an in-scope adversary.
- **G9** Download leg unconstrained pre-verification (plain http accepted, no
  size cap, whole artifact buffered) — refuted on reachability as framed;
  overlaps the confirmed staging-path finding, which is the exploitable form.

### Ruled out (searched, guarantee holds)

- **G3 read-only analytics — the core claim holds.** No write, second statement,
  or filesystem/network touch could be produced. `guard_sql` is AST-based
  (`DFParser` + `stmts.len() != 1`), so semicolons in literals and comments are
  inert; DataFusion independently refuses multi-statement input. The three G3
  findings above are all availability, not integrity.
- **G4 crypto — solid.** Fresh 12-byte CSPRNG nonce per seal in both engines, no
  counter/fixed IV/derived nonce, re-seal draws a new one; install secret is 32
  CSPRNG bytes stretched with scrypt (N=2^14, r=8, p=1), not derived from
  host/user/machine identifiers.
- **G5 policy — sound.** An empty allowlist denies all (not allow-all) in both
  engines; `forceLocalOnly` intersects restrictively; unknown versions fail
  closed. The one twin divergence (`v:null`) errs restrictive.
- **G6 defaults — both halves hold.** Chat history and telemetry default off at
  every wire edge and in the store; every persistence write re-reads the gate.
- **G7 write-path coverage — safe.** All four answer paths funnel through the
  audited chokepoint, and `finish` fires after the stream drains, so a truncated
  or error-terminated stream still produces a record. A loopback MCP client
  cannot redirect the audit path.
- **G8 secrets/settings writers — solid.** Every writer funnels into the single
  atomic helper, including OAuth token storage; measured 0600 on disk.
- **G9 unsigned-build fallback fails CLOSED** — the main thing attacked. Absent
  `LIGHTHOUSE_UPDATER_PUBKEY`, `update_now` requires pubkey + asset + sig or
  only opens the release page; no branch downloads-and-executes without a key.
  The pre-Phase-B body that did exactly that is confirmed gone, and CI hard-fails
  when signing is expected but absent.
- **G1 egress inventory** — every outbound call site in both engines was
  enumerated and classified; all registered destinations verified metadata-only
  (update check, update/sig download, model download, provider key validation,
  device-code sign-in, Graph calls). The gap was the unregistered one above.

---

## 2026-07-02 — Local-model detection + version badge placement (v0.2.6)

- **Stale/corrupt cached model blocked fresh installs and failed to run.**
  `installedModel()` (localModel.ts) and `findModel()` (main.js) counted any
  `.gguf` ≥100 MB as installed **without validating it's a real model file**, so a
  corrupt/wrong/half-written leftover from a previous version read as "Installed"
  (no install button → "install doesn't happen") and was handed to llama-server
  (→ local model "still failing"). **Fix:** both now require the file to begin with
  the **GGUF magic** ("GGUF"); a non-model file is treated as *not installed*, so
  the install button reappears, a fresh download proceeds, and llama-server is
  never handed junk. Verified live: a 150 MB non-GGUF file → `absent`, a valid
  GGUF-magic file → `ready`.
- **Version badge overlapped the settings gear.** Moved from bottom-left (where the
  settings gear is pinned) to bottom-right, just above the bug-report FAB.

---

## 2026-07-02 — Regression fix: same-origin check broke all mutations (v0.2.5)

- **`isSameOrigin` 403'd the app's own requests** — _High (functional regression I
  introduced in v0.2.4)._ After the loopback-hardening changed the renderer to load
  `127.0.0.1`, the same-origin check compared `Origin.host` to `req.url.host` — but
  Next reports `req.url` host as `localhost`, so the `localhost` vs `127.0.0.1`
  mismatch rejected **every mutating POST** (file inclusion toggle, model install,
  upload, settings) with 403. Users saw file selection and local-model install as
  "broken." **Fix:** require the Origin to be a loopback host on the same port
  (rather than an exact host-string match); still blocks cross-site (non-loopback
  Origin), DNS-rebinding (non-loopback Host), other-loopback-port pages, and
  header-less callers lacking the token. Verified end-to-end + with a unit test
  covering all cases. `src/server/http.ts`.
- **Stale local-model detection** — `main.js findModel()` now requires the same
  ≥100 MB size as the picker's `installedModel()`, so a leftover stub/partial
  `.gguf` from an old install isn't loaded (and doesn't show a dead "Installed").
  With the 403 fixed, uninstall + reinstall now work to clear a cached model.
- **Subtle version badge** added (bottom-left, `NEXT_PUBLIC_APP_VERSION` from
  package.json) so the running build is identifiable.

---

## 2026-07-02 — Auto-updater (Phase A), lint gate, PII verification

- **Auto-updater implemented (Phase A, notify-only)** — `electron/updater.js`,
  `electron/preload.js`, `main.js`, `splash.html`. Checks for updates on launch
  during the splash (non-blocking, 8s-bounded, best-effort), and surfaces an
  "Update available" tray item / splash line that opens the release page. It
  **never downloads or executes an installer in-process** while builds are
  unsigned (electron-updater's hash is integrity, not authenticity). Auto-install
  stays gated behind `UPDATER_CAN_AUTO_INSTALL = false` until code signing +
  notarization land. The privileged "restart to update" IPC is gated to the boot
  window so live app content can't trigger an install. See
  `docs/auto-updater-design.md`.
- **Lint gate is now blocking** — `eslint@^8.57.1` + `eslint-config-next` pinned in
  devDependencies; `next lint` passes clean, so `release.yml`'s check job runs
  `npm run lint` as a hard gate (was advisory / `continue-on-error`).
- **Historical file-name PII purge — verified unnecessary.** Audited the Supabase
  backend (project `yyiqwpcqpohzyrzwyxqk`): the `click_events` table (the only
  place file/folder names were ever sent) is **empty (0 rows)**, as is `events`.
  No file/folder-name PII accumulated server-side, so no purge was needed. (The
  client-side leak was fixed on 2026-07-01; new events send only the coarse kind.)

---

## 2026-07-02 — Release hardening (v0.2.4, branch `feat/release-hardening-0.2.4`)

- **Bundled binaries/model fetched unpinned with no integrity check** — _Medium
  (supply chain)._ `scripts/fetch-local-model.mjs` resolved llama.cpp `latest` and
  the HF voice from `main` with an optional, unset SHA-256, so the executables baked
  into every installer were unverified.
  **Fix:** pin exact versions (llama.cpp `b9859`, piper `2023.11.14-2`, voice commit
  `e21c7de8…`) and verify each asset against a committed `ASSET_SHA256` map; the
  build now **fails closed** on any missing/mismatched digest. `--record` bootstraps
  digests on a version bump. `scripts/fetch-local-model.mjs`.
- **Installers unsigned / un-notarized** — _Medium (trust/UX)._ Added code-signing
  scaffolding that stays inert on unsigned builds and activates automatically once
  cert secrets are provided: `build/entitlements.mac.plist` (hardened-runtime),
  `build/notarize.cjs` (afterSign hook — no-ops without `APPLE_*`), `mac`
  hardenedRuntime/entitlements, and conditional signing env in `release.yml`
  (`CSC_IDENTITY_AUTO_DISCOVERY` gated on `secrets.CSC_LINK`). Certs are still
  required from the maintainer to actually sign; see `docs/auto-updater-design.md`
  §3 for the key-custody caveat (prefer cloud/HSM signing over a raw cert in CI).
- **Auto-updater** — designed (not yet implemented): `docs/auto-updater-design.md`
  — launch-time, splash-integrated, `electron-updater`, **notify-only while
  unsigned** (no in-process download/execute of unverifiable installers), flipping
  to auto-install only once signing + notarization are live.

---

## 2026-07-01 — Review remediation (branch `security/harden-review`)

Source: full multi-agent security + code-quality review of `origin/main` (v0.2.3),
adversarially verified. 43 findings triaged; the items below were fixed in code.

### Local API surface

- **Local API was reachable off-machine and failed open** — _High._
  `next start` bound to `0.0.0.0`, exposing every unauthenticated file/link/open
  route to the LAN, and `isSameOrigin()` returned `true` whenever the `Origin`
  header was absent (any curl/script/other-process bypassed it).
  **Fix:** bind the server to `127.0.0.1` only (`-H` + `HOSTNAME`); require a
  per-launch token (injected by the desktop shell) for header-less callers; add a
  loopback **Host allowlist** to defeat DNS rebinding; pin the top frame with a
  `will-navigate` guard. `electron/main.js`, `src/server/http.ts`.

- **Aggregate upload size was unbounded** — _Low (DoS)._ Added a 200 MB
  per-request cap on top of the existing per-file/count caps. `app/api/upload/route.ts`.

### Privacy & telemetry

- **Private file/folder names were sent to the vendor as "anonymous"** — _High._
  The file-tree click-capture logged `node.name`, shipped to the hosted usage
  endpoint keyed to the user's email + contact id.
  **Fix:** log only the coarse `folder`/`file` kind, never the name.
  `src/features/explorer/FileExplorer.tsx`.

- **Usage telemetry was opt-out and mislabeled** — _High (privacy/consent)._
  Capture defaulted to on and the checkbox said "anonymous."
  **Fix:** capture now defaults to **opted out**; the checkbox is unchecked by
  default with an accurate label (email + feature usage, never files/names/
  contents); a trial mint resets to opted-out; the explicit choice is persisted
  on both register and skip. `usage.ts`, `OnboardingPanel.tsx`, `license.ts`.

### Licensing & payments (Supabase Edge Function — requires deploy)

- **License forgery via public default secret + row-less token trust** — _Medium
  (revenue)._ `aesKey()` fell back to a source-committed default when
  `LICENSE_SECRET` was unset, and `check()` derived paid/trial standing from the
  token's own claims when no DB row existed.
  **Fix:** fail closed when `LICENSE_SECRET` is unset (handler degrades to a
  controlled error / offline grace, never a forgeable "valid"); require an
  authoritative DB row to grant entitlement — never trust decoded token claims for
  a row-less guid. `supabase/functions/license/index.ts`.
  _Takes effect on `supabase functions deploy license`; `LICENSE_SECRET` must be
  set first (it is)._

### Credentials & secrets at rest

- **State/credential files written world-readable and non-durably** — _Medium._
  `writeJson` used default perms and no fsync (OAuth tokens, model API key,
  curation state).
  **Fix:** write with owner-only `0600` perms + fsync data and directory.
  `src/server/config.ts`.

- **Microsoft OAuth tokens stored in the cloud-synced Documents vault** — _Medium._
  Long-lived refresh/access tokens (tenant-wide read scope) lived under the vault,
  which defaults to Documents (OneDrive/iCloud synced, backed up).
  **Fix:** store connector tokens in the app's private `userData` dir via
  `LIGHTHOUSE_CONNECTORS_DIR`. `config.ts`, `electron/main.js`.
  _Follow-up: full OS-keychain encryption (Electron `safeStorage`) needs a
  main-process IPC path — the Next server runs as plain Node._

### Connectors, model & build

- **Graph bearer token could be replayed to arbitrary URLs** — _Info._
  Paging follow-on URLs from Graph responses were fetched with the token attached.
  **Fix:** only ever send the token to `*.graph.microsoft.com`.
  `src/server/sources/microsoft/graph.ts`.

- **Prompt injection from retrieved document content** — _Low._ Retrieved text was
  concatenated into the LLM prompt with no instruction/data separation.
  **Fix:** fence context blocks and mark them untrusted in the system prompt.
  `src/server/llm.ts`.

- **PowerShell command injection in the build-time archive extractor** — _Low._
  An archive/asset name containing a `'` could break out of the `Expand-Archive`
  quotes. **Fix:** escape single quotes. `scripts/fetch-local-model.mjs`.

- **Installer could bundle runtime secret-state** — _Low._ Added electron-builder
  excludes for `.rag-vault/connectors`. `package.json`.

### Quality gates

- **No CI gate; `npm test` ran only the typechecker** — _High (quality)._
  Releases built + published with no typecheck/test/lint step.
  **Fix:** `release.yml` gains a `check` job (typecheck + tests hard-gate, lint
  advisory) that `build` depends on; `npm test` now runs the real suite; added a
  committed `.eslintrc.json`. _Follow-up: pin `eslint`/`eslint-config-next` and
  make lint blocking._

### Known / deferred (tracked, not yet fixed)

Open advisories from the 2026-07-30 red-team sweep (full detail in that entry;
all unpatched, none proven by a failing test yet):

- **Update-manifest asset name is the staging path** (High, `supervise.rs:802`) —
  pre-verification arbitrary file write / truncate.
- **Audit truncation and deletion verify as intact** (High, `audit.rs:262`) —
  contradicts the stated tamper-evidence guarantee; needs an external length+head
  anchor.
- **No version↔artifact binding in update signing** (High,
  `supervise.rs:725-728`) — forced downgrade to an older validly signed build.
- **Expression-operator chains overflow the stack on drop** (High,
  `analytics.rs::MAX_SQL_BYTES`) — the narrowed remainder of the fixed
  "`guard_sql` walk is unbounded-recursive". `SELECT 1+1+1…` costs 2 bytes per
  AST level, so the 64 KiB cap still admits a ~32k-deep spine that SIGABRTs in
  recursive drop glue before any walk runs (measured post-fix: 32,776 B `Ok`,
  65,532 B abort, 2 MiB thread). Not fixable by lowering the cap; needs a
  depth-bounded parse or a non-recursive drop. See the 2026-08-01 entry.
- **A timed-out table card keeps running** (Medium, `analytics.rs::table_card`) —
  the other narrowed remainder: the card's budget is unobservable on a
  single-partition plan (runs inline) and `abort()` only lands at an await point,
  which DataFusion's join/aggregate operators do not have. See the 2026-08-01
  entry, scope items (a)-(e).
- **Recycled `extN` reference id re-targets a stale curation rule** (High,
  `vault.rs:1855`) — implicit inclusion of never-included files.
- **iOS backup exclusion never implemented** (Medium, `lib.rs:367`) — sealing
  secret + sealed store both inside the device backup.
- **`SECURITY.md` overclaims in two places** — the update check is not
  disableable, and guarantee 8 has no test; see that entry for exact wording.
- **`xlsx` is installed from `cdn.sheetjs.com`, not the npm registry** —
  outside registry provenance and `npm audit` coverage, and blocked by some
  egress policies (it broke a `npm ci` in this session). Supply-chain surface;
  belongs to a Tier-B sweep.

- **Installers ship unsigned/un-notarized** — SmartScreen/Gatekeeper blocks; needs
  signing certs in CI.
- **Model/binary downloads unpinned, no checksum** — supply-chain; pin version +
  commit SHA-256s.
- **npm audit: 12 advisories** — all in the build toolchain (electron-builder →
  tar/cacache/node-gyp), dev-time only, not shipped; resolve via a deliberate
  electron-builder bump.
- **Entitlement is client-side/honor-system** — server-side enforcement needs
  offline-verifiable (asymmetric-signed) licenses to avoid breaking offline use.
