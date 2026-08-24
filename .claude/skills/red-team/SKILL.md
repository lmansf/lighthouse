---
name: red-team
description: Adversarial security sweep of Lighthouse — a team of agents tries to FALSIFY the invariants SECURITY.md claims, verifies each finding against refutation, proves it with a failing test, then patches minimally. Use for a periodic security pass, before a release, after a new attack surface lands (file ingest, IPC command, updater, network call), or when the user asks to red-team / pentest / audit / harden the app. For a single diff use /security-review instead.
---

# Red team: falsify the guarantees, then fix what breaks

A repeatable adversarial sweep. Its yield comes from one discipline: **do not
go looking for "bugs" in general — go trying to break the specific promises
this app makes in writing**, then extend to the surfaces that have no promise
yet.

Run it as: `/red-team` (standard), `/red-team quick`, `/red-team full`, or
`/red-team <surface>` (one surface, e.g. `/red-team updater`).

---

## 0. Rules of engagement (read first, every run)

**Authorized target: this repository and the app it builds, running locally.**
Lighthouse is the operator's own software. That authorization does not extend
one inch further.

Hard boundaries — never cross these, even if a finding "would be easier to
prove" that way:

- **No traffic at third-party infrastructure.** Never send attack, fuzz, or
  probe traffic to GitHub, Apple, Anthropic/OpenAI/provider APIs, update
  hosts, or any host you do not own. Test against local fixtures, loopback,
  and mocked responses. Reading public documentation is fine.
- **No live-service DoS**, no mass scanning, no credential testing against
  real accounts. Resource-exhaustion findings are demonstrated against a
  local instance with a bounded fixture, and reported as local-crash/hang.
- **No weaponized artifacts committed.** A regression test asserting the safe
  behavior is the deliverable. Never commit a reusable exploit, a working
  payload generator, or a malicious binary. A minimal malformed *fixture* is
  fine when a test needs one; keep it inert, small, and commented as a
  security fixture.
- **No secrets exfiltrated or printed.** If a finding involves a real key in
  the environment, report the path and the class, never the value. Redact.
- **Nothing is auto-merged.** Security patches stop at a PR for human review.
  Never push to `main`.
- **No disclosure actions.** Do not open public issues, post advisories, or
  contact anyone. Report to the operator in the repo.

If a finding can only be proven by crossing one of those lines, write it up as
an **unproven advisory** with the reasoning and the test that *would* prove it.
An honest advisory beats an out-of-bounds proof.

---

## 1. Trust boundaries (this is what kills false positives)

Lighthouse is **local-first, single-user, no accounts, no server**. The most
common failure mode of an automated security sweep here is reporting the
user's own legitimate access as a vulnerability. Before writing any finding,
place it on this map.

**NOT vulnerabilities in this app** (do not report; `SECURITY.md` §Scope
already declares most of them out of scope):

- The user can read their own vault / their own data on their own disk.
- Anything requiring an attacker to already execute code as the user's OS
  account (this is the *explicit, documented* threat model for encrypted key
  storage — malware as your user defeats it by design).
- Plaintext-at-rest of data the user themselves supplied and can already open.
- Upstream dependency CVEs with no Lighthouse-specific exploit path (those go
  to the dependency-audit gate, not here).
- The marketing site or unrelated third-party services.

**Real adversaries in this threat model** — every finding should trace to one:

1. **Malicious file content.** A CSV/XLSX/PDF/OCR'd document the user opens.
   The attacker controls bytes, cell text, filenames, and sheet names — not
   the user's machine. This is the primary untrusted input.
2. **Malicious model output.** Whatever a model returns (cloud or on-device)
   is untrusted text that flows into SQL, the DOM, file paths, and tool calls.
3. **Malicious network responses.** A hostile or MITM'd response to an update
   check, provider call, or model download — including a downgrade or a
   truncated/oversized body.
4. **Other local processes / apps on the device.** Anything reachable on
   loopback (the on-device model bridge, the local API) is reachable by other
   apps and, on iOS, by other apps on the device.
5. **The supply chain.** Dependencies, GitHub Actions workflows, build-time
   secrets, the signing/update path.
6. **A shared or synced filesystem.** iCloud/OneDrive-synced directories,
   backups, and multi-user machines — data placed somewhere it shouldn't be.

---

## 2. Targets

### Tier A — falsify the nine stated guarantees (always run)

