# Lighthouse desktop app

Lighthouse runs as a persistent Electron desktop app that wraps the same
Next.js + local-filesystem backend used in the browser. Your documents live in
a real folder on your computer — nothing is uploaded to a cloud database.

## Install

One line in a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/lmansf/rag-vault/main/install.sh | bash
```

This clones the repo to `~/.lighthouse`, installs dependencies, builds the app,
and launches it. Re-running the same command updates an existing install.

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

```bash
npm run dist
```

`electron-builder` produces a platform installer in `release/` (NSIS `.exe` on
Windows, `.dmg` on macOS, `.AppImage` on Linux). Drop a `build/icon.png` and
`assets/tray.png` in first for branded icons.

## Configuration

Environment variables (set in `.env.local` or the shell that launches the app)
still apply — `ANTHROPIC_API_KEY` for live chat, and the `SUPABASE_*` vars from
[registration.md](./registration.md) for the welcome form. `VAULT_DIR` is set
automatically by the desktop app from your chosen folder.
