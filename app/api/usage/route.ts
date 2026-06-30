/** Usage click-logging endpoint: read consent, persist consent, buffer captured
 *  events locally, and publish-on-launch. All best-effort — never blocks. */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import { isUsageOptedOut, setUsageOptOut, appendUsageEvents } from "@/server/usage";
import { publishUsageEvents } from "@/server/license";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whether the capture hook should run (consent state). */
export async function GET() {
  return NextResponse.json({ optOut: isUsageOptedOut() });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "consent": {
      // Set at registration; reset to opted-in whenever a trial is minted.
      setUsageOptOut(Boolean(body.optOut));
      return NextResponse.json({ ok: true, optOut: Boolean(body.optOut) });
    }

    case "events": {
      // Append a flushed batch from the renderer (no-op when opted out).
      const events = Array.isArray(body.events) ? body.events : [];
      appendUsageEvents(events);
      return NextResponse.json({ ok: true });
    }

    case "publish": {
      // Publish-on-launch + purge (after the launch ping).
      await publishUsageEvents();
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
