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

## App Store Connect app record

Create the **Lighthouse** app in App Store Connect (My Apps → +) tied to
`app.lhvault` before the first TestFlight upload — or let the first
`upload_to_testflight` create it via the API key.
