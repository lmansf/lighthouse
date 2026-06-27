#!/usr/bin/env bash
#
# Lighthouse one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/lmansf/lighthouse/main/install.sh | bash
#
# Clones (or updates) the repo into ~/.lighthouse, installs dependencies,
# builds the Next.js app, and launches the Electron desktop app. Re-running
# updates an existing install in place.
set -euo pipefail

REPO_SLUG="${LIGHTHOUSE_REPO_SLUG:-lmansf/lighthouse}"
REPO="${LIGHTHOUSE_REPO:-https://github.com/$REPO_SLUG.git}"
DEST="${LIGHTHOUSE_HOME:-$HOME/.lighthouse}"

info() { printf '\033[1;31m▸\033[0m %s\n' "$1"; } # red beacon prompt

command -v git >/dev/null  || { echo "git is required"; exit 1; }
command -v node >/dev/null || { echo "Node.js 18+ is required (https://nodejs.org)"; exit 1; }
command -v npm >/dev/null   || { echo "npm is required"; exit 1; }

if [ -d "$DEST/.git" ]; then
  info "Updating Lighthouse in $DEST"
  git -C "$DEST" pull --ff-only
elif command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  # Private repo: use the user's authenticated GitHub CLI.
  info "Installing Lighthouse to $DEST (via gh)"
  gh repo clone "$REPO_SLUG" "$DEST" -- --depth 1
else
  info "Installing Lighthouse to $DEST"
  echo "  (private repo? install the GitHub CLI and run 'gh auth login' first)"
  git clone --depth 1 "$REPO" "$DEST"
fi

cd "$DEST"

info "Installing dependencies (this can take a minute)…"
npm ci || npm install

info "Building the app…"
npm run build

info "Lighthouse is ready."
echo
echo "  Launch the desktop app:   cd \"$DEST\" && npm run electron"
echo "  Build an installer:       cd \"$DEST\" && npm run dist"
echo

if [ "${LIGHTHOUSE_LAUNCH:-1}" = "1" ] && [ -z "${CI:-}" ]; then
  info "Launching Lighthouse…"
  npm run electron
fi
