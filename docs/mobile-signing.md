# Mobile code-signing & store delivery (fastlane + match)

Signing for the iOS/Android apps (`app.lhvault`) is managed by **fastlane
`match`** (Apple) and an **upload keystore** (Android). Every credential lives
in **GitHub repo secrets** — nothing sensitive is committed. This doc lists the
secrets and the one-time bootstrap.

The bundle/app identifier is **`app.lhvault`** across desktop, iOS, and Android
(unified in 0.12.8).

## GitHub repo secrets (Settings → Secrets and variables → Actions)

### Apple (App Store Connect API key + match)
| Secret | What it is / where to get it |
|---|---|
| `APP_STORE_CONNECT_KEY_ID` | The API **Key ID** (App Store Connect → Users and Access → Integrations → App Store Connect API). |
| `APP_STORE_CONNECT_ISSUER_ID` | The **Issuer ID** from the same page. |
| `APP_STORE_CONNECT_KEY_P8` | The `.p8` private key, **base64-encoded** (`base64 -i AuthKey_XXXX.p8 \| pbcopy`). This is the real secret — download it once at creation; Apple won't show it again. |
| `APPLE_TEAM_ID` | 10-char Team ID (Developer portal → Membership). |
| `MATCH_GIT_URL` | **HTTPS** URL of a separate PRIVATE git repo that stores the encrypted certs, e.g. `https://github.com/lmansf/lighthouse-certs.git`. Do NOT use this repo. |
| `MATCH_PASSWORD` | A passphrase you choose; encrypts the certs in the match repo. Store it in your password manager. |
| `MATCH_GIT_TOKEN` | A fine-grained PAT with **Contents: read/write** on the certs repo. The CI derives the base64 git auth (`base64(user:token)`) from this — you only store the raw token. |

`APP_STORE_CONNECT_KEY_P8_BASE64` defaults to `1` (base64); set to `0` only if
you store the raw `.p8` text instead.

### Android (later — when the Play org account is ready)
| Secret | What it is |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the upload keystore (`.jks`). |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | keystore/key credentials. |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play service-account JSON (Play Console → API access). |

## One-time bootstrap — the `mobile-bootstrap` workflow (no local setup)

The macOS-gated steps run on a GitHub macOS runner via the manual
`mobile-bootstrap` workflow (`.github/workflows/mobile-bootstrap.yml`) — no
Xcode / Ruby / Rust needed on your machine.

1. **Create the private certs repo** (once): an empty PRIVATE GitHub repo, e.g.
   `lmansf/lighthouse-certs`; set `MATCH_GIT_URL` to its https URL and add a
   `MATCH_GIT_TOKEN` PAT (Contents: read/write on that repo).
2. Add all the Apple + match secrets in the table above.
3. **Actions → mobile-bootstrap → Run workflow**, `task = both`. It runs
   `fastlane ios certs` (creates the Distribution cert + profile for
   `app.lhvault` and stores them encrypted in the certs repo) and
   `tauri ios init` (generates `gen/apple` and commits it to the branch it ran
   on). Both are safe to re-run.
4. Android: `tauri android init` + the Play secrets come later, once the Play
   org account exists.
5. From then on the build lanes (`fastlane ios beta` / `android beta`) run with
   `MATCH_READONLY=1` to build + upload to TestFlight / Play internal testing.

## Troubleshooting

- **`Authentication credentials are missing or invalid` (during `fastlane match` / `ios certs`)** —
  the App Store Connect **API key** was rejected by Apple. `match` reaching this
  point means the certs repo, git token, and `MATCH_PASSWORD` are all fine; only
  the Apple key is wrong. Almost always one of:
  1. `APP_STORE_CONNECT_KEY_ID` and `APP_STORE_CONNECT_KEY_P8` are from **different
     keys** (e.g. a new key was generated for a fresh `.p8` but the Key ID secret
     still holds the old id). They must be the **same** key.
  2. The key was **revoked** in App Store Connect → Users and Access → Integrations
     → App Store Connect API. Generate a new one and update **both** secrets.
  3. `APP_STORE_CONNECT_KEY_P8` isn't clean base64 of the raw `.p8` (extra
     newlines, or double-encoded). Re-encode: `base64 -i AuthKey_XXXX.p8 | pbcopy`.
  The `mobile-bootstrap` workflow runs a preflight that structurally validates the
  Key ID (10 chars), Issuer ID (UUID), and that the `.p8` decodes to a PKCS#8
  private key — so if that preflight passes but `match` still fails auth, it's #1
  or #2 (a semantic mismatch Apple rejects, not a formatting problem).
- **`input ruby-version needs to be specified`** — pinned to `3.3` in the workflow;
  don't remove it (there's no `.ruby-version` in the repo).
- **A secret "is definitely set" but reads empty in CI** — it's an *Environment*
  secret, not a *Repository* secret, or it's in the wrong repo. All 7 live in
  **`lmansf/lighthouse`** (the repo that runs the workflow), as Repository secrets.
- **`Authentication credentials are missing or invalid` even when the triple is
  self-consistent** — the App Store Connect key is an **Individual** key, not a
  **Team** key. Only Team keys authenticate with an Issuer ID (which `match`
  uses). Create the key under Integrations → App Store Connect API → **Team
  Keys** (role **App Manager**) and set all three secrets from it.
- **`Could not create another Development certificate, reached the maximum`** —
  Apple caps an account at 2 Development certs. The `certs` lane no longer makes
  one (App Store builds need only the Distribution cert); if you hit this via
  `dev_certs`, revoke an unused Development cert in the Developer portal first.

## Building the iOS app (after the bootstrap)

The `mobile-bootstrap` workflow gained two more tasks once certs + `gen/apple`
landed:

- **`task = ios-build`** — builds the **signed App Store `.ipa`** on a macOS
  runner (match readonly → manual signing on the committed Xcode project →
  fastlane gym; the Rust lib compiles inside Xcode's "Build Rust Code" phase)
  and uploads it as a workflow artifact. Works even before the App Store
  Connect app record exists — use it to prove the build.
- **`task = ios-beta`** — same build, then uploads to **TestFlight**. Requires
  the app record (below). The build number is the workflow run number, so every
  upload is unique; the marketing version comes from `package.json`.

## App Store Connect app record (one-time, manual)

The App Store Connect **API cannot create app records** (and neither can the
uploader), so this is a one-time manual step in the web UI:
[appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **My Apps** →
**+** → **New App**: platform **iOS**, name **Lighthouse**, bundle ID
**app.lhvault** (already registered on the Developer Portal by `match`), any
SKU (e.g. `lighthouse-001`), primary language. After that, `ios-beta` uploads
land in TestFlight.
