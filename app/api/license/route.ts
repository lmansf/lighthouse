/** Trial-license endpoint: check the license once per launch, or start a trial. */
import { NextResponse } from "next/server";
import { checkLicense, startTrial } from "@/server/license";
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
        const { trialEnd } = await startTrial();
        return NextResponse.json({ ok: true, trialEnd });
      } catch (err) {
        return NextResponse.json(
          { ok: false, reason: "rejected", detail: err instanceof Error ? err.message : "start failed" },
          { status: 200 },
        );
      }
    }

    default:
      return NextResponse.json({ error: "unknown op" }, { status: 400 });
  }
}
