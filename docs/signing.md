# Code signing & verified updates — state and provisioning checklist

*Written with the Phase-0 foundation pass. Everything below is wired into
`desktop-release.yml` and the shell, gated on secrets: absent secrets → a
cleanly unsigned build with a notify-only updater; present secrets → signed
installers, minisign-signed update artifacts, and in-app verified updates.
Nothing is ever half-signed: each leg gates independently and partial
configuration fails the build loudly.*

## What is already wired (no certs needed to keep working)

| Leg | Mechanism | Gate |
|---|---|---|
| macOS Developer-ID signing + notarization + stapling | Tauri v2 native (`APPLE_*` env) + `bundle.macOS.entitlements` (`entitlements.plist` — JIT + unsigned-dylib loading for llama) | `APPLE_CERTIFICATE` secret non-empty |
| Windows Authenticode | `.pfx` imported to the runner store, thumbprint passed via `--config bundle.windows.certificateThumbprint`; sha256 digest + DigiCert timestamp preconfigured in `tauri.conf.json` | `WINDOWS_CERTIFICATE` secret non-empty |
| Update-artifact signing | `createUpdaterArtifacts` → minisign `.sig` beside each installer, uploaded to the release; fan-in job aggregates `latest.json` (tauri-updater manifest) | `TAURI_SIGNING_PRIVATE_KEY` secret non-empty (+ `LIGHTHOUSE_UPDATER_PUBKEY` variable, else the build fails on purpose) |
| Updater Phase B (download + authorize + verify + install-on-consent) | Shell picks the platform's update asset (`lighthouse-core::updates::pick_update_asset` — the pure per-platform table), downloads installer + `.sig` + the release's SIGNED manifest (`latest.json` + `latest.json.sig`), **authorizes** against the manifest (`lighthouse-core::updates::authorize_update`: manifest verifies under the pinned key → its version is strictly newer than the RUNNING build and not below the persisted floor → it names this exact asset), verifies the bytes with the compile-time-baked pubkey against the signature the manifest attests (`lighthouse-core::updates::verify_update_signature`), only then installs. macOS unpacks the verified `.app.tar.gz` and swaps the running bundle **in place** (fail-closed: an unwritable location or a bad archive restores the old bundle and falls back to the `.dmg`); Windows/Linux hand the verified installer to NSIS / the AppImage | pubkey baked at build (`LIGHTHOUSE_UPDATER_PUBKEY`) AND the release carries a `.sig` AND a signed `latest.json` + `latest.json.sig` |
| CI co-presence gate | `desktop-release.yml` asserts, per signed platform, that every uploaded installer carries its `.sig` and no `.sig` orphans its installer — a missing signature would otherwise drop that platform from `latest.json` silently | `TAURI_SIGNING_PRIVATE_KEY` secret non-empty (inert on unsigned builds) |
| Notify-only fallback | Without a baked key or a `.sig`, the Update button reads "Get it" and opens the releases page. On Linux a `.deb`-only release is likewise notify-only (no in-place path). **The old behavior of executing an unverified download was removed** (auto-updater-design §2: unverified auto-apply is an RCE hand-off) | automatic |

## Release manifest — the identity binding

*Added by the 2026-08 red-team sweep ("forced downgrade", High).*

A minisign signature binds **bytes to the key**. It says nothing about which
VERSION those bytes are. So anyone who can write the release channel — the CI
`GITHUB_TOKEN`, a maintainer PAT, compromised CI: the adversary
`docs/auto-updater-design.md` §2 already names, **no key compromise required** —
could re-upload an old release's installer together with its own still-valid
`.sig` under a new tag. The check compared against the (unsigned, attacker-
chosen) tag, the asset picker matched by filename suffix, the signature verified
because it was genuine, and the app installed a superseded build — re-arming
every fix since — while the banner read the higher version.

**The fix, and the choice made.** Two designs were on the table: put the version
in the minisign *trusted comment* (which is authenticated), or sign a manifest.
We sign the manifest. Tauri's bundler generates the trusted comment itself
(`timestamp:…\tfile:…`) with no way to set it, so the first option would mean
re-signing every artifact with a raw `minisign` binary on all three runners —
and the macOS updater archive (`Lighthouse.app.tar.gz`) carries no version in
its filename at all, so macOS would fail closed forever.

- `latest.json` already carries the release `version` and, per platform, the
  asset `url` plus the **minisign signature of that asset's bytes**. The
  `updater-manifest` job now signs the manifest with the same updater key and
  uploads `latest.json.sig` beside it (§54: the signed-release format changed,
  and the CI job moved with it).
- The shell authorizes every install against that pair
  (`lighthouse-core::updates::authorize_update`): the manifest must verify under
  the pinned key; its version must be **strictly newer than the running build**,
  re-asserted at install time (`env!("CARGO_PKG_VERSION")`), not only at check
  time; the manifest must **name the asset filename** being installed; and the
  artifact's bytes are then verified against the signature that manifest
  attests. Bytes ⇄ key ⇄ manifest ⇄ version are one chain. (The per-asset
  signature is the byte commitment here — strictly stronger than a sha256, and
  it costs the fan-in job no downloads.)