`SECURITY.md` §"Security posture" claims these are *invariants, enforced in
both engines and covered by tests*. Each is a hypothesis to attack. For each:
find the enforcement point, find the test, then hunt for the path that evades
both — a code path that bypasses the check, a twin that lags (Rust vs
`src/server/`), an input shape the validator does not model, or an
error/fallback branch that fails **open**.

1. **Local-first by default** — document content leaves only via an explicitly
   configured cloud provider; every other destination is metadata-only.
   *Attack:* find any path that puts document bytes, chunk text, filenames, or
   vault contents into a request the user did not configure — including error
   reporters, telemetry, update checks, model downloads, and URL previews.
   Existing pins: `test/egress.test.mjs`, `src/server/egress.ts`.
2. **Default-excluded inclusion** — new files are not searchable until
   included. *Attack:* a path that marks a file included implicitly.
3. **Read-only analytics** — a single validated `SELECT` against a read-only
   view; no writes, no multi-statement SQL. *Attack:* multi-statement
   smuggling, comment/CTE tricks, DDL/DML that passes the validator, DataFusion
   built-ins that touch the filesystem or network, `COPY`/`read_csv`-style
   table functions, path traversal via a table/file reference, and injection
   originating in *model output* or in *file content* (a cell containing SQL).
   Also: query cost — an unbounded join/regex that hangs or OOMs the app.
4. **Encrypted key storage** — AES-256-GCM under a per-install secret, in the
   app-state dir, never in `profile.json` or vault backups. *Attack:* a key
   that leaks into logs, crash output, chat history, exports, the audit log, a
   backup, or a debug command; nonce reuse; a fallback that stores plaintext
   when sealing fails. Existing pin: `test/secrets.test.mjs`.
5. **Managed policy fails closed** — malformed policy ⇒ local-only, telemetry
   and history off. *Attack:* a malformed/partial/hostile policy shape that
   fails *open*, or a parse error that skips enforcement entirely.
6. **Opt-in telemetry and chat history, default off; lock-not-wipe.**
   *Attack:* a path that records either while off, or wipes when it should
   lock. Existing pin: `test/localOnly.test.mjs`.
7. **Tamper-evident audit log** — HMAC-chained; editing/deleting breaks
   verification. *Attack:* forge or truncate the chain, re-key it, or find a
   write path that skips chaining.
8. **Atomic 0600 state writes** for secrets, settings, audit log. *Attack:*
   a non-atomic or wider-mode write, a temp file left behind with the payload,
   a symlink/TOCTOU race on the target path. Existing pin:
   `test/stateGuard.test.mjs`.
9. **Verified updates** — manifests checked against a pinned minisign key.
   *Attack:* signature-verification bypass, verify-after-use ordering, TOCTOU
   between verify and install, **downgrade/rollback** to an older signed
   version, a manifest that passes with an unexpected asset URL, and the
   unsigned build's fallback behavior (does absent-key fail closed to
   notify-only, or open to install-unverified?). See `docs/signing.md`,
   `supervise.rs::update_now`, roadmap §54.

### Tier B — surfaces with no stated guarantee yet (standard + full)

10. **Prompt injection via untrusted documents.** File content reaches the
    model; model output reaches SQL, the DOM, report files, and (on desktop)
    shell/file operations. Trace ingest → prompt → output → *sink*. The
    question is not "can a document contain instructions" (it can) but **what
    the injected instruction can reach**. Check that the number-verification
    ladder (`numguard.rs`, `findings_number_set`) can't be talked out of
    verifying, and that meta-channel/tool directives can't be spoofed from
    document text.
11. **Webview XSS → IPC escalation.** In a Tauri webview, HTML injection is
    not just XSS: it borders 34 `#[tauri::command]`s. The CSP ships
    `script-src 'self' 'unsafe-inline'` plus
    `dangerousDisableAssetCspModification` for script-src/style-src — so an
    injection has an unusually good day. Audit every path where document text
    or model output becomes markup (markdown renderer, chart specs, table
    cells, filenames, report preview, SVG). `innerHTML`/
    `dangerouslySetInnerHTML` are currently absent from `src/` — **confirm and
    pin that**, and check the markdown/chart renderers for raw-HTML passthrough
    and `javascript:`/`data:` URLs in links and images.
