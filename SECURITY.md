# Security policy

Lighthouse is a local-first desktop app: your files are indexed and answered on
your own machine, and nothing leaves it unless you choose a cloud AI provider.
Security is the product, so we take reports seriously.

## Supported versions

Lighthouse ships on the **0.11.x** line; the latest published release is the only
supported version. Fixes ship in a new patch release (`0.11.x`), delivered
through the in-app updater. There is no back-porting to older builds — update to
the latest.

| Version | Supported |
|---|---|
| Latest `0.11.x` | ✅ |
| Anything older | ❌ (update via the in-app updater) |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **"Report a vulnerability"** button under this
repository's **Security** tab (Security Advisories → private reporting). That
keeps the report confidential until a fix ships and lets us collaborate on the
advisory.

What to include:

- What you found and where (component, file, version).
- Steps to reproduce, or a proof of concept.
- The impact you believe it has.

What to expect:

- An acknowledgement within a few business days.
- An honest assessment of severity and a fix timeline.
- Credit in the advisory and release notes if you'd like it (and coordinated
  disclosure once a fixed release is out).

> **Maintainer TODO (provision before public launch):** GitHub private
> vulnerability reporting must be enabled for this repo (Settings → Code
> security → Private vulnerability reporting). If a dedicated security contact
> address is preferred over GitHub advisories, add it here. Until then, the
> Security-tab flow above is the only supported private channel.

## Scope

In scope — the shipped desktop app and its engine:

- The Rust engine (`native/crates/lighthouse-core`, `-server`, `-desktop`) and
  the UI it serves.
- Encrypted secret storage (provider API keys), the managed-policy layer, the
  egress registry, the local audit log, the licensing/activation path, and the
  signed auto-updater.
- Local privilege / data-exposure issues: reading files outside the vault,
  bypassing the read-only analytics guard, decrypting stored keys without the
  install secret, forging or silently editing audit records, defeating the
  managed policy's fail-closed behavior.

Out of scope:

- Findings that require an attacker already running code as your OS user (the
  encrypted-key threat model is explicit about this — see below).
- The marketing site and unrelated third-party services.
- Vulnerabilities in upstream dependencies without a Lighthouse-specific
  exploit path (report those upstream; we track them via the dependency-audit
  CI gate and update).

## Security posture (what the app guarantees)

These are invariants, enforced in both engines and covered by tests:

- **Local-first by default.** Document content leaves the machine only via a
  cloud AI provider you explicitly configure. Every other network destination
  is metadata-only and individually disableable — see `docs/data-flows.md`.
- **Default-excluded inclusion.** Newly seen files are not searchable until you
  include them (or opt into include-by-default at onboarding).
- **Read-only analytics.** The analytics path executes a single validated
  `SELECT` against a read-only view — no writes, no multi-statement SQL.
- **Encrypted key storage.** Provider API keys are sealed with AES-256-GCM under
  a per-install secret, stored in the app-state dir (not in `profile.json`, not
  in vault backups). Threat model: this defeats casual disk/backup/cloud-sync
  inspection, **not** malware running as your user (`native/.../secrets.rs`).
- **Managed policy fails closed.** A malformed machine policy restricts to
  local-only providers with telemetry and history off, rather than failing open
  (`docs/managed-deployment.md`).
- **Opt-in telemetry and chat history**, both default off; lock-not-wipe when an
  org policy disables them.
- **Tamper-evident audit log** (opt-in or policy-forced): one HMAC-chained local
  record per answered question; editing or deleting a record breaks verification
  (`openspec/changes/add-audit-log/design.md`).
- **Atomic 0600 state writes** for secrets, settings, and the audit log.
- **Verified updates.** Update manifests are checked against a pinned minisign
  public key before install (`docs/signing.md`).

## Related

`docs/data-flows.md` · `docs/managed-deployment.md` · `docs/edr-whitelisting.md`
· `docs/signing.md`
