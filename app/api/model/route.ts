/**
 * Status + on-demand install of the optional private local model.
 *
 * GET    → current state: { status: ready|absent|downloading|uninstalling|error, received, total }
 * POST   → start the one-time download (no-op if already present or in flight).
 * DELETE → uninstall: drop a marker electron/main.js acts on (stop the server,
 *          delete the weights), freeing the ~4.2 GB / allowing a fresh re-test.
 *
 * The model is fetched from Hugging Face into the user's data dir (src/server/
 * localModel) - only public weights, nothing of the user's leaves the machine.
 * Same-origin guarded like the other mutating routes.
 */
import { NextResponse } from "next/server";
import { isSameOrigin } from "@/server/http";
import { modelStatus, requestUninstall, startDownload } from "@/server/localModel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(modelStatus());
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  return NextResponse.json(startDownload());
}

export async function DELETE(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  return NextResponse.json(requestUninstall());
}
