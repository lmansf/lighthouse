/** Welcome-registration endpoint: forward the form to Supabase (if configured). */
import { NextResponse } from "next/server";
import { submitRegistration, isSupabaseConfigured } from "@/server/registration";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ configured: isSupabaseConfigured() });
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const b = await req.json().catch(() => null);
  if (!b || typeof b.email !== "string" || !b.email.trim()) {
    return NextResponse.json({ ok: false, reason: "rejected", detail: "email required" }, { status: 400 });
  }
  const result = await submitRegistration({
    firstName: String(b.firstName ?? "").trim(),
    lastName: String(b.lastName ?? "").trim(),
    email: String(b.email).trim(),
    doNotContact: Boolean(b.doNotContact),
    city: String(b.city ?? "").trim(),
    state: String(b.state ?? "").trim(),
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}
