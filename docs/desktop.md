# Lighthouse desktop app

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

- **Persistent** — launches at login and stays in the system tray. Closing the
  window hides it to the tray; quit from the tray menu to fully exit.
- **Add files / folders (copy)** — `File ▸ Add files…` and `File ▸ Add folder…`
  copy items into your vault. A folder keeps its structure.
- **Link files / folders (no copy)** — `File ▸ Link files…` and
  `File ▸ Link folder…` add items **by reference**, reading them from their real
  location on disk so no second copy is made. Unlink any time from the tree
  (the real files are left in place).
- Everything added — copied or linked — arrives **excluded by default**, matching
  the app's exclusion rules; you opt items into the RAG index in the tree.
- **Choose vault folder…** points Lighthouse at any directory; **Open vault
  folder** reveals it in your OS file manager.

In the browser, use **Add files** or **Add folder** (or drag items in) — folders
upload with their structure. Linking in place is desktop-only, since browsers
can't access real filesystem paths.

## Vault location

By default the vault is `~/Documents/Lighthouse Vault`. The chosen folder is
remembered in Electron's `userData` directory (`lighthouse-settings.json`).
Changing it restarts the local server against the new directory.

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
**Cross-building is not supported here** (e.g. you can't build the Windows `.exe`
on Linux without Wine), so run `npm run dist` / `Build-Installer.cmd` on the
target OS. The branded icons are already committed (see [Icons](#icons) below).

The app ships **unpacked** (`asar: false`) because it runs a local Next.js
server (`next start`) as a child process, which must be a real file on disk
rather than packed into an asar archive. Only production dependencies are
bundled; `.next/cache`, the dev toolchain, and the `supabase/` Edge Function
sources are excluded. So are `.env` / `.env.local` (dev files that may hold
secrets) — only the public `.env.production` (license function URL + anon key)
ships.

### Icons

The branded lighthouse icon is committed (`build/icon.png` / `build/icon.ico`
for the app + installer, `assets/icon.png` for the window, `assets/tray.png` for
the tray). To re-generate them after editing the SVG sources in `build/`, run
`npm run icons` (installs `sharp` + `png-to-ico` on demand, so end users never
pull these heavy native deps).

### What the end user gets

The Windows installer (NSIS) installs Lighthouse with a Start-Menu and desktop
shortcut and lets the user pick the install directory. Launching it starts the
bundled server and opens the app — and Lighthouse adds itself to login items so
it stays running in the tray.

## Configuration

Environment variables (set in `.env.local` or the shell that launches the app)
still apply — `ANTHROPIC_API_KEY` for live chat, and the trial-licensing config
(`LICENSE_API_URL` + `SUPABASE_ANON_KEY`, shipped in `.env.production`) from
[registration.md](./registration.md) for the welcome form. `VAULT_DIR` is set
automatically by the desktop app from your chosen folder.
