# Managed deployment — policy.json for IT administrators

*Ships with the managed-policy layer (openspec: add-managed-policy). This
page is for the person deploying Lighthouse across an organization.*

## What it is

A single machine-scope `policy.json`, owned by the administrator, that
overrides user preferences where set. The **engine enforces every key
server-side** — a blocked provider is refused at the model-call chokepoint,
not hidden in a menu — and affected controls render disabled with
"Managed by your organization".

| OS | Path |
|---|---|
| Windows | `%ProgramData%\Lighthouse\policy.json` |
| macOS | `/Library/Application Support/Lighthouse/policy.json` |
| Linux | `/etc/lighthouse/policy.json` |

The file is read once at app launch (changes apply at next launch — the
standard GPO/MDM contract). No file ⇒ no restrictions. A malformed file
**fails closed**: local-only providers, telemetry and chat history off, and
the UI shows a managed-configuration error.

## Example policy

```json
{
  "v": 1,
  "allowedProviders": ["local", "anthropic"],
  "telemetry": "off",
  "chatHistory": "off",
  "widgetHotkeys": "off",
  "auditLog": "on",
  "vaultRoots": ["C:\\CorpVaults", "D:\\Data\\Vaults"]
}
```

## Key reference (v1 — all keys optional)

| Key | Values | Effect |
|---|---|---|
| `allowedProviders` | subset of `local`, `anthropic`, `openai`, `google`, `xai`, `mistral`, `deepseek` | Only listed providers can be selected or called. A pre-existing profile naming a blocked provider still answers — via the on-device extractive path, never the cloud. |
| `forceLocalOnly` | `true` | Shorthand for `allowedProviders: ["local"]`. If both keys are set, the intersection applies (a contradictory policy is restrictive). |
| `telemetry` | `"off"` | Silences the launch ping, funnel events, click-event batches, and experiment assignment. The license `check` and explicit user submissions (feedback / bug report) remain — see docs/data-flows.md §2. |
| `chatHistory` | `"off"` | Conversations are never persisted; the toggle locks. Existing saved chats are not deleted (lock-not-wipe). |
| `widgetHotkeys` | `"off"` | The Whisper keyboard hook and the summon shortcut are **never installed** (relevant to EDR posture — see docs/edr-whitelisting.md). |
| `ocr` | `"off"` | Image/scan text extraction is disabled (returns empty, uncached — flipping policy later re-reads with no cache surgery). |
| `notifications` | `"off"` | The app emits no OS notifications. |
| `auditLog` | `"on"` | Forces the local audit log on and locks the preference. One local, 0600, HMAC-chained JSONL record per answered question — files read, provider, and the hosts that question dialed — written under the app-state `audit/` dir and never uploaded; editing/deleting a record breaks verification from that point. Record shape + tamper model: docs/data-flows.md §9 and `openspec/changes/add-audit-log/design.md`. |
| `vaultRoots` | list of absolute path prefixes | The vault folder and linked files/folders must live under one of these prefixes (symlinks resolved; prefix matches only at path-component boundaries — `/srv/vaults` does not admit `/srv/vaults-evil`). A stored vault outside the roots is not applied at boot; the app falls back to an allowed location, files untouched. |

Unknown keys are ignored (forward compatibility). Unknown `v` values fail
closed.

## Distributing the file

The policy is plain JSON at a fixed path — any configuration-management
channel works:

- **Windows (Intune/GPO):** deploy to `%ProgramData%\Lighthouse\policy.json`
  via a Win32 app payload, a PowerShell script policy
  (`New-Item -Force C:\ProgramData\Lighthouse; Set-Content …\policy.json`),
  or GPP Files. Ensure the ACL leaves the file writable by
  `Administrators`/`SYSTEM` only (the ProgramData default).
- **macOS (Jamf/MDM):** a package or script writing
  `/Library/Application Support/Lighthouse/policy.json` (root-owned, 644).
- **Linux:** configuration management of `/etc/lighthouse/policy.json`
  (root-owned, 644).

Silent/fleet installation flags are documented below in §Silent / fleet
installation.

## Offline activation (air-gapped / managed licensing)

Deployments with no outbound network — or that don't want per-machine license
calls — can activate paid mode from a **signed license file** the engine
verifies locally. No hosted license function is contacted.

