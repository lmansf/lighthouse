/** License endpoint: check once per launch, start a new trial, or activate a key. */
import { NextResponse } from "next/server";
import { checkLicense, startTrial, activateLicense } from "@/server/license";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  switch (body.op) {
    case "check":
      return NextResponse.json(await checkLicense());

    case "start": {
      // One-click new trial — reuses the saved contact identity, if any.
      try {
        await startTrial();
        return NextResponse.json({ ok: true });
      } catch (err) {
        return NextResponse.json(
          { ok: false, reason: "rejected", detail: err instanceof Error ? err.message : "start failed" },
          { status: 200 },
        );
      }
    }

    case "activate": {
      // Paste a purchased license key. Validated server-side; never destructive.
      const key = typeof body.licenseKey === "string" ? body.licenseKey : "";
      const result = await activateLicense(key);
      const ok = result.status === "valid" || result.status === "grace";
      return NextResponse.json({ ok, ...result });
    }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
