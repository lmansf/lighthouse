# Lighthouse desktop app

> **Electron-era document.** The Electron shell described here was retired
> after the 0.3.0 native cutover (tree preserved on `archive/electron-shell`).
> The shipping desktop app is the **Tauri 2 shell** in
> `native/crates/lighthouse-desktop` — see `native/README.md` and the root
> README's Architecture section. Kept for history; the double-click
> launchers and installer flow below no longer exist in this tree.

Lighthouse runs as a persistent Electron desktop app that wraps the same
Next.js + local-filesystem backend used in the browser. Your documents live in
a real folder on your computer — nothing is uploaded to a cloud database.

## Install

### Double-click (no terminal)

Extract the repo, then double-click the launcher for your OS:

- **Windows** — `Lighthouse.cmd`
- **macOS / Linux** — `Lighthouse.command` (macOS: the first time, right-click ▸
  Open to clear Gatekeeper)

On **Windows**, the launcher opens a small branded **setup window** (lighthouse
icon, progress bar, status) while it installs and builds on first run, then opens
the app — no console. The **first** run installs dependencies and builds (a few
minutes); **every run after** launches straight away. The only prerequisite is
[Node.js](https://nodejs.org) — if it's missing, the window offers the download.

(macOS/Linux show the same steps in a terminal window. If PowerShell is somehow
unavailable on Windows, `Lighthouse.cmd` falls back to a plain console too.)

### One line in a terminal

```bash
curl -fsSL https://raw.githubusercontent.com/lmansf/lighthouse/main/install.sh | bash
```

This clones the repo to `~/.lighthouse`, installs dependencies, builds the app,
and launches it. Re-running the same command updates an existing install. For a
**private** repo, install the GitHub CLI and run `gh auth login` first — the
installer uses `gh` to clone.

### Manual

```bash
git clone https://github.com/lmansf/lighthouse.git
cd lighthouse
npm install
npm run build
npm run electron
```

## What the desktop app adds

- **Instant splash** — the window opens to a branded loading splash the moment
  the app launches, then swaps to the live app once the local engine answers, so
  you never stare at an empty screen while it boots. If the engine never starts,
  the splash is replaced by a clear error state instead of a hung spinner.
- **Persistent** — launches at login (see [Launch at login](#launch-at-login))
  and stays in the system tray. Closing the window hides it to the tray; quit
  from the tray menu to fully exit.
- **Adds are link-first (no copy)** - dropping files or folders onto the
  explorer, and the toolbar's `Browse… ▸ Files/Folder… (linked in place)`,
  add items **by reference**: they are read from their real location on disk,
  so no second copy is made and whole folders work instantly.
  `File ▸ Link files…` / `File ▸ Link folder…` do the same from the menu bar.
  Unlink any time from the tree (the real files are left in place).
  While a large add runs, the explorer shows a processing overlay with
  progress instead of appearing frozen.
- **Copy in (explicit)** - `Browse… ▸ Copy files in…` / `Copy folder in…` and
  `File ▸ Add files…` / `File ▸ Add folder…` copy items into your vault when
  you want the vault to own a duplicate. A folder keeps its structure.
- Everything added - copied or linked - arrives **excluded by default**, matching
  the app's exclusion rules; you opt items into the RAG index in the tree.
- **Choose vault folder…** points Lighthouse at any directory; **Open vault
  folder** reveals it in your OS file manager.
- **Open cited files** — in chat, the **Related files** cards are clickable and
  open the cited file in its native application. This is desktop-only (the
  `/api/open` route refuses on a web deployment, where the server has no access
  to your local files); the client sends only the node id and the server resolves
  it to a path, rejecting anything that escapes the vault.

In the browser, use the toolbar's **Browse…** menu (**Files…** / **Folder…**)
or drag items in — folders upload with their structure. Linking in place is
desktop-only, since browsers can't access real filesystem paths.

## Vault location

By default the vault is `~/Documents/Lighthouse Vault`. The chosen folder is
remembered in Electron's `userData` directory (`lighthouse-settings.json`).
Changing it restarts the local server against the new directory. The same
settings file also holds the launch-at-login preference described below.

That same `userData` directory also collects the child processes' logs —
`server.log` (the bundled `next start`) and `local-model.log` (the bundled
`llama-server`) — written there instead of a console window so no terminal pops
up on Windows. Check them first if the app won't start.

## Launch at login

The desktop app opens automatically when you sign in to your computer, so your
vault is always ready in the background. The **first** time you reach the app it
asks once — *"Open Lighthouse at startup?"* — with the option on by default; your
answer is saved (as `runOnStartup` in `lighthouse-settings.json`) and it never
asks again. The Electron main process reads that preference on each launch and
adds or removes itself from the OS login items accordingly. This is desktop-only
— on the web build the prompt never appears and the setting is a no-op.

## Renderer security (Content-Security-Policy)

The desktop app sets a **Content-Security-Policy** on every response the renderer
loads. The Electron main process installs it via
`session.defaultSession.webRequest.onHeadersReceived` before the window is
created, so the first document is covered too. The policy keeps the page locked
to its own local Next server (`http://localhost:PORT`); API routes proxy out to
the configured AI provider server-side, so the renderer itself only talks to
that same origin. Notably it **omits `'unsafe-eval'`** — production Next doesn't need it —
which clears Electron's insecure-CSP warning and removes that attack surface.
`'unsafe-inline'` stays because Next's bootstrap inline script and Fluent UI's
(Griffel) runtime `<style>` injection rely on it, and `connect-src` allows
`localhost`/`127.0.0.1` for the local-model server. `media-src` allows `blob:`
(and `data:`) so read-aloud can play the synthesized WAV via an object URL. This
is desktop-only; the web build leaves CSP to its own hosting.

## Building a distributable installer

This produces a **standalone installer** end users double-click — no Node.js,
no build, no terminal on their side.

### Double-click (no terminal)

On the build machine, double-click **`Build-Installer.cmd`** (Windows). It
installs build tools if needed, builds the app, and packages the installer,
then opens the `release/` folder. Share the resulting `.exe`.

### Terminal

```bash
npm run dist
```

`electron-builder` produces a platform installer in `release/` for the platform
you run it on — NSIS `.exe` on Windows, `.dmg` on macOS, `.AppImage` on Linux.
The Windows installer has a fixed, version-less name (`Lighthouse-Setup.exe`, set
via the NSIS `artifactName`) so a GitHub `releases/latest/download/Lighthouse-Setup.exe`
URL stays permanent across releases (the companion website links straight to it).
**Cross-building is not supported here** (e.g. you can't build the Windows `.exe`
on Linux without Wine), so run `npm run dist` / `Build-Installer.cmd` on the
target OS. The branded icons are already committed (see [Icons](#icons) below).

`npm run dist` first runs `next build` to produce the `.next` production build
(bundled into the installer so the packaged app's `next start` needs no Node.js
toolchain on the user's machine), then `npm run fetch:model`
(`scripts/fetch-local-model.mjs`), which downloads the `llama-server` binary
(llama.cpp, MIT) into `resources/llm/` **plus** the Piper TTS binary
(rhasspy/piper, MIT) and a neural voice (`en_US-lessac-medium`, ~63 MB, MIT/CC0)
into `resources/tts/` for on-device read-aloud, and finally `electron-builder`
copies both folders into the installer via its `extraResources` entries - though
the `llm` entry carries a `!**/*.gguf` filter, so a stray or dev-only model left
in `resources/llm` (the runtime fallback `modelsDir()` reads in `npm run dev`) can
never be packaged. The
model weights are **not** bundled: Mistral-7B-Instruct-v0.3 Q4_K_M (~4.2 GB,
Apache-2.0) is past NSIS's 2 GB installer limit, so the app downloads it on demand
when the user opts into the private model (the **＋** in the model picker →
`app/api/model` → `<userData>/models`) - a CPU-only path that trades speed for
quality (~a minute per answer, ~6-8 GB RAM). The bundled assets are gitignored
and fetched on the build machine. Use `npm run dist:nomodel`
to skip the fetch (it still runs `next build`) for a lean build that relies on a
bring-your-own server instead (and falls back to the OS's Web Speech voices for
read-aloud). The fetch script takes env overrides (pinned `llama.cpp` version,
alternate model URL, expected checksums) documented in its header comment.

The app ships **unpacked** (`asar: false`) because it runs a local Next.js
server (`next start`) as a child process, which must be a real file on disk
rather than packed into an asar archive. Only production dependencies are
bundled; `.next/cache` and the dev toolchain are excluded, along with `.env` /
`.env.local` (dev files that may hold secrets).

> **Electron-era note (no longer applies).** This build step once also shipped a
> public `.env.production` carrying license/checkout Edge-Function URLs, a
> Supabase anon key, and a `PAID_ENABLED` flag, and excluded a `supabase/`
> Edge-Function source tree. **The shipping Tauri app has none of that** — no
> licensing, no checkout, no Supabase backend — so those variables and sources
> no longer exist to ship or exclude (see `docs/data-flows.md`).

### Icons

The branded lighthouse icon is committed (`build/icon.png` / `build/icon.ico`
for the app + installer, `assets/icon.png` for the window, `assets/tray.png` for
the tray). To re-generate them after editing the SVG sources in `build/`, run
`npm run icons` (installs `sharp` + `png-to-ico` on demand, so end users never
pull these heavy native deps).

### What the end user gets

The Windows installer (NSIS) installs Lighthouse with a Start-Menu and desktop
shortcut and lets the user pick the install directory. It is **branded to match
the app**: the welcome and finish pages carry a cool-steel / sea-sky-blue / brass
sidebar drawn from the same Forerunner palette as the app shell
(`src/shell/theme.ts`), and the install step narrates what is happening in the
app's voice on the status line above electron-builder's progress bar (bundling
the on-device AI model, registering shortcuts, ready to open). Launching it
shows the loading splash, starts the bundled server, and swaps in the app once
it answers — and, unless the user opts out at the one-time
[launch-at-login](#launch-at-login)
prompt, Lighthouse adds itself to login items so it stays running in the tray.

The installer branding lives in `build/`: `installer.nsh` (the electron-builder
NSIS `include` hook holding the `customInstall` narration and the `customUnInstall`
data prompt below) and the `installerSidebar.bmp` / `uninstallerSidebar.bmp`
images, regenerated from the theme palette with `npm run installer:art`
(`scripts/gen-installer-art.mjs`).

Uninstalling removes the app and asks once whether to **also delete your
Lighthouse data** — the app settings/logs (`%APPDATA%\rag-vault`, Electron's
userData folder, named after the package name — **this path is Electron-era
history; the shipping Tauri app instead uses an OS app-data directory derived
from the identifier `com.lighthouse.app`, not from `rag-vault`**) and the
default vault (`Documents\Lighthouse Vault`) along with the files in it. The
default answer (and a silent `/S` uninstall) is **No**, so your documents and
settings are never deleted by accident and a reinstall picks up where you left
off; a vault you pointed elsewhere is always left alone.

## Configuration

Environment variables (set in `.env.local` or the shell that launches the app)
still apply — `ANTHROPIC_API_KEY` for live chat, and `LIGHTHOUSE_LOCAL_LLM_URL` /
`LIGHTHOUSE_LOCAL_LLM_MODEL` to point the "Local model (private)" provider at an
external OpenAI-compatible server (see the README's
[Local model](../README.md#local-model) section).
`VAULT_DIR` is set automatically by the desktop app from your chosen folder.

> **Removed since the native cutover.** Earlier Electron builds also read a
> licensing/checkout block (`LICENSE_API_URL`, `SUPABASE_ANON_KEY`,
> `CHECKOUT_API_URL`, and a `PAID_ENABLED` flag) from `.env.production` to drive
> a welcome/registration form and paid subscriptions. **None of that exists in
> the shipping app:** there are no accounts, no license or trial check, no
> Supabase backend, and no Stripe checkout — the code was deleted, not disabled
> (see `docs/data-flows.md`). The old `registration.md` flow is retired with it.

A `dist` build bundles a `llama-server` binary under `resources/llm/`, plus the
Piper TTS binary and a neural voice under `resources/tts/` for on-device
read-aloud (see [Building a distributable installer](#building-a-distributable-installer)
above). The private model weights are not bundled; when the user opts in, the
Next server downloads them (`app/api/model` → `src/server/localModel.ts`) into
`<userData>/models`, and the desktop app auto-launches the local inference server
on `127.0.0.1:8080` against that file - at download time and on every later
launch (`reconcileModel` polls to start it when a download lands and to perform
an uninstall) - stopping it on quit. Main sets
`LIGHTHOUSE_MODELS_DIR` (where the model is downloaded/read) and
`LIGHTHOUSE_RESOURCES_PATH` so the Next API routes can locate both - Electron's
`resourcesPath` when packaged, the repo's `resources/` folder otherwise
(`npm run dev` / tests). Until the model is installed, the "Local model (private)"
provider falls back to passage streaming; a `dist:nomodel` build also skips the
bundled binaries, so the provider targets an external server via
`LIGHTHOUSE_LOCAL_LLM_URL` and read-aloud falls back to the OS's Web Speech
voices.
