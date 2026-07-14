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
| `auditLog` | `"on"` | Forces the local audit log on and locks the preference (see add-audit-log). |
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

Silent/fleet installation flags for the Windows installer are documented in
this file's §Silent install once the offline-activation work lands.

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

Signed policy files (Ed25519 — reusing the offline-activation verifier),
remote policy URLs, per-key "default but changeable" semantics.