12. **The Tauri command surface (34 commands).** For each: is it reachable
    from webview JS, does it validate its arguments, and can a path argument
    escape the vault/app-data dirs (`..`, absolute paths, symlinks, UNC,
    long-path, unicode normalization)? Special attention to `upload_file`,
    `vault::add_file`, anything taking a path or a URL, anything that opens or
    executes, and the `openExternal` opener (a `file:`/`javascript:`/custom
    scheme reaching it).
13. **iOS / mobile data-at-rest and platform.** §39 flagged `.rag-vault`
    living inside the user-visible, **iCloud-synced** Documents directory —
    assess and report it properly. Also: the loopback on-device model bridge
    (`PrivateModelServer.swift`) — what binds it, can another app on the
    device reach it, is there any origin/token check; deep-link handling
    (`RunEvent::Opened`, `CFBundleURLTypes`) as untrusted input; state
    placement (roadmap §41); entitlements.
14. **Local HTTP API surface.** What listens, on which interface, with what
    origin/CSRF posture. `docs/security-fixes.md` records a prior same-origin
    regression — re-verify it, and confirm binding is loopback-only, never
    `0.0.0.0`.
15. **Supply chain / CI.** Workflow triggers (`pull_request_target` +
    untrusted checkout is the classic), secret exposure in logs, overly broad
    `permissions:`, unpinned third-party actions, script injection via
    `${{ github.event.* }}` in `run:` blocks, and the release/signing jobs.
16. **Denial of service, local.** Zip bombs, pathological CSV/XLSX, huge
    cells, deep nesting, catastrophic regex, unbounded memory in extraction or
    chunking, and the `CACHE_VERSION` paths. Bounded fixtures only.

`quick` = Tier A only. `standard` = Tier A + 10–13. `full` = everything.

---

## 3. Pipeline

Run the phases in order. Fan out within a phase; do not skip the gates
between them — the gates are what make the output trustworthy.

**Phase 0 — Baseline (one agent).** Record the commit SHA and confirm a clean
tree. Run the full suites (`npm test`, and `cargo test -p lighthouse-core
-p lighthouse-shell -p lighthouse-cli -p lighthouse-server -p lighthouse-mcp`
— note that `lighthouse-desktop` does not compile in the dev container) and
confirm **green before starting**, so any red test later is attributable to
this sweep. Read `SECURITY.md`, `docs/security-fixes.md` (including its
"Known / deferred" section — that is the ledger), `docs/CONVENTIONS.md`, and
`CLAUDE.md`. Abort if the baseline is already red; report that instead.

**Phase 1 — Adversarial fan-out (one agent per target).** Each agent owns
exactly one numbered target and is briefed as an attacker with a goal, not a
reviewer with a checklist: *"Your job is to break guarantee N. Find the
enforcement point, then find the input or code path that evades it."*

Each agent returns structured findings; every finding must carry:
- `target` (the number above) and `title`;
- `file:line` of the vulnerable code **and** of the control it evades;
- **the adversary** (which of the six from §1) and **the entry point** — how
  attacker-controlled data physically reaches this code;
- **the attack narrative**: concrete input → path taken → security impact;
- what an attacker *gains* (the impact must cross a trust boundary);
- proposed minimal fix, and whether a test can prove it in-container.

Agents that find nothing return an empty list and say what they ruled out —
"nothing found" from a real search is a useful result and belongs in the
report. Forbid speculation: no finding without a reachable entry point.

**Phase 2 — Refutation gate (parallel, per finding).** Every finding faces
independent skeptics **prompted to refute it**, each with a distinct lens:
- *Reachability:* can attacker-controlled data actually reach this line? Show
  the call chain from an entry point, or refute.
- *Existing control:* does a validator, type, test, or platform behavior
  already stop this upstream?
- *Trust boundary:* does the impact cross a boundary from §1, or is it the
  user's own access / out-of-scope per `SECURITY.md`?

Default to refuted when uncertain. A finding survives only on a majority
non-refutation, and carries its verdict (`CONFIRMED` / `PLAUSIBLE`) forward.
Then **dedup against the ledger**: drop anything already recorded as
rejected-with-reason in `docs/security-fixes.md` unless the underlying code
changed since. This is what keeps repeat runs from re-litigating the same
noise.

**Phase 3 — Proof before patch (the hard gate).** For each surviving finding,
write a test that **fails on current code** and demonstrates the unsafe
behavior — house conventions: `test/*.test.mjs` (node runner) for TS/UI,
`#[test]` in the relevant crate for Rust. Structural/source pins are
acceptable only where behavior genuinely cannot run in-container (the
`chartIt`/`keyboardCenter` precedent), and then the pin must assert the
*safe* property, not merely that code exists — §39's lesson: unit pins prove
existence, not connection.

