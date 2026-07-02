# Auto-updater design — launch-time, splash-integrated

Status: **design / not yet implemented.** Target: `electron/main.js` (v0.2.4),
tray-resident app, builds currently **unsigned**. Produced from a multi-lens
design pass (mechanism / launch-integration / security / ops) plus an adversarial
review; the corrections from that review are folded in and flagged inline.

## 1. Recommendation in one paragraph

Use **`electron-updater`** (the runtime companion to the `electron-builder@^25`
already in `package.json`) as the single engine, driven by **two modes behind one
constant**. Do **not** hand-roll a downloader — a bespoke updater means
re-implementing integrity checks, Authenticode/Squirrel signature verification,
and installer invocation, which is exactly the code that turns an updater into a
remote-code-execution vector. Ship **notify-only while builds are unsigned**, and
flip to **auto-download + install-on-quit only once code signing + notarization
are live** — because that is the only mode in which the updater's signature
verification actually protects the user.

## 2. Why notify-only until signed (the crux)

`electron-updater` verifies a **SHA-512 from `latest.yml`** over the TLS transfer.
That is an **integrity** check, not an **authenticity** check: whoever can write to
the GitHub release channel (CI `GITHUB_TOKEN`, a maintainer PAT/account, or
compromised CI) replaces the installer *and* the manifest together, so the hash
happily validates malicious bytes. The only real authenticity control is a **code
signature**:

- **Windows:** `NsisUpdater.verifyUpdateCodeSignature` checks the installer's
  Authenticode publisher against `win.publisherName`. With no cert
  (`release.yml` sets `CSC_IDENTITY_AUTO_DISCOVERY` off today) this is a no-op.
- **macOS:** Squirrel.Mac verifies the update against the running app's designated
  requirement and **refuses unsigned/un-notarized updates outright**.

So auto-downloading and executing an installer on an unsigned build is a new RCE
path. Blast radius if accepted: Lighthouse spawns child processes, reads/writes the
vault, and stores **OAuth connector tokens** under `userData/connectors`
(`main.js` `LIGHTHOUSE_CONNECTORS_DIR`), so a malicious update ≈ full local
compromise + connector-token exfiltration. Hence signing is the bar for auto-apply.

## 3. Phased plan

### Phase A — ships now (unsigned): check + notify + open the download page

- Add `electron-updater`; set `autoDownload = false`, `autoInstallOnAppQuit = false`,
  `allowDowngrade = false`. Never call `downloadUpdate()` / `quitAndInstall()`.
- On launch, during the splash, fire the check in parallel with `waitForServer`
  (never awaited, never gating; see §5).
- `update-available` → surface an "Update available" state and expose a **tray item
  + in-app banner** whose only action is `shell.openExternal(releasePageUrl)`
  (reusing the external-link discipline already in `createWindow`'s
  `setWindowOpenHandler`). Zero in-process download or execution → zero new RCE
  surface. Cross-platform (macOS just opens the `.dmg` download page too).
- `update-not-available` / `error` / timeout → silent; boot proceeds.
- One gate constant, defined `false`:

```js
// electron/updater.js
// Auto-apply requires verifiable signatures on BOTH targets. Until signing is live,
// stay notify-only so the updater can never fetch + run an unverifiable installer.
const UPDATER_CAN_AUTO_INSTALL = false; // flip only after win Authenticode + mac notarization
```

### Phase B — after signing + notarization: auto-download + install-on-quit

Prerequisites (there are **0 signing secrets configured today**):

- **Windows:** Authenticode-sign the NSIS installer + app exe; set `win.publisherName`
  so the updater rejects any installer not signed by you.
- **macOS:** Developer ID sign + **notarize + staple**, and add a **`zip` target**
  (Squirrel.Mac updates from a `.zip`, not the `.dmg` built today). Auto-update on
  macOS is *blocked* until this lands.

Then flip `UPDATER_CAN_AUTO_INSTALL = true` to enable `autoDownload`,
`autoInstallOnAppQuit`, background download with `download-progress`, and an explicit
"Restart to update" affordance (needed — see §7).

