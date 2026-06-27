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

The **first** double-click installs dependencies and builds the app (a few
minutes, shown in a console window). **Every double-click after that** launches
Lighthouse straight away. The only prerequisite is [Node.js](https://nodejs.org)
— if it's missing, the launcher opens the download page for you.

### One line in a terminal

```bash
curl -fsSL https://raw.githubusercontent.com/lmansf/rag-vault/main/install.sh | bash
```

This clones the repo to `~/.lighthouse`, installs dependencies, builds the app,
and launches it. Re-running the same command updates an existing install. For a
**private** repo, install the GitHub CLI and run `gh auth login` first — the
installer uses `gh` to clone.

### Manual

```bash
git clone https://github.com/lmansf/rag-vault.git
cd rag-vault
npm install
npm run build
npm run electron
```

## What the desktop app adds

- **Persistent** — launches at login and stays in the system tray. Closing the
  window hides it to the tray; quit from the tray menu to fully exit.
- **Native file dialogs** — `File ▸ Add files…` copies files into your vault
  (they arrive **excluded by default**, matching the app's exclusion rules).
  `File ▸ Choose vault folder…` points Lighthouse at any directory.
- **Open vault folder** — reveals the vault in your OS file manager.

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
target OS. Drop a `build/icon.png` and `assets/tray.png` in first for branded
icons.

The app ships **unpacked** (`asar: false`) because it runs a local Next.js
server (`next start`) as a child process, which must be a real file on disk
rather than packed into an asar archive. Only production dependencies are
bundled; `.next/cache` and the dev toolchain are excluded.

### What the end user gets

The Windows installer (NSIS) installs Lighthouse with a Start-Menu and desktop
shortcut and lets the user pick the install directory. Launching it starts the
bundled server and opens the app — and Lighthouse adds itself to login items so
it stays running in the tray.

## Configuration

Environment variables (set in `.env.local` or the shell that launches the app)
still apply — `ANTHROPIC_API_KEY` for live chat, and the `SUPABASE_*` vars from
[registration.md](./registration.md) for the welcome form. `VAULT_DIR` is set
automatically by the desktop app from your chosen folder.
