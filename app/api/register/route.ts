/** Welcome-registration endpoint: mint a trial with the contact info (if any). */
import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/server/registration";
import { startTrial } from "@/server/license";
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
  try {
    const { trialEnd } = await startTrial({
      firstName: String(b.firstName ?? "").trim(),
      lastName: String(b.lastName ?? "").trim(),
      email: String(b.email).trim(),
      doNotContact: Boolean(b.doNotContact),
      city: String(b.city ?? "").trim(),
      state: String(b.state ?? "").trim(),
    });
    return NextResponse.json({ ok: true, trialEnd }, { status: 200 });
  } catch (err) {
    // The license service rejected the mint or was unreachable. Onboarding still
    // proceeds; the next launch check shows "Start your trial" with a retry.
    return NextResponse.json(
      { ok: false, reason: "rejected", detail: err instanceof Error ? err.message : "registration failed" },
      { status: 200 },
    );
  }
}
