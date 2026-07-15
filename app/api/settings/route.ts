/** Desktop settings endpoint: read/update launch-at-login (and the one-time
 *  prompt flag). No-ops on the web build, where there is no settings file. */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp } from "@/server/config";
import { readDesktopSettings, writeDesktopSettings } from "@/server/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = readDesktopSettings();
  return NextResponse.json({
    desktop: isDesktopApp(),
    runOnStartup: s.runOnStartup !== false, // default on
    startupAsked: Boolean(s.startupAsked),
    uiMode: s.uiMode ?? null, // null until the first-run chooser is answered
    whisperMode: s.whisperMode === true, // opt-in, default off
    summonShortcut: s.summonShortcut ?? "ctrl+super+shift+space",
    semanticSearch: s.semanticSearch !== false, // default on
    briefingNotify: s.briefingNotify !== false, // default on (G5)
    briefingNoteHour: s.briefingNoteHour ?? 9, // default 9am (G5)
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
  });
}
