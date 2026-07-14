# Maintainer provisioning & decisions — persona roadmap (Phases 0–2)

This is the one place that answers: *"What must I, the maintainer, decide or
provision before the security-director and data-analyst features are fully
live?"* Everything below is **fail-closed today** — the app builds, runs, and
passes every gate without any of it; each item only unlocks a capability that
genuinely needs an account, a certificate, a key, or a product decision. Exact
secret/variable names live in the referenced docs (single source of truth); this
report is the map, not a second copy.

## TL;DR

- **Phase 2 (data analyst) needs nothing provisioned.** PDF tables, briefings,
  cross-conversation recall, and the richer charts are 100% on-device and
  self-contained — no accounts, keys, or certs. Ship as-is.
- **Phase 1 (security director) has four provisioning items**, all optional and
  fail-closed: code signing, offline activation, the keychain feature, and the
  cargo-audit triage.
- **Three product decisions** are yours: trial length, whether paid is offered
  (`PAID_ENABLED`), and the seat/volume model for organizations.

---

## Product decisions

### 1. Trial policy
The trial is **14 sign-in days** (`TRIAL_DAYS` in `src/server/license.ts` and
`native/crates/lighthouse-core/src/license.rs`, kept in sync). A "sign-in day"
is a distinct UTC day the user opened the app, not 14 calendar days — so an
occasional user gets a fair trial. **Decide** whether 14 is right for these
personas (an enterprise evaluator may want 30). Changing it is a one-line edit
in both engines.

### 2. Whether paid is offered — `PAID_ENABLED`
Off by default: with `PAID_ENABLED` unset, the app is **trial-only and the
subscribe UI stays hidden** (`paid_enabled()` / `paidEnabled()`). To sell
subscriptions you must both flip `PAID_ENABLED=1` **and** stand up the licensing
backend — the hosted license function (`LICENSE_API_URL`), checkout
(`CHECKOUT_API_URL`), and their `SUPABASE_ANON_KEY` / `LICENSE_SECRET`. Until
then the money path is intentionally inert. See `docs/registration.md`.

> **Invariant:** paid must not open on unsigned installers. Provision code
> signing (below) *before* enabling paid, or paid activation on an unsigned
> build is correctly refused.

### 3. Seat / volume model for organizations (security-director persona)
There is **no multi-seat or volume-licensing product yet** — the license model
is per-user (a stable contact id, one trial/subscription). The enterprise-ready
path already built is **offline activation** (P1.5): the maintainer holds an
Ed25519 keypair and mints a signed license file per machine, so managed fleets
activate with **no phone-home**. **Decide** the seat story:
- **(a) Offline license files per seat** — use the offline-activation mechanism
  below; you mint one signed file per device/seat. Works today once the pubkey
  is provisioned.
- **(b) Hosted volume licensing** — not built; would extend the license function
  with seat counts. A larger piece of work, flagged here, not started.

---

## Provisioning items (Phase 1)

### A. Code signing & notarization — `docs/signing.md`
macOS Developer-ID + notarization + stapling, Windows Authenticode, and updater
minisign signatures are all **scaffolded and secrets-gated in CI** — the release
workflow signs only when the corresponding repo secrets are non-empty, and
otherwise produces an honestly-unsigned build. Provision the secrets documented
in `docs/signing.md` to ship signed installers and a working auto-updater.
**Blocks:** signed distribution, the updater, and (by the invariant above) the
paid path.

### B. Offline activation pubkey — `docs/managed-deployment.md`,
`openspec/changes/add-offline-activation/`
Set `LICENSE_OFFLINE_PUBKEY` to the base64 Ed25519 **public** key whose private
key you hold; the engine then verifies license files signed with it. **Empty or
unset ⇒ offline activation is disabled (fail-closed)** — the verify path is inert
until you provision the key, so nothing can be spoofed in the meantime. Once set,
mint per-machine files as documented. This is the mechanism behind seat option
(a) above.

### C. OS-keychain sealing key — `native/crates/lighthouse-core/src/secrets.rs`
The vault's sealing key defaults to a file under app state. An optional,
**default-off** cargo feature `keychain` (`--features keychain`, pulls in
`keyring`) stores it in the OS keychain instead. It is off by default because
the desktop crate can't be exercised in the dev container; **verify it on each
target OS** (macOS Keychain, Windows Credential Manager, libsecret on Linux)
before enabling it in a shipping build. Threat model and fallback order
(keychain → file → generate) are documented at the `machine_secret()` call site.

### D. cargo-audit triage — `.github/workflows/supply-chain.yml`,
`native/audit.toml`
The supply-chain gate ignores four advisories
(`RUSTSEC-2026-0204/0187/0194/0195`) with written rationale in
`native/audit.toml` (all transitive, no fixed version available, not reachable
from our usage). **Phase 2 added zero new dependencies** (no `Cargo.toml`,
`package.json`, or lockfile change), so the audit surface is identical to P1 —
no new triage needed. Re-review these on each dependency bump; drop an ignore
the moment an upstream fix lands.

---

## Phase 2 features — provisioning: none

For completeness, and because it's the happy answer: the data-analyst features
in this phase require **no maintainer action at all**.

| Feature | Runs on | Needs provisioning? |
| --- | --- | --- |
| Fast private answers (GPU probe, speculative decoding) | bundled local model | No |
| PDF table reconstruction | on-device geometry (`pdf_tables.rs`) | No |
| Briefings (pinned-question reports) | local DataFusion (`briefings.rs`) | No |
| Cross-conversation recall | client-side, opt-in history only | No |
| Richer charts (area, sortable, pin mini-charts) | client SVG from verified data | No |

All are local-first and fail-closed by construction (e.g. recall is empty when
chat history is off; a PDF table is emitted only when the geometry is
unambiguous). Nothing here phones home or needs a key.
