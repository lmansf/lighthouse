/**
 * Upload endpoint: stream multipart files into the CONVERSATION WORKSPACE
 * (openspec: refocus-chat-attachments §2.1). An upload that names no
 * conversation is refused — since 0.15.0 there is nowhere else to put a file.
 *
 * PARITY: upload_post in routes.rs.
 */
import { NextResponse } from "next/server";
import * as workspace from "@/server/workspace";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB per request (aggregate cap)

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  // `dir` named a vault sub-folder; there is no tree to place a file in any
  // more, so the field is read and ignored rather than rejected (an older
  // client still uploads cleanly).
  form.get("dir");
  // The conversation these files are being attached to — REQUIRED since
  // 0.15.0; an upload naming none has nowhere to go.
  const convRaw = form.get("conversationId");
  const conversationId =
    typeof convRaw === "string" && convRaw.trim() !== "" ? convRaw.trim() : null;

  // A `paths` entry per file used to recreate a dropped folder's structure in
  // the vault. Read and ignored for the same reason as `dir`.
  form.getAll("paths");
  const items = form.getAll("files").filter((f): f is File => typeof f !== "string");

  const added: { newId: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let accepted = 0;
  let totalBytes = 0;
  for (const file of items) {
    if (accepted >= MAX_FILES) {
      skipped.push({ name: file.name, reason: `exceeds max of ${MAX_FILES} files` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ name: file.name, reason: `exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
      continue;
    }
    // Bound total bytes read into memory per request, so a batch of many
    // under-limit files can't be used to exhaust memory.
    if (totalBytes + file.size > MAX_TOTAL_BYTES) {
      skipped.push({ name: file.name, reason: `request exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)}MB total` });
      continue;
    }
    // Attaching to a conversation puts the bytes in its workspace — the engine
    // enforces the 10-file cap there, and ingestion starts at once so the first
    // ask finds every cache warm.
    if (!conversationId) {
      skipped.push({ name: file.name, reason: "no conversation to attach to" });
      continue;
    }
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      const att = workspace.attach(conversationId, file.name, bytes);
      void workspace.ingest(att);
      added.push({ newId: att.id });
      accepted++;
      totalBytes += file.size;
    } catch (err) {
      skipped.push({ name: file.name, reason: err instanceof Error ? err.message : "upload failed" });
    }
  }
  return NextResponse.json({ added, skipped });
}
