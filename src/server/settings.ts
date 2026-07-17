/**
 * Desktop app settings shared between the desktop shell and the Next server.
 * The shell owns the file (it lives under the app-data dir, holds the vault
 * location, etc.) and passes its path to the server via the
 * LIGHTHOUSE_SETTINGS_FILE env var. The server reads/merges it so the in-app UI
 * can change desktop-only preferences (e.g. launch-at-login), which the shell
 * then reads on its next launch.
 *
 * On the plain web build there is no settings file, so every read returns empty
 * and writes are no-ops.
 */
import fs from "node:fs";
import { writeJson } from "./config";
import { normalizeAppearance, type AppearancePatch } from "../lib/appearanceSpec";

export interface DesktopSettings {
  /** The local vault directory (owned by the desktop shell). */
  vaultDir?: string;
  /** Launch Lighthouse when the user signs in to their computer. Default true. */
  runOnStartup?: boolean;
  /** Whether the one-time "run on startup?" prompt has been answered. */
  startupAsked?: boolean;
  /**
   * How the app presents itself at launch: "window" (classic, the default) or
   * "widget" (experimental — the floating search bar IS the app; the main
   * window stays in the tray). Unset = the first-run chooser hasn't been
   * answered yet.
   */
  uiMode?: "window" | "widget";
  /**
   * W3 "Whisper mode": summon the search bar by tapping Ctrl+Super+Shift with
   * no other key. Opt-in (it installs an OS keyboard hook where supported);
   * default off.
   */
  whisperMode?: boolean;
  /** The keyed summon shortcut (global-hotkey syntax); unset = the default. */
  summonShortcut?: string;
  /**
   * B2 hybrid search: embed indexed chunks with the bundled on-device model
   * and fuse vector similarity into retrieval. Default ON (unset = on). The
   * TS engine never embeds (desktop-only feature) — it just round-trips the
   * preference for the UI.
   */
  semanticSearch?: boolean;
  /**
   * Keep a local, tamper-evident audit log of answered questions (openspec:
   * add-audit-log). Default OFF (unset = off). The managed policy key
   * `auditLog: "on"` forces it on regardless. PARITY: audit_enabled in
   * settings.rs.
   */
  auditEnabled?: boolean;
  /**
   * Store the verbatim question text in each audit record (default OFF — only
   * the sha256 is kept). Opt-in because it turns the log into a record of what
   * was asked, not just that something was asked. PARITY: read from `extra` in
   * the Rust engine.
   */
  auditVerbatim?: boolean;
  /**
   * G2 draft-then-verify: while the local model composes a grounded answer,
   * stream an instant extractive draft from retrieval snippets, replaced in
   * place by the verified answer. Default ON (unset = on). PARITY: draft_answers
   * in settings.rs.
   */
  draftAnswers?: boolean;
  /**
   * G5 briefing note: fire an OS notification when the scheduled note refreshes.
   * Default ON. PARITY: the note + scheduler are desktop-Rust-only; the TS twin
   * just round-trips this pref for the UI (like semanticSearch).
   */
  briefingNotify?: boolean;
  /** G5 briefing note: local hour (0–23) the scheduled note may refresh at. Default 9. */
  briefingNoteHour?: number;
  /**
   * Whether the once-per-install first-run orientation tour has been shown.
   * Written true the moment the tour first appears (so completing AND skipping
   * both mark it done); only a wiped app-state dir re-shows it. PARITY:
   * tour_shown in settings.rs. It lives in these install-global settings (not
   * the vault, not localStorage) so it survives vault switches — the desktop
   * shell points LIGHTHOUSE_SETTINGS_FILE at its private app-state dir; the web
   * twin has no settings file, so the flag simply doesn't persist there (the
   * tour would re-greet on a plain web reload — desktop is the shipping target).
   */
  tourShown?: boolean;
  /**
   * Provider sign-in (0.12.1 §3): how the OpenAI provider authenticates —
   * "key" (API key, the default; unset = "key") or "signin" (the OAuth device
   * flow, desktop-Rust-only and itself inert until a maintainer registers with
   * the vendor and configures it). PARITY: openai_auth_method in settings.rs;
   * the twin round-trips the preference for the UI but never runs the flow —
   * its providerAuth ops answer the fail-closed stub.
   */
  openaiAuthMethod?: "key" | "signin";
  /**
   * Beam loop (openspec: add-beam-loop §2.7): the multi-step analytics loop's
   * step budget — how many sequential verified SQL steps a keyed-remote ask may
   * run (replaces the former hardcoded 3). Default 5 (unset = 5), clamped to
   * [1, 12] by the engine. PARITY: beam_max_steps in settings.rs. The loop is
   * Rust-only analytics (like the DataFusion path itself), so the TS twin just
   * round-trips this pref for the UI — as with semanticSearch/briefingNotify —
   * and never runs the loop.
   */
  beamMaxSteps?: number;
  /**
   * Resizable explorer width per window mode (openspec: add-usability-field-patch
   * §1), clamped to [EXPLORER_WIDTH_MIN, EXPLORER_WIDTH_MAX] at write AND read. It
   * rides its own key (the widgetPos precedent) and merges per mode, so a
   * "window" width never clobbers a "widget" one. PARITY: explorer_width /
   * set_explorer_width in settings.rs.
   */
  explorerWidth?: { window?: number; widget?: number };
  /**
   * Appearance customization (openspec: add-usability-field-patch §3): the
   * curated accent, row density, font scale, and theme preset. Whitelisted and
   * validated by src/lib/appearanceSpec.ts — the SAME normalizer the ask-to-
   * adjust directive uses, so the two can never drift. PARITY: appearance /
   * set_appearance in settings.rs.
   */
  appearance?: AppearancePatch;
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
    writeJson(f, next);
  } catch {
    // Best-effort: a read-only location just means the preference isn't saved.
  }
  return next;
}

