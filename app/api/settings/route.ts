/** Desktop settings endpoint: read/update launch-at-login (and the one-time
 *  prompt flag). No-ops on the web build, where there is no settings file. */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp } from "@/server/config";
import {
  readDesktopSettings,
  writeDesktopSettings,
  setExplorerWidth,
  explorerWidth,
  setFlyoutWidth,
  flyoutWidth,
  setOpenFlyout,
  openFlyout,
  setAppearance,
  appearance,
} from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = readDesktopSettings();
  return NextResponse.json({
    desktop: isDesktopApp(),
    // PARITY: mirrors settings_get (commands.rs) §1 — the twin is always the
    // web dev flow on a computer, so the form factor is constant "desktop".
    platform: "desktop",
    runOnStartup: s.runOnStartup !== false, // default on
    startupAsked: Boolean(s.startupAsked),
    uiMode: s.uiMode ?? null, // null until the first-run chooser is answered
    whisperMode: s.whisperMode === true, // opt-in, default off
    summonShortcut: s.summonShortcut ?? "ctrl+super+shift+space",
    semanticSearch: s.semanticSearch !== false, // default on
    briefingNotify: s.briefingNotify !== false, // default on (G5)
    briefingNoteHour: s.briefingNoteHour ?? 9, // default 9am (G5)
    tourShown: s.tourShown === true, // first-run tour, once per install
    explorerWidth: { window: explorerWidth(s, "window"), widget: explorerWidth(s, "widget") },
    // Sectioned-sidebar flyout (openspec: field-patch-0.12.5 §1): per-mode width
    // + the open-section id, the explorerWidth precedent.
    flyoutWidth: { window: flyoutWidth(s, "window"), widget: flyoutWidth(s, "widget") },
    openFlyout: openFlyout(s),
    appearance: appearance(s),
  });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  if (!isDesktopApp()) {
    return NextResponse.json({ ok: false, reason: "settings apply to the desktop app only" }, { status: 400 });
  }
  const body = await req.json().catch(() => ({}));
  const patch: {
    runOnStartup?: boolean;
    startupAsked?: boolean;
    uiMode?: "window" | "widget";
    whisperMode?: boolean;
    summonShortcut?: string;
    semanticSearch?: boolean;
    briefingNotify?: boolean;
    briefingNoteHour?: number;
    tourShown?: boolean;
  } = {};
  if (typeof body.runOnStartup === "boolean") patch.runOnStartup = body.runOnStartup;
  if (typeof body.startupAsked === "boolean") patch.startupAsked = body.startupAsked;
  if (body.uiMode === "window" || body.uiMode === "widget") patch.uiMode = body.uiMode;
  if (typeof body.whisperMode === "boolean") patch.whisperMode = body.whisperMode;
  if (typeof body.summonShortcut === "string") patch.summonShortcut = body.summonShortcut;
  if (typeof body.semanticSearch === "boolean") patch.semanticSearch = body.semanticSearch;
  if (typeof body.briefingNotify === "boolean") patch.briefingNotify = body.briefingNotify;
  if (typeof body.briefingNoteHour === "number" && body.briefingNoteHour >= 0 && body.briefingNoteHour <= 23)
    patch.briefingNoteHour = body.briefingNoteHour;
  if (typeof body.tourShown === "boolean") patch.tourShown = body.tourShown;
  // Resizable explorer width (openspec: add-usability-field-patch §1) — a per-
  // window-mode value that MERGES, so it rides its own read-modify-write setter
  // (setExplorerWidth), not the patch spread which would drop the sibling mode.
  // Runs before writeDesktopSettings so the returned `s` reflects it.
  const ew = body.explorerWidth;
  if (ew && (ew.mode === "window" || ew.mode === "widget") && typeof ew.width === "number") {
    setExplorerWidth(ew.mode, ew.width);
  }
  // Sectioned-sidebar flyout width (openspec: field-patch-0.12.5 §1) — the same
  // per-mode read-modify-write as explorerWidth, outside the patch spread so it
  // never drops the sibling mode.
  const fw = body.flyoutWidth;
  if (fw && (fw.mode === "window" || fw.mode === "widget") && typeof fw.width === "number") {
    setFlyoutWidth(fw.mode, fw.width);
  }
  // The open-section id (openspec §1): a string sets it; "" clears it (flyout
  // closed). Its own narrow setter, like the auth-method choice.
  if (typeof body.openFlyout === "string") {
    setOpenFlyout(body.openFlyout);
  }
  // Appearance customization (openspec §3): the normalizer drops anything
  // outside the whitelist, so nothing but bounded enum values can persist.
  // Runs before writeDesktopSettings so the returned `s` reflects it.
  if (body.appearance && typeof body.appearance === "object") {
    setAppearance(body.appearance);
  }
  const s = writeDesktopSettings(patch);
  return NextResponse.json({
    ok: true,
    runOnStartup: s.runOnStartup !== false,
    startupAsked: Boolean(s.startupAsked),
    uiMode: s.uiMode ?? null,
    whisperMode: s.whisperMode === true,
    summonShortcut: s.summonShortcut ?? "ctrl+super+shift+space",
    semanticSearch: s.semanticSearch !== false,
    briefingNotify: s.briefingNotify !== false,
    briefingNoteHour: s.briefingNoteHour ?? 9,
    tourShown: s.tourShown === true,
    explorerWidth: { window: explorerWidth(s, "window"), widget: explorerWidth(s, "widget") },
    flyoutWidth: { window: flyoutWidth(s, "window"), widget: flyoutWidth(s, "widget") },
    openFlyout: openFlyout(s),
  });
}
