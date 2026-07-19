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
| `MATCH_GIT_URL` | URL of a **separate PRIVATE git repo** that stores the encrypted certs (e.g. `git@github.com:lmansf/lighthouse-certs.git`). Do NOT use this repo. |
| `MATCH_PASSWORD` | A passphrase you choose; encrypts the certs in the match repo. Store it in your password manager. |

`APP_STORE_CONNECT_KEY_P8_BASE64` defaults to `1` (base64); set to `0` only if
you store the raw `.p8` text instead.

### Android (later — when the Play org account is ready)
| Secret | What it is |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | base64 of the upload keystore (`.jks`). |
| `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | keystore/key credentials. |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play service-account JSON (Play Console → API access). |

## One-time bootstrap (runs on macOS — I can't from the Linux dev env)

Prereqs on the Mac: Xcode, Rust + `tauri-cli`, Ruby + `bundle install` (uses the
repo `Gemfile`), and the Apple secrets exported as env vars.

1. **Create the private match repo** (once): make an empty private GitHub repo,
   e.g. `lmansf/lighthouse-certs`, and set `MATCH_GIT_URL` to it.
2. **Generate + store the certs** (from the repo root):
   ```sh
   bundle exec fastlane ios certs
   ```
   This creates the Distribution cert + App Store provisioning profile for
   `app.lhvault` and commits them encrypted to the match repo. Safe to re-run.
3. **Generate the native projects** (§2.2):
   ```sh
   npm run tauri ios init
   npm run tauri android init   # needs the Android SDK/NDK
   ```
   Commit the generated `gen/apple` and `gen/android` trees.
4. From then on, CI (macOS runner for iOS) runs `bundle exec fastlane ios beta`
   / `android beta` with `MATCH_READONLY=1` to build + upload to TestFlight /
   Play internal testing.

## App Store Connect app record

Create the **Lighthouse** app in App Store Connect (My Apps → +) tied to
`app.lhvault` before the first TestFlight upload — or let the first
`upload_to_testflight` create it via the API key.
