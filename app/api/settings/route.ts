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
  const patch: { runOnStartup?: boolean; startupAsked?: boolean } = {};
  if (typeof body.runOnStartup === "boolean") patch.runOnStartup = body.runOnStartup;
  if (typeof body.startupAsked === "boolean") patch.startupAsked = body.startupAsked;
  const s = writeDesktopSettings(patch);
  return NextResponse.json({
    ok: true,
    runOnStartup: s.runOnStartup !== false,
    startupAsked: Boolean(s.startupAsked),
  });
}