> **Signing-key custody (adversarial-review correction).** Do **not** put a raw
> `.pfx` + password in GitHub Actions secrets (`CSC_LINK`/`CSC_KEY_PASSWORD`) as the
> permanent Phase-B setup: that puts the signing key in CI, so a CI/`GITHUB_TOKEN`
> compromise could produce a **validly signed** malicious update — the exact RCE
> this design forbids. Prefer non-exfiltratable signing: **Azure Trusted Signing**
> or a **KMS/HSM-backed `signtool`** for Windows, and Apple's notary service for
> macOS, invoked from CI without the private key ever being retrievable. The
> `CSC_LINK` env wiring already scaffolded in `release.yml` is the *pragmatic
> solo-dev* path (acceptable to start, weaker trust root); treat cloud/HSM signing
> as the target once revenue/userbase justify it.

## 4. Two hard preconditions (both phases)

- **`build.publish.releaseType` is `"draft"`** in `package.json`. The GitHub
  provider reads `/releases/latest`, which **excludes drafts and prereleases** — the
  updater (and the lhvault.app download button) see nothing until a release is
  *published*. Either flip to `"release"` or keep drafts and add an explicit
  "publish the draft" step. **Tradeoff (review note):** flipping to `"release"`
  makes both the updater and the public download go live the instant CI finishes,
  removing whatever manual QA gate the draft step provides today.
- **The check runs in the main process, never the renderer.** The renderer CSP
  (`connect-src 'self' http://localhost:* http://127.0.0.1:*`) correctly forbids a
  fetch to github.com; doing the check in main keeps update logic out of the web
  sandbox and needs no CSP change.

## 5. Launch / splash integration

### Where it plugs in (parallel, never gating)

`app.whenReady()` currently runs `startLocalLlm()` → reconcile timer →
`startServer()` → `buildMenu()`/`createTray()` → `createWindow()` (paints
`splash.html`) → `waitForServer(cb)` whose success path calls `showApp()` and whose
failure path calls `showError()`.

Fire the check **right after `createWindow()`**, in parallel with `waitForServer` —
do not await it, never let it gate `showApp()`, and **never route an update failure
to `showError()`** (a slow/offline/draft-only check is normal; `showError()` stays
reserved for the dead-local-server case):

```js
    createWindow();          // splash paints immediately
    maybeCheckForUpdates();  // NEW: parallel, non-blocking, best-effort
    waitForServer((err) => { // unchanged; owns the splash→app swap
      if (err) { /* dialog + showError() as today */ return; }
      showApp();
    });
```

Requires adding `ipcMain` to the `require("electron")` destructure and
`const { autoUpdater } = require("electron-updater")`.

### Hard timeout / fallback

`waitForServer` is the launch budget (`tries > 80` × 500 ms ≈ 40 s).
`autoUpdater.checkForUpdates()` has **no built-in timeout**, so bound the metadata
check well inside that window and treat expiry as a benign "unavailable":

```js
function maybeCheckForUpdates() {
  if (!app.isPackaged) return setUpdateState({ phase: "dev-skip" });
  setUpdateState({ phase: "checking" });
  let settled = false;
  const settle = (s) => { if (!settled) { settled = true; setUpdateState(s); } };
  autoUpdater.autoDownload = UPDATER_CAN_AUTO_INSTALL;          // Phase A: false → notify only
  autoUpdater.autoInstallOnAppQuit = UPDATER_CAN_AUTO_INSTALL;
  autoUpdater.allowDowngrade = false;
  autoUpdater.once("update-not-available", () => settle({ phase: "up-to-date" }));
  autoUpdater.once("error", () => settle({ phase: "unavailable" }));
  autoUpdater.once("update-available", (info) => {
    if (!UPDATER_CAN_AUTO_INSTALL) settle({ phase: "available", version: info.version });
    // Phase B: leave unsettled; download-progress / update-downloaded drive the rest.
  });
  setTimeout(() => settle({ phase: "unavailable" }), 8000);    // ≪ waitForServer's ~40s
  autoUpdater.checkForUpdates().catch(() => settle({ phase: "unavailable" }));
}
```

The 8 s cap bounds only the metadata check. In Phase B the background download is
deliberately unbounded but off the critical path, so it can't wedge launch either.

### main → renderer channel: boot-scoped preload (adversarial-review correction)

`createWindow()` sets `contextIsolation: true` with **no preload**. Add a small
preload + one-way IPC. **But the same `BrowserWindow` later loads the live Next app
via `showApp()`**, so a naively-exposed `restartToUpdate()` bridge would be callable
from the live RAG web content — a stored-XSS/compromised-page path to force
`quitAndInstall()`. Mitigate by **gating the privileged handler on a boot-phase
flag that `showApp()` clears**, so web content can never trigger an install:

