# Maintainer provisioning & decisions — persona roadmap (Phases 0–2)

> **Historical (superseded).** The accounts, licensing, trial, and paid-
> subscription decisions in "Product decisions" below were **removed** —
> Lighthouse now has no accounts, is always unlocked, and the Supabase backend
> is gone. Kept as roadmap history; the provisioning items (code signing, the
> OS-keychain sealing key, cargo-audit triage) remain accurate. If a paid tier
> ever returns it will use offline signed license files + a Stripe payment link
> — no accounts, no Supabase; see **[docs/data-flows.md](data-flows.md)**.

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
- **The product-model decisions are settled** (below): no accounts, no trial,
  always unlocked. If a paid tier ever returns it is offline signed license
  files + a payment link — no accounts, no Supabase. The single thing left to
  provision for that path is the license-file signing key.

---

## Product decisions — settled

These were open questions during the persona roadmap; they are now **resolved**.
The code that implemented the old answers (accounts, trial counting, the hosted
license function, checkout) is **removed from the shipping tree and archived**
on `archive/licensing-supabase`, so it can be revived without being rewritten.
Recorded here so the reasoning isn't lost.

### 1. Accounts and trial — none; the app is always unlocked
There is no account, no sign-in, no trial clock, and no license check. The app
unlocks on first run and stays unlocked; switching vaults never re-locks it.
Nothing about entitlement ever leaves the machine. (The former 14-sign-in-day
trial and its per-day counter are gone. To take the hosted backend down without
locking older clients still in the field, follow
[`docs/server-decommission.md`](server-decommission.md) — a dead endpoint
degrades to at worst a locked UI, never a data wipe.)

### 2. Paid, if it ever returns — offline signed license files + a payment link
No accounts and no Supabase, then or ever. The mechanism is already designed and
**archived, not discarded**: the maintainer holds an Ed25519 keypair and mints a
signed license file per machine (openspec `add-offline-activation`,
`docs/managed-deployment.md`; the verifying engine code lives on
`archive/licensing-supabase`). A future "buy" link would point at a plain
payment page (e.g. a Stripe payment link) that emails the signed file — the app
itself still phones nowhere. **The one open item is standing up the signing**
(provisioning the keypair + a mint step); everything else is ready to revive.

> **Invariant (still holds if paid returns):** paid must not open on unsigned
> installers. Provision code signing (below) *before* re-enabling paid, or
> activation on an unsigned build is correctly refused.

### 3. Organizations / seats
Per-machine signed license files (option above) cover managed fleets with **no
phone-home** — mint one file per device/seat. A hosted volume-licensing product
was never built and would reintroduce a backend; it stays explicitly out of
scope.

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

### B. Offline activation — `docs/managed-deployment.md`,
`openspec/changes/add-offline-activation/`
The design and deployment steps stay in-tree, but the **engine verify code was
removed with the rest of licensing** and is preserved on
`archive/licensing-supabase`; restore it from there before this is live. Once
restored, set `LICENSE_OFFLINE_PUBKEY` to the base64 Ed25519 **public** key
whose private key you hold and the engine verifies license files signed with it.
**Empty or unset ⇒ disabled (fail-closed)** — the verify path is inert until you
provision the key, so nothing can be spoofed in the meantime. This is the paid /
managed-fleet mechanism referenced under Product decisions (§2–§3).

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