**No failing test ⇒ no patch.** Such a finding is recorded as an advisory
with its proposed fix and why it isn't provable here (needs a device, needs a
signed build, needs a network peer). This gate is what prevents phantom
fixes.

**Phase 4 — Patch, minimally.** One commit per finding. The smallest change
that makes the red test green — no refactors, no drive-by cleanups, no new
dependencies without an explicit justification line. Respect the house rules:
byte-identical prompts/labels across the Rust/TS twins with PARITY comments;
`CACHE_VERSION` moves in lockstep across its three sites; no
analytics/telemetry/accounts; SharePoint plumbing dormant, never removed.
Prefer failing **closed**. After each patch, re-run the full suites — a
security fix that breaks a behavior test is not done. If the correct fix is
architectural (can't be minimal and safe), stop: leave it as an advisory with
a design sketch rather than shipping a hack.

**Phase 5 — Report and PR.** Append one dated entry to
`docs/security-fixes.md` in its existing format
(`## YYYY-MM-DD — <title> (vX.Y.Z)`) containing:
- **Patched** — finding, severity, adversary, `file:line`, the fix, the test
  that now guards it.
- **Advisories (not patched)** — with why, and the proposed fix. Keep these in
  the "Known / deferred" section so the next run dedups against them.
- **Rejected** — findings that failed the refutation gate, one line each with
  the reason. This is the ledger's memory; without it every run re-reports
  them.
- **Ruled out** — surfaces searched with nothing found.
- If any stated guarantee in `SECURITY.md` turned out to be **weaker than
  claimed**, say so plainly and correct the wording there. An invariant the
  code doesn't hold is worse than an undocumented one.

Then open ONE PR titled `Security: red-team sweep <date>` and **stop**. Never
merge. If a finding is severe (a broken Tier-A guarantee with a working
attack path), lead the PR body with it and say so in the reply to the
operator.

### Severity rubric (state it, don't vibe it)

- **Critical** — breaks a Tier-A guarantee with a reachable path from
  malicious file content, model output, or a network response; or yields code
  execution / key disclosure.
- **High** — same classes but requiring an unusual precondition, or a data
  path that sends document content off-device unexpectedly.
- **Medium** — evades a control without direct data loss (fail-open branch,
  missing validation with a bounded impact), or local DoS.
- **Low** — hardening, defense-in-depth, missing pin on a property that
  currently holds.
- **Advisory** — real but unproven here, or architectural.

---

## 4. Team shape and cost

Use the `Workflow` tool so the fan-out is deterministic and the phases
pipeline (findings verify as soon as their finder returns, rather than waiting
on the slowest surface). Reasonable defaults:

- Finders: one agent per target — 9 (`quick`), 13 (`standard`), 16 (`full`).
- Refuters: 3 per finding, distinct lenses, on a strong reasoning tier — this
  is where quality is won or lost; don't cheapen it.
- Prover/patcher: one agent per confirmed finding; worktree isolation
  (`isolation: 'worktree'`) when several patch in parallel so they don't
  collide on shared files.
- Synthesizer: one agent writes the report from the structured results.

Mind the session's workflow-size guideline — `quick` fits comfortably; `full`
will exceed a 15-agent cap, so either raise the cap deliberately or run
Tier A and Tier B as two sequential sweeps. Log anything dropped for budget:
a silently truncated sweep reads as "we checked everything" when it didn't.

Cheaper tiers are fine for mechanical enumeration (listing commands, globbing
workflows). Keep the exploit reasoning, the refutation panel, and the patch
work on the strongest available model.

---

## 5. Anti-patterns (each of these has bitten a sweep like this)

- **Reporting the user's own access as a breach.** Re-read §1.
- **A patch with no failing test.** Unfalsifiable, and often fixes nothing.
- **A "fix" that only adds a test.** If the behavior was unsafe, change the
  behavior.
- **Refactoring under a security banner.** Minimal diffs review well; large
  ones hide regressions.
- **Fixing one engine and not its twin.** Rust and `src/server/` both ship.
- **Trusting a validator you didn't read.** Find the enforcement line.
- **Severity inflation.** It destroys the operator's ability to triage; the
  rubric is there to be used.
- **Re-reporting rejected findings every run.** Dedup against the ledger.
- **Committing a working exploit.** Ship the guard, not the weapon.
