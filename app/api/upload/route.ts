/** Upload endpoint: stream multipart files into the vault (excluded by default). */
import { NextResponse } from "next/server";
import { addFile } from "@/server/vault";
import { isSameOrigin } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 50;

export async function POST(req: Request) {
  if (!isSameOrigin(req)) {
    return NextResponse.json({ error: "cross-origin request rejected" }, { status: 403 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const destRaw = form.get("dir");
  const dest = typeof destRaw === "string" && destRaw ? destRaw : null;

  const added: { newId: string }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let accepted = 0;
  for (const entry of form.getAll("files")) {
    if (typeof entry === "string") continue;
    const file = entry as File;
    if (accepted >= MAX_FILES) {
      skipped.push({ name: file.name, reason: `exceeds max of ${MAX_FILES} files` });
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      skipped.push({ name: file.name, reason: `exceeds ${MAX_FILE_BYTES / (1024 * 1024)}MB limit` });
      continue;
    }
    try {
      const bytes = Buffer.from(await file.arrayBuffer());
      added.push(addFile(file.name, bytes, dest));
      accepted++;
    } catch (err) {
      skipped.push({ name: file.name, reason: err instanceof Error ? err.message : "upload failed" });
    }
  }
  return NextResponse.json({ added, skipped });
}