**How it works.** The engine reads a minisign-signed license next to the machine
policy (`license.lic`), verifies it against a **pinned license public key** baked
into the build, and if the signature is valid and the license is unexpired,
grants paid status. It is the top authority in `checkLicense` — but strictly
additive: an absent, malformed, expired, or unverifiable file grants nothing and
**never locks** a user (the app falls back to its normal hosted/trial/local
flow). Enforced in the shipping Rust engine (`native/.../license.rs
offline_license_status`); the dev twin does not verify it (PARITY).

**File format** (`license.lic`, JSON):

```json
{
  "payload": "{\"paidThrough\":\"2027-01-01T00:00:00.000Z\"}",
  "signature": "<minisign signature string over the exact payload bytes>"
}
```

`payload` is the verbatim claims string that was signed (verified as-is — no
canonicalization gap). Claims: `paidThrough` (RFC3339; omit for open-ended) and
optional `graceUntil`. Deploy it through the same channel as the policy:
`%ProgramData%\Lighthouse\license.lic` / `/Library/Application
Support/Lighthouse/license.lic` / `/etc/lighthouse/license.lic`, or point the
engine at any path with `LICENSE_OFFLINE_FILE`.

**What the maintainer must provision (fail-closed until then):**

1. **Generate a dedicated license signing keypair** with minisign (`minisign -G
   -p license.pub -s license.key`) — separate from the updater key so licensing
   and updates rotate independently. Keep `license.key` offline.
2. **Bake the public key into the build** as `LICENSE_OFFLINE_PUBKEY` (the bare
   base64 from `license.pub`). Unset/empty ⇒ offline activation is **disabled**
   (every file is rejected) — this is the default, so the feature ships inert.
3. **Sign each license** by writing the claims JSON and signing those exact bytes
   (`minisign -S -s license.key -m payload.json`), then assembling the
   `{payload, signature}` file.
4. **Do not enable paid distribution until installers are signed** (docs/
   signing.md). Offline activation grants paid, so it must not open a paid path
   on unsigned builds — provision the license key only alongside signed releases.

## Silent / fleet installation

Flags depend on which bundle the release ships (set in the Tauri config):

- **Windows — NSIS (`Lighthouse_<ver>_x64-setup.exe`):** `"...setup.exe" /S`
  for a silent install; append `/D=C:\Program Files\Lighthouse` (unquoted, must
  be the **last** argument) to override the directory. `/S` also drives silent
  uninstall via the registered uninstaller.
- **Windows — MSI (`Lighthouse_<ver>_x64_en-US.msi`), if built:**
  `msiexec /i Lighthouse_<ver>_x64_en-US.msi /qn /norestart`
  (`/qn` fully silent; add `ALLUSERS=1` for a per-machine install where the
  bundle allows it).
- **macOS:** distribute the `.app` inside the signed/notarized `.dmg` (or a
  `.pkg`) and copy it in via your MDM's app-install payload — no interactive
  installer.
- **Linux:** the AppImage is a single executable (no install step); the `.deb`
  installs headless with `apt-get install -y ./Lighthouse_<ver>_amd64.deb`.

Pair a silent install with the machine `policy.json` and (optionally)
`license.lic` above so a fleet machine comes up already managed and activated.

## Threat model, stated plainly

The policy layer is **configuration management, not anti-tamper**. The
integrity boundary is the OS file ACL on the machine-scope path: standard
users cannot modify or remove the file, and release builds read only that
fixed path. A local **administrator** (or anyone with root) can remove the
file — the same is true of every MDM configuration profile. What the layer
guarantees: unmanaged drift is blocked server-side in the engine, not merely
hidden in the UI, so a curious user cannot re-enable a forbidden provider,
hotkey, or telemetry with any in-app action.

Verification for a pilot: deploy the example policy, launch Lighthouse, and
check the settings gear — the provider list shows blocked entries disabled
with "Managed by your organization", and `docs/data-flows.md`'s disable
matrix describes exactly which network calls remain.

## Follow-ons (not in v1)

Signed **policy** files (Ed25519 — reusing the offline-activation verifier that
now ships for `license.lic`), remote policy URLs, per-key "default but
changeable" semantics.
