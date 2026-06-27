#!/usr/bin/env bash
# =============================================================================
#  Lighthouse launcher (macOS / Linux).
#
#  Double-click in Finder (macOS) or your file manager (Linux). The first run
#  installs and builds the app; every run after just launches it. No typing.
#
#  macOS note: the first time, right-click -> Open to get past Gatekeeper.
# =============================================================================
set -e
cd "$(dirname "$0")"

bold() { printf '\033[1;31m%s\033[0m\n' "$1"; } # red beacon

if ! command -v node >/dev/null 2>&1; then
  bold "Lighthouse needs Node.js, which isn't installed yet."
  echo "Opening the download page — install it, then run this again."
  (open https://nodejs.org/en/download 2>/dev/null || xdg-open https://nodejs.org/en/download 2>/dev/null) || true
  read -r -p "Press Return to close…" _
  exit 1
fi

if [ ! -d node_modules/electron ]; then
  bold "First-time setup: installing Lighthouse (a few minutes)…"
  npm install
fi

if [ ! -f .next/BUILD_ID ]; then
  bold "Building Lighthouse…"
  npm run build
fi

bold "Launching Lighthouse…"
npm run electron
