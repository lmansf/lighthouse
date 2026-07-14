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
| macOS Developer-ID signing + notarization + stapling | Tauri v2 native (`APPLE_*` env) + `bundle.macOS.entitlements` (`entitlements.plist` — JIT + unsigned-dylib loading for llama/piper) | `APPLE_CERTIFICATE` secret non-empty |
| Windows Authenticode | `.pfx` imported to the runner store, thumbprint passed via `--config bundle.windows.certificateThumbprint`; sha256 digest + DigiCert timestamp preconfigured in `tauri.conf.json` | `WINDOWS_CERTIFICATE` secret non-empty |
| Update-artifact signing | `createUpdaterArtifacts` → minisign `.sig` beside each installer, uploaded to the release; fan-in job aggregates `latest.json` (tauri-updater manifest) | `TAURI_SIGNING_PRIVATE_KEY` secret non-empty (+ `LIGHTHOUSE_UPDATER_PUBKEY` variable, else the build fails on purpose) |
| Updater Phase B (download + verify + install-on-consent) | Shell downloads installer + `.sig`, verifies with the compile-time-baked pubkey (`lighthouse-core::updates::verify_update_signature`), only then hands off to the OS/NSIS | pubkey baked at build (`LIGHTHOUSE_UPDATER_PUBKEY`) AND the release carries a `.sig` |
| Notify-only fallback | Without a baked key or a `.sig`, the Update button reads "Get it" and opens the releases page. **The old behavior of executing an unverified download was removed** (auto-updater-design §2: unverified auto-apply is an RCE hand-off) | automatic |

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
   and `xcrun stapler validate` on macOS; release carries `latest.json`,
   `*.sig` for exe / AppImage / `.app.tar.gz`.
3. In-app: install the previous release built WITH the pubkey, publish the
   new one, and confirm the sidebar banner's button reads **Update** (not
   "Get it") and completes install after the verification log line
   `update artifact signature verified`.

### First-signed-release transition (one-time)

Builds shipped **before** the pubkey existed have no key baked in — they stay
notify-only and users click through to the releases page once. Every install
from the first keyed build onward updates in-app with verification. Plan the
release notes accordingly.

## Related docs
- `docs/auto-updater-design.md` — the original (Electron-era) design; its §2
  threat model and §8 transition analysis still govern.
- `docs/data-flows.md` — the updater's network touchpoints.
