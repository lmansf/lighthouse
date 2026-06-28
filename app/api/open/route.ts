/**
 * Open a vault file in its native application (desktop only).
 *
 * The client sends a node id (never a raw path); the server resolves it to a
 * real path — refusing anything that escapes the vault — and hands it to the
 * OS opener. Gated to the desktop build, since the Next server then runs on the
 * user's own machine; a plain web deployment can't (and mustn't) open local
 * files. Same-origin guarded like the other mutating routes.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { resolveNodePath } from "@/server/vault";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Launch the platform's default opener for an absolute path, detached. */
function openWithOS(absPath: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === "win32"
      ? ["explorer.exe", [absPath]]
      : platform === "darwin"
        ? ["open", [absPath]]
        : ["xdg-open", [absPath]]; // linux / wsl
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // never let a missing opener crash the request
  child.unref();
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  if (!isDesktopApp()) {
    return NextResponse.json(
      { error: "opening files is available only in the desktop app" },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  if (typeof body.nodeId !== "string" || !body.nodeId.trim()) {
    return NextResponse.json({ error: "nodeId required" }, { status: 400 });
  }
  try {
    const absPath = resolveNodePath(body.nodeId);
    const stat = fs.statSync(absPath, { throwIfNoEntry: false });
    if (!stat) {
      return NextResponse.json({ error: "file no longer exists" }, { status: 404 });
    }
    if (!stat.isFile()) {
      return NextResponse.json({ error: "not a file" }, { status: 400 });
    }
    openWithOS(absPath);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not open file" },
      { status: 400 },
    );
  }
}
