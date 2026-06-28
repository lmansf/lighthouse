/**
 * Desktop app settings shared between the Electron main process and the Next
 * server. The main process owns the file (it lives under Electron's userData
 * dir, holds the vault location, etc.) and passes its path to the server via the
 * LIGHTHOUSE_SETTINGS_FILE env var. The server reads/merges it so the in-app UI
 * can change desktop-only preferences (e.g. launch-at-login), which the main
 * process then reads on its next launch.
 *
 * On the plain web build there is no settings file, so every read returns empty
 * and writes are no-ops.
 */
import fs from "node:fs";

export interface DesktopSettings {
  /** The local vault directory (owned by the Electron main process). */
  vaultDir?: string;
  /** Launch Lighthouse when the user signs in to their computer. Default true. */
  runOnStartup?: boolean;
  /** Whether the one-time "run on startup?" prompt has been answered. */
  startupAsked?: boolean;
}

function settingsFile(): string | null {
  return process.env.LIGHTHOUSE_SETTINGS_FILE || null;
}

export function readDesktopSettings(): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as DesktopSettings;
  } catch {
    return {}; // missing or corrupt — treat as defaults
  }
}

/** Merge `patch` into the on-disk settings, preserving keys the main process owns. */
export function writeDesktopSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  const next = { ...readDesktopSettings(), ...patch };
  try {
    fs.writeFileSync(f, JSON.stringify(next, null, 2));
  } catch {
    // Best-effort: a read-only location just means the preference isn't saved.
  }
  return next;
}
