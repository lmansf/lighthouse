/** Diagnostics for the "Send feedback" dialog: app version, OS, and (desktop
 *  only) a shell.log excerpt. The web build has no shell.log, so `log` is "".
 *  Read-only — the app transmits nothing; the dialog composes a mailto:/GitHub
 *  issue the user sends themselves. */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    version: process.env.npm_package_version ?? process.env.NEXT_PUBLIC_APP_VERSION ?? "",
    os: process.platform,
    log: "",
  });
}