- A **monotonic floor** (`<app-data>/updates/install-floor.json`) records the
  highest version this install ever authorized; anything below it is refused, so
  a superseded release cannot be re-offered even after a manual rollback. The
  same version can still be retried after a failed install.
- **Fails closed:** a release without `latest.json.sig` is notify-only ("Get
  it"). Releases published before this landed are therefore notify-only — the
  same one-time transition as the first keyed build below, and inert today
  because no key is provisioned yet.
- Guarded by `native/crates/lighthouse-core/tests/updater_downgrade_test.rs`
  (the gate) and `test/updaterAuthorizesVersion.test.mjs` (the shell wiring —
  the desktop crate has no container-checkable build).
- **Residual, accepted:** this is a monotonic-version scheme with no manifest
  freshness/expiry, so an adversary with release-channel write can still
  **freeze** a client at a genuine intermediate release (replay v0.12.0's real
  triple while withholding v0.15.0). It is only marginally stronger than
  withholding updates outright, which no client-side check can prevent. The
  banner also still shows the attacker-chosen tag until the refusal fires.

## Maintainer checklist — what to provision

### 1. Updater signing key (free, do this first)

```
npx --yes @tauri-apps/cli@^2 signer generate -w updater.key
```

- Repo **secret** `TAURI_SIGNING_PRIVATE_KEY` — the full content of `updater.key`.
- Repo **secret** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password you set (empty string if none).
- Repo **variable** (not secret — it's public) `LIGHTHOUSE_UPDATER_PUBKEY` — the content of `updater.key.pub`.
- **Custody:** keep an offline copy of `updater.key`. Losing it means shipped
  builds (which bake the pubkey) will refuse every future update signature —
  recoverable only by users manually reinstalling a build with the new key.
  Treat a leak as critical: a leaked key + GitHub write access = valid
  malicious updates.

### 2. macOS — Apple Developer Program (US$99/yr)

1. Enroll at developer.apple.com; create a **Developer ID Application**
   certificate; export it (with private key) as `.p12`.
2. Repo secrets:
   - `APPLE_CERTIFICATE` — `base64 -i cert.p12`
   - `APPLE_CERTIFICATE_PASSWORD` — the `.p12` export password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
   - `APPLE_ID` — the account email
   - `APPLE_PASSWORD` — an **app-specific password** (appleid.apple.com → Sign-In & Security)
   - `APPLE_TEAM_ID` — the 10-char team id
3. Tauri then signs with hardened runtime + our entitlements, notarizes via
   notarytool, and staples — no workflow change needed.

### 3. Windows — Authenticode (choose one)

- **Preferred: Azure Trusted Signing** (~US$10/mo, key never leaves Azure,
  survives CI compromise). Requires an Azure tenant + Trusted Signing account
  with identity validation. To switch the workflow to it, replace the
  thumbprint overlay with a `signCommand` overlay, e.g.
  `{"bundle":{"windows":{"signCommand":{"cmd":"trusted-signing-cli","args":["-e","https://eus.codesigning.azure.net","-a","<account>","-c","<profile>","%1"]}}}`
  and add the `AZURE_*` credential secrets.
- **Implemented default: OV certificate as `.pfx`** (simplest to start; the
  design doc calls it acceptable-but-migrate). Repo secrets:
  - `WINDOWS_CERTIFICATE` — `base64` of the `.pfx`
  - `WINDOWS_CERTIFICATE_PASSWORD` — its password
  Note: many CAs now issue OV certs only on hardware tokens/cloud HSMs, in
  which case Azure Trusted Signing is the pragmatic route anyway.

### 4. After provisioning — verify one release end-to-end

1. Dispatch `desktop-release.yml`; confirm in logs: cert import, notarization
   ("processing complete"), `.sig` uploads, `updater-manifest` job green.
2. Artifacts: `signtool verify /pa Lighthouse-Setup.exe` on Windows;
   `spctl -a -t open --context context:primary-signature Lighthouse_*.dmg`
   and `xcrun stapler validate` on macOS; release carries `latest.json` **and
   `latest.json.sig`**, plus `*.sig` for exe / AppImage / `.app.tar.gz`.
3. In-app: install the previous release built WITH the pubkey, publish the
   new one, and confirm the sidebar banner's button reads **Update** (not
   "Get it") and completes install after the verification log line
   `update artifact signature verified`. A release missing `latest.json.sig`
   must correctly read "Get it" instead — that is the downgrade gate failing
   closed, not a bug.

### First-signed-release transition (one-time)

Builds shipped **before** the pubkey existed have no key baked in — they stay
notify-only and users click through to the releases page once. Every install
from the first keyed build onward updates in-app with verification. Plan the
release notes accordingly.

## Related docs
- `docs/auto-updater-design.md` — the original (Electron-era) design; its §2
  threat model and §8 transition analysis still govern.
- `docs/data-flows.md` — the updater's network touchpoints.