```js
// preload.js — read-only state + fixed-channel, arg-less actions
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("lighthouseUpdate", {
  onState: (cb) => ipcRenderer.on("update:state", (_e, s) => cb(s)),
  openRelease: () => ipcRenderer.send("update:open"),        // → shell.openExternal(constant URL)
  restartToUpdate: () => ipcRenderer.send("update:restart"), // Phase B only
});
```

```js
// main.js — gate the dangerous action to the boot window
let bootPhase = true;                       // set false inside showApp()
ipcMain.on("update:open", () => shell.openExternal(RELEASE_PAGE_URL)); // benign: constant URL
ipcMain.on("update:restart", () => {
  if (!UPDATER_CAN_AUTO_INSTALL || !bootPhase) return;   // live app content can't trigger install
  app.isQuitting = true;                                 // so win.on("close") doesn't hide-to-tray
  autoUpdater.quitAndInstall();                          // funnels through before-quit → kills children
});
```

`webContents.send` is fire-and-forget with no buffering, so cache the last state and
rebroadcast on `did-finish-load` (also re-arms across the splash→app swap):

```js
function setUpdateState(s) {
  lastUpdateState = s;
  if (win && !win.isDestroyed()) win.webContents.send("update:state", s);
}
win.webContents.on("did-finish-load", () => setUpdateState(lastUpdateState));
```

Also add `preload: path.join(__dirname, "preload.js")` to `createWindow`'s
`webPreferences`.

### splash.html

Give the sub-line an `id` and add one inline consumer script (allowed by
`script-src 'self' 'unsafe-inline'`):

```html
<div class="sub" id="sub">Starting your private vault…</div>
<script>
  window.lighthouseUpdate?.onState((s) => {
    var sub = document.getElementById("sub");
    if (s.phase === "checking")         sub.textContent = "Checking for updates…";
    else if (s.phase === "downloading") sub.textContent = "Downloading update… " + (s.percent|0) + "%";
    else if (s.phase === "ready")       sub.textContent = "Update ready — installs when you quit";
    else if (s.phase === "available")   sub.textContent = "Update available";
    else                                sub.textContent = "Starting your private vault…";
  });
</script>
```

## 6. UX + the durable surface (adversarial-review correction)

**The splash is destroyed ~2 s into launch** (`showApp()` swaps to the live app the
moment `/api/rag` answers). So the loading-screen copy is **best-effort/cosmetic for
the boot window only** — Phase-A "Update available" flashes briefly, and Phase-B
`downloading`/`ready` essentially never render on the splash. Therefore the
**committed, durable surface is a tray item + an in-app banner in the Next UI** (not
an "open question"): the tray item shows when state is `available` (Phase A) or
`ready` (Phase B); the in-app banner reads update state over the same IPC bridge (or
a local API route) and offers "Open download page" (A) / "Restart to update" (B).

| Phase | Splash `.sub` (boot window) | Durable surface |
|---|---|---|
| checking | "Checking for updates…" | — |
| up-to-date / unavailable / dev-skip | "Starting your private vault…" | — |
| available (A) | "Update available" (flash) | tray item + banner → open download page |
| downloading (B) | "Downloading update… N%" | banner progress |
| ready (B) | "Update ready — installs when you quit" | tray "Restart to update" + banner |
| error | "Starting your private vault…" (silent) | — |

**Rule: the loading screen never shows an update failure.** Boot always proceeds.

## 7. Rollout, failure handling, lifecycle

