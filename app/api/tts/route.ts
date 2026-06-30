/**
 * Local neural text-to-speech: turn answer text into spoken audio on-device.
 *
 * The client posts already-cleaned text; we synthesize it with the bundled Piper
 * voice (src/server/tts) and return a WAV the renderer plays. Nothing leaves the
 * machine. When no local voice is bundled we answer 501 so the client falls back
 * to the browser's Web Speech voices. Same-origin guarded like the other routes.
 */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import { isLocalTtsAvailable, synthesize } from "@/server/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cap synthesized text so a runaway request can't tie up Piper for minutes. */
const MAX_CHARS = 8000;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  if (!isLocalTtsAvailable()) {
    // Not an error - the caller treats this as "use the browser voice instead".
    return NextResponse.json({ error: "local TTS unavailable" }, { status: 501 });
  }
  const body = await req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_CHARS) : "";
  if (!text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  try {
    const wav = await synthesize(text);
    return new NextResponse(new Uint8Array(wav), {
      status: 200,
      headers: { "content-type": "audio/wav", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "synthesis failed" }, { status: 500 });
  }
}
