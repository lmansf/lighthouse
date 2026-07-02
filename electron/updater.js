// Launch-time auto-updater. See docs/auto-updater-design.md.
//
// PHASE A (current, builds unsigned): NOTIFY-ONLY. electron-updater's SHA-512 is
// an integrity check over the transfer, NOT an authenticity check — a compromised
// release channel swaps the installer and its manifest together, so the hash
// validates malicious bytes. Auto-downloading + running that on an unsigned build
// would be a remote-code-execution path. So we only CHECK and surface a link to
// the release page; we never download or execute an installer in-process.
//
// PHASE B: once Windows Authenticode + macOS Developer ID signing + notarization
// are live, flip UPDATER_CAN_AUTO_INSTALL to true. Only then does electron-updater's
// signature verification (verifyUpdateCodeSignature / Squirrel.Mac) actually
// protect users, making auto-download + install-on-quit safe.
const { autoUpdater } = require("electron-updater");

// Flip to true ONLY after code signing + notarization are in place.
const UPDATER_CAN_AUTO_INSTALL = false;
const RELEASE_PAGE_URL = "https://github.com/lmansf/lighthouse/releases/latest";
// Bound the metadata check well inside waitForServer's ~40s startup budget.
const CHECK_TIMEOUT_MS = 8000;

/**
 * Check for updates during the splash. Non-blocking, best-effort, never throws,
 * and never gates startup. Reports progress via onState({ phase, ... }) where
 * phase is one of: checking | up-to-date | available | downloading | ready |
 * unavailable. In Phase A it settles on "available" and does NOT download.
 * `logger` is optional (electron-updater defaults to console).
 */
function checkForUpdates(onState, logger) {
  autoUpdater.autoDownload = UPDATER_CAN_AUTO_INSTALL;
  autoUpdater.autoInstallOnAppQuit = UPDATER_CAN_AUTO_INSTALL;
  autoUpdater.allowDowngrade = false; // never treat an older release as an update
  if (logger) autoUpdater.logger = logger;

  const emit = (s) => {
    try {
      onState(s);
    } catch {
      /* update UI must never break startup */
    }
  };

  let settled = false;
  const timer = setTimeout(() => finish({ phase: "unavailable" }), CHECK_TIMEOUT_MS);
  function finish(s) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    emit(s);
  }

  autoUpdater.once("update-not-available", () => finish({ phase: "up-to-date" }));
  // Offline, rate-limited, or no published (non-draft) release yet → benign.
  autoUpdater.once("error", () => finish({ phase: "unavailable" }));
  autoUpdater.once("update-available", (info) => {
    const version = info && info.version;
    if (!UPDATER_CAN_AUTO_INSTALL) {
      finish({ phase: "available", version }); // notify only
    } else {
      // Phase B: a background download begins; the metadata timeout no longer
      // applies (download is deliberately unbounded but off the critical path).
      clearTimeout(timer);
      emit({ phase: "downloading", percent: 0 });
    }
  });
  if (UPDATER_CAN_AUTO_INSTALL) {
    autoUpdater.on("download-progress", (p) => emit({ phase: "downloading", percent: p && p.percent }));
    autoUpdater.once("update-downloaded", (info) => {
      settled = true;
      clearTimeout(timer);
      emit({ phase: "ready", version: info && info.version });
    });
  }

  Promise.resolve()
    .then(() => autoUpdater.checkForUpdates())
    .catch(() => finish({ phase: "unavailable" }));
}

/** Phase B only: quit and install the downloaded update. No-op while notify-only. */
function quitAndInstall() {
  if (!UPDATER_CAN_AUTO_INSTALL) return;
  autoUpdater.quitAndInstall();
}

module.exports = { UPDATER_CAN_AUTO_INSTALL, RELEASE_PAGE_URL, checkForUpdates, quitAndInstall };
