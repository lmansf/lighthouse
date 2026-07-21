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
   * run. Default 2 (unset = 2, lowered from 5 for faster & calmer), clamped to
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
   * Sectioned-sidebar flyout width per window mode (openspec: field-patch-0.12.5
   * §1), clamped to [FLYOUT_WIDTH_MIN, FLYOUT_WIDTH_MAX] at write AND read. The
   * exact `explorerWidth` shape and read-modify-write idiom — its own key,
   * per-mode merge so a "window" width never clobbers a "widget" one. PARITY:
   * flyout_width / set_flyout_width in settings.rs.
   */
  flyoutWidth?: { window?: number; widget?: number };
  /**
   * Which sidebar section's flyout is open (openspec: field-patch-0.12.5 §1) —
   * the section id (e.g. "insights"), or absent when the flyout is closed. One
   * open at a time. Persisted so a relaunch reopens the same drawer. Written by
   * its own narrow setter (`setOpenFlyout`), never the positional writer.
   * PARITY: open_flyout / set_open_flyout in settings.rs.
   */
  openFlyout?: string;
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

/**
 * Sectioned-sidebar flyout width bounds (openspec: field-patch-0.12.5 §1).
 * PARITY: FLYOUT_WIDTH_MIN/MAX in settings.rs; mirrored client-side as
 * LAYOUT.flyoutMinWidth/flyoutMaxWidth (src/shell/theme.ts) and FLYOUT_MIN/MAX
 * (src/stores/sidebarFlyoutReducer.ts) — keep the four in sync.
 */
export const FLYOUT_WIDTH_MIN = 280;
export const FLYOUT_WIDTH_MAX = 680;

const clampFlyoutWidth = (w: number): number =>
  Math.min(FLYOUT_WIDTH_MAX, Math.max(FLYOUT_WIDTH_MIN, w));

/** The persisted flyout width for `mode`, clamped to the bounds, or null when
 * unset/unparseable. The exact `explorerWidth` reader. PARITY:
 * DesktopSettings::flyout_width in settings.rs. */
export function flyoutWidth(s: DesktopSettings, mode: "window" | "widget"): number | null {
  const w = s.flyoutWidth?.[mode];
  return typeof w === "number" && Number.isFinite(w) ? clampFlyoutWidth(w) : null;
}

/** Persist the flyout width for one window mode without disturbing the sibling
 * mode — the `setExplorerWidth` read-modify-write, clamped at write. An unknown
 * mode or a non-finite width leaves the file untouched. PARITY:
 * set_flyout_width in settings.rs. */
export function setFlyoutWidth(mode: "window" | "widget", width: number): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  const next = readDesktopSettings();
  if ((mode === "window" || mode === "widget") && Number.isFinite(width)) {
    next.flyoutWidth = { ...(next.flyoutWidth ?? {}), [mode]: clampFlyoutWidth(width) };
    try {
      writeJson(f, next);
    } catch {
      // best-effort, like writeDesktopSettings
    }
  }
  return next;
}

/** The persisted open-section id, or null when the flyout is closed/unset.
 * PARITY: DesktopSettings::open_flyout in settings.rs. */
export function openFlyout(s: DesktopSettings): string | null {
  const v = s.openFlyout;
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Persist which section's flyout is open (openspec §1) without disturbing any
 * other key — the narrow read-modify-write beside the positional writer. A
 * non-empty id sets it; an empty/blank id (or a non-string) CLEARS it (the
 * flyout is closed), removing the key entirely so the file stays tidy. The
 * caller (client) validates the id against the section registry before it ever
 * reaches here. PARITY: set_open_flyout in settings.rs. */
export function setOpenFlyout(id: unknown): DesktopSettings {
  const f = settingsFile();
  if (!f) return {};
  const next = readDesktopSettings();
  const clean = typeof id === "string" ? id.trim() : "";
  if (clean.length > 0) next.openFlyout = clean;
  else delete next.openFlyout;
  try {
    writeJson(f, next);
  } catch {
    // best-effort, like writeDesktopSettings
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
