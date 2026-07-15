# EDR / antivirus whitelisting

Lighthouse is a local-first desktop app. To answer questions about your files
without sending them anywhere, it does several things on-device that endpoint
protection (EDR) and antivirus heuristics sometimes flag: it launches local
inference servers, watches folders for changes, opens loopback ports, and — if
you turn it on — installs a keyboard hook. None of this is remote access,
persistence beyond an opt-in launch-at-login, or code injection into other
processes. This page lists exactly what runs, so a security team can allow it
deliberately rather than by exception.

Pair this with `docs/data-flows.md` (every network destination and how to
disable each) and `docs/managed-deployment.md` (the machine-scope policy that
turns off the flagged behaviors org-wide, engine-enforced).

## App identity

| | |
|---|---|
| Product | Lighthouse |
| Bundle identifier | `com.lighthouse.app` |
| Publisher / signing | Authenticode (Windows) + Apple Developer ID (macOS) — **see status below** |
| Auto-update | Tauri updater, signed manifests verified with a pinned minisign public key (`docs/signing.md`) |

**Signing status:** release signing is scaffolded but gated on the maintainer
provisioning certificates (`docs/signing.md`). Until signed builds ship,
installers are unsigned and SmartScreen / Gatekeeper will warn; whitelist by
file hash from the release page (`asset-digests.yml` publishes SHA-256 for every
artifact) rather than by publisher. Once signing lands, prefer allow-listing the
signing identity so it survives version bumps.

## Processes Lighthouse starts

All child processes are bundled binaries under the install directory (Windows:
`%LOCALAPPDATA%\Lighthouse` / Program Files; macOS: inside the `.app`; Linux:
the AppImage mount / install prefix). None are downloaded at runtime except
model weights you explicitly choose to install, and update packages you click to
install (both SHA-256- or signature-verified).

| Process | Why | Network |
|---|---|---|
| `lighthouse` (main) | The app + its embedded engine | Loopback UI only; cloud only if you pick a cloud AI provider |
| `llama-server` (chat) | Local LLM answers | Binds `127.0.0.1:8080`, loopback only |
| `llama-server` (embeddings) | Semantic search over your files | Binds `127.0.0.1` on the embed port, loopback only |
| Whisper (dictation) / ocrs (OCR) | Voice input, image/scanned-PDF text | In-process or child process, **no sockets** |

The two `llama-server` instances are supervised (restarted if they crash, with
quick-exit backoff) and are the same upstream `llama.cpp` server binary many
tools ship; an EDR that fingerprints it generically may need a path/hash
allowance. They **only** bind loopback — no external listener is ever opened.

## OS-integration behaviors (and how to turn each off)

| Behavior | What it is | Disable |
|---|---|---|
| **Global summon hotkey** | Registers a system hotkey to summon the search bar | Managed policy `widgetHotkeys: "off"` (never registers) |
| **Whisper mode (opt-in, default off)** | A low-level keyboard hook (`WH_KEYBOARD_LL` on Windows; `CGEventTap`/XInput2 elsewhere) that summons the bar on a tap-chord. This is the single most likely EDR trigger — a global keyboard hook resembles a keylogger heuristically. It reads modifier state to detect the chord; it does **not** record or forward keystrokes. | Off by default. Managed policy `widgetHotkeys: "off"` prevents the hook from ever installing. |
| **Filesystem watcher** | Watches your vault folder (and linked folders) to keep the index fresh | Inherent to a local search tool; scoped to folders you added. No lever — remove folders to narrow it. |
| **Launch at login** | Optional autostart | Off until you consent; toggle in Preferences |
| **Loopback ports** | `127.0.0.1:8080` and the embed port | Loopback only, no external binding; in the shipped bundle the UI↔engine link is Tauri IPC, not TCP |

## What Lighthouse does NOT do

- No listening socket on any non-loopback interface.
- No code injection, DLL side-loading into other processes, or process
  hollowing. The keyboard hook is the OS-sanctioned `WH_KEYBOARD_LL` API, used
  only to detect the summon chord.
- No persistence beyond the optional, consented launch-at-login entry.
- No lateral movement, remote shell, or command-and-control. Outbound
  connections are limited to the destinations enumerated in
  `docs/data-flows.md`, each individually disableable.
- No telemetry unless you opt in (default off), and never document content
  except to a cloud AI provider you explicitly configured.

## Suggested allow-list entries

1. The signing identity (once signed builds ship — see status above), or the
   per-release SHA-256 hashes from `asset-digests.yml` in the meantime.
2. The install directory (bundled `llama-server`, Whisper, ocrs
   binaries) — allow child-process execution from it.
3. Loopback binds on `127.0.0.1:8080` and the embed port.
4. Outbound HTTPS to the hosts in `docs/data-flows.md` §"Redirect / effective
   hosts", if your egress proxy is default-deny.

For the most locked-down posture, deploy the managed policy with
`forceLocalOnly: true`, `widgetHotkeys: "off"`, `telemetry: "off"`, and
`auditLog: "on"` — no cloud egress, no keyboard hook, no telemetry, and a
tamper-evident local record of every answer (`docs/managed-deployment.md`).