- **Invariant:** any updater failure (offline, rate-limited, draft-only,
  checksum/signature mismatch, install failure) → log-only + normal boot on the
  installed version. Never `showError()`; never retry-loop on a signature mismatch
  (that's high-signal — a distinct log/telemetry event). `electron-updater`
  downloads to temp and swaps only on verified-complete, so a partial download can't
  corrupt the install.
- **Persistent-tray lifecycle (Phase B):** `window-all-closed` is a no-op and close
  hides to tray, so pure install-on-quit may never fire. Provide the explicit
  "Restart to update" path (§5) and a tray entry shown only in `ready`/`available`.
- **On-launch is the requirement; add a periodic re-check (6–12 h, jittered) in
  Phase B**, modeled on the reconcile timer and **`.unref()`'d** so it never keeps
  the app alive — otherwise long-lived tray installs never see updates or a
  kill-switch.
- **Kill-switch / staged rollout (Phase B, optional):** native `stagingPercentage`
  in `latest.yml` (edit the release, no rebuild). For a remote stop button, a small
  HTTPS policy file on the already-controlled `lhvault.app` may only **gate/narrow**
  updater behavior (`updatesEnabled`, `minVersion`, `blockedVersions`) — it must
  **never** point at an arbitrary URL/binary; artifact resolution stays on the
  signed GitHub-release path. Fetch with a 3–5 s timeout; on failure treat as
  enabled.
- **Observability:** a local `updater.log` in `userData` via the existing `logFd`
  pattern (no consent needed). Any network telemetry is opt-in-gated, counters only
  (`update_check{result}`, `update_verify_fail`, `update_install{result}`) — no
  paths, no vault contents.

## 8. First-signed-update transition (adversarial-review correction)

The **first** signed/notarized release **cannot be auto-applied to existing unsigned
installs**:

- **macOS:** Squirrel.Mac validates the new build against the *running* app's
  designated requirement; an already-installed unsigned app has none, so the first
  signed update must ship as a **manual `.dmg` download**.
- **Windows:** `verifyUpdateCodeSignature` compares against the `publisherName` baked
  into the *installed* `app-update.yml`; existing unsigned clients don't have it.

So field-installed unsigned clients get signature protection only from their
**second** signed update onward. Plan: distribute the first signed release via the
web download button / manual install, and message existing users to re-download
(there is no auto-update today anyway).

## 9. Interaction with bundled model / TTS

The current layout is already correct; the updater must preserve it:

- **The on-demand ~4 GB `.gguf` is never touched by an update** — it lives in
  `userData/models` (doc comment there literally says "survives app updates"), is
  excluded from packaging, and is re-detected post-update by `findModel()` /
  `reconcileModel()`. NSIS `perMachine:false` installs elsewhere and won't touch
  `userData`. Do **not** move the model under the app dir. (Worth a release test
  asserting `LIGHTHOUSE_MODELS_DIR` resolves under `userData` in the packaged app.)
- **`resources/llm` (llama-server) and `resources/tts` (Piper + ~63 MB voice) ARE
  bundled** and *do* get replaced on update — correct and desirable. These are now
  **pinned + SHA-256-verified at build time** (`scripts/fetch-local-model.mjs`
  `ASSET_SHA256`, fail-closed), so the binaries shipped inside each installer are
  reproducible and tamper-evident. Preserve that when bumping versions (use
  `--record` to re-pin).
- **UI copy:** an app update is the installer (~150–250 MB), **not** 4 GB — don't
  make users fear a full model re-pull.

## 10. Open decisions for the maintainer

1. **Signing timeline + key custody** (Windows OV vs EV; Azure Trusted Signing /
   KMS vs raw cert-in-CI — see §3 correction). Gates all of Phase B.
2. **`releaseType: "draft"` → `"release"`, or keep drafts + add a publish step?**
   (§4 tradeoff: losing the manual QA gate.)
3. **Enable `asar`?** Improves Phase-B differential-download efficiency and app
   integrity, but must be re-validated against resource/`.next` loading paths.
   Independent of the updater.
4. **Phase-B apply policy:** install-on-quit only, or also a periodic "restart to
   update" nudge? Any mandatory (`minVersion`-forced) releases, given a forced
   relaunch interrupts indexing/inference?
5. **Build the in-app banner** (the durable surface, §6) in the Next UI.

**Non-negotiables:** signing before any auto-apply (§2); update failures always fall
through to the current version (§7); the 4 GB model in `userData/models` is never
touched (§9); nothing weakens the existing CSP or the loopback-only / API-token
hardening.

**Files to add/touch when implementing:** new `electron/updater.js`, new
`electron/preload.js`; `electron/main.js` (require `ipcMain` + `autoUpdater`,
`createWindow` preload, the `did-finish-load` rebroadcast, the `maybeCheckForUpdates`
call site, the boot-phase-gated `ipcMain` handlers, a tray item); `electron/splash.html`
(+ inline script); `package.json` (`electron-updater` dep, `releaseType`; Phase B:
mac `zip` target, `win.publisherName`); `.github/workflows/release.yml` (Phase B
signing — see §3 custody note).
