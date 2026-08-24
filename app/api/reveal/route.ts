/**
 * Reveal one of a conversation's ATTACHMENTS in the OS file manager, selecting
 * it inside its folder (desktop only). Before 0.15.0 a blank id also revealed
 * the vault directory itself; there is no such directory now, so a blank id is
 * simply nothing to reveal.
 *
 * Mirrors /api/open: the client sends an attachment id (never a raw path); the
 * server resolves it through the conversation's manifest and hands the blob to
 * the platform's reveal command. Desktop-gated (a web deployment has no access
 * to the user's local files) and same-origin guarded.
 * PARITY: reveal_node in the desktop crate.
 */
import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { resolve as resolveAttachment } from "@/server/workspace";
import { isSameOrigin } from "@/server/http";
import { isDesktopApp } from "@/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reveal an absolute path, selecting it in its folder where the platform can
 * (Windows/macOS). Linux has no portable "select" verb, so open the containing
 * directory. Detached and error-swallowed like the opener.
 */
function revealWithOS(absPath: string): void {
  const platform = process.platform;
  const isDir = fs.statSync(absPath, { throwIfNoEntry: false })?.isDirectory() ?? false;
  const [cmd, args] =
    platform === "win32"
      ? ["explorer.exe", [`/select,${absPath}`]]
      : platform === "darwin"
        ? ["open", ["-R", absPath]]
        : ["xdg-open", [isDir ? absPath : path.dirname(absPath)]]; // linux / wsl
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {}); // never let a missing file manager crash the request
  child.unref();
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  if (!isDesktopApp()) {
    return NextResponse.json(
      { error: "revealing files is available only in the desktop app" },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const nodeId = typeof body.nodeId === "string" ? body.nodeId.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  try {
    if (!nodeId) {
      return NextResponse.json({ error: "nothing to reveal" }, { status: 400 });
    }
    const hit = resolveAttachment(conversationId, nodeId);
    if (!hit || !fs.statSync(hit.path, { throwIfNoEntry: false })) {
      return NextResponse.json({ error: "file no longer exists" }, { status: 404 });
    }
    revealWithOS(hit.path);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "could not reveal file" },
      { status: 400 },
    );
  }
}
