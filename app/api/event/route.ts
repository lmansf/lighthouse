/**
 * Record a telemetry/funnel event (best-effort).
 *
 * The client posts an event name (and optional props); the server stamps it with
 * the stable contact id and the user's experiment variants and forwards it to the
 * hosted license Edge Function (`event` op). Mirrors app/api/open: same-origin
 * guarded, runs on the Node runtime. Telemetry must never break the caller, so a
 * bad body or an unreachable function still returns ok and is swallowed upstream.
 */
import { NextResponse } from "next/server";
import { recordEvent } from "@/server/license";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const props =
    body?.props && typeof body.props === "object" && !Array.isArray(body.props)
      ? (body.props as Record<string, unknown>)
      : {};
  // Fire-and-forget on the server side too; recordEvent swallows its own errors.
  void recordEvent(name, props);
  return NextResponse.json({ ok: true });
}