/**
 * Resizable explorer width bounds (openspec: add-usability-field-patch §1).
 * PARITY: EXPLORER_WIDTH_MIN/MAX in settings.rs.
 */
export const EXPLORER_WIDTH_MIN = 200;
export const EXPLORER_WIDTH_MAX = 720;

const clampExplorerWidth = (w: number): number =>
  Math.min(EXPLORER_WIDTH_MAX, Math.max(EXPLORER_WIDTH_MIN, w));

/** The persisted explorer width for `mode`, clamped to the bounds, or null when
 * unset/unparseable. PARITY: DesktopSettings::explorer_width in settings.rs. */
export function explorerWidth(s: DesktopSettings, mode: "window" | "widget"): number | null {
  const w = s.explorerWidth?.[mode];
  return typeof w === "number" && Number.isFinite(w) ? clampExplorerWidth(w) : null;
}

/** Persist the explorer width for one window mode WITHOUT disturbing the sibling
 * mode — a narrow read-modify-write (the set_openai_auth_method precedent),
 * clamped at write. An unknown mode or a non-finite width leaves the file
 * untouched. PARITY: set_explorer_width in settings.rs. */
export function setExplorerWidth(mode: "window" | "widget", width: number): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  const next = readDesktopSettings();
  if ((mode === "window" || mode === "widget") && Number.isFinite(width)) {
    next.explorerWidth = { ...(next.explorerWidth ?? {}), [mode]: clampExplorerWidth(width) };
    try {
      writeJson(f, next);
    } catch {
      // best-effort, like writeDesktopSettings
    }
  }
  return next;
}

/** The persisted, validated appearance patch (openspec §3): unknown keys and
 *  out-of-vocabulary values are dropped by the normalizer. PARITY:
 *  DesktopSettings::appearance in settings.rs. */
export function appearance(s: DesktopSettings): AppearancePatch {
  return normalizeAppearance(s.appearance);
}

/** Merge a validated appearance patch into the settings file — the normalizer
 *  is the gate, so nothing outside the whitelist (no free-form color, no CSS)
 *  can ever be stored. Merges over the existing appearance so a single-key
 *  change (e.g. the directive setting only `accent`) preserves the rest.
 *  Best-effort write. PARITY: set_appearance in settings.rs. */
export function setAppearance(patch: unknown): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  const next = readDesktopSettings();
  next.appearance = { ...normalizeAppearance(next.appearance), ...normalizeAppearance(patch) };
  try {
    writeJson(f, next);
  } catch {
    // best-effort, like writeDesktopSettings
  }
  return next;
}
